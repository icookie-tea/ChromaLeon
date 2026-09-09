/*
 * extension.js
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 *
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import St from "gi://St";
import Gio from "gi://Gio";
import GLib from "gi://GLib";
import { Extension } from "resource:///org/gnome/shell/extensions/extension.js";
import * as ColorUtils from "./utils/colorUtils.js";
import * as FileUtils from "./utils/fileUtils.js";
import * as ThemeUtils from "./utils/themeUtils.js";
import { clearRecolorTimeout } from "./utils/recolorUtils.js";
import { throwIfCancelled, isCancelledError } from "./utils/cancellation.js";

export default class ChromaLeon extends Extension {
  constructor(metadata) {
    super(metadata);
    this._settings = null;
    this._bgSettings = null;
    this._lastLightUri = null;
    this._lastDarkUri = null;
    this._wallpaperDebounceId = null;
    this._pendingWallpaperChange = null;
    this._wallpaperFileMonitor = null;
    this._monitoredWallpaperUri = null;
    this._interfaceSettings = null;
    this._configId = null;
    this._timeoutId = null;
    this._reloadGtkTimeout = null;
    this._restoreTimeout = null;
    this._a11ySettings = null;
    this._cancellable = null;
    this._opChain = Promise.resolve();
    this._customStylesheet = null;
  }

  enable() {
    this._settings = this.getSettings();

    this._interfaceSettings = new Gio.Settings({
      schema_id: "org.gnome.desktop.interface",
    });

    this._bgSettings = new Gio.Settings({
      schema_id: "org.gnome.desktop.background",
    });

    this._a11ySettings = new Gio.Settings({
      schema_id: "org.gnome.desktop.a11y.interface",
    });

    this._settings.connectObject(
      "changed::accent-color",
      () =>
        this._runOperation(async (cancellable) => {
          await this._updateStyles(
            this._settings.get_boolean("recolor-folders"),
            true,
            cancellable,
          );
        }),
      "changed::gnome-colors",
      () =>
        this._runOperation(async (cancellable) => {
          this._settings.set_boolean("custom-color", false);
          await this._updateShellStyles(cancellable);
          throwIfCancelled(cancellable);
          await this._updateAppStyles(cancellable);
          throwIfCancelled(cancellable);
          await this._reloadGtkStylesheet(cancellable);
          throwIfCancelled(cancellable);
          await this._updateIconPack(cancellable);
        }),
      "changed::tint-shell",
      () =>
        this._runOperation(async (cancellable) => {
          await this._updateShellStyles(cancellable);
        }),
      "changed::tint-panel",
      () =>
        this._runOperation(async (cancellable) => {
          await this._updateShellStyles(cancellable);
        }),
      "changed::custom-css",
      () =>
        this._runOperation(async (cancellable) => {
          await this._updateShellStyles(cancellable);
        }),
      "changed::tint-apps",
      () =>
        this._runOperation(async (cancellable) => {
          await this._updateAppStyles(cancellable);
          await this._reloadGtkStylesheet(cancellable);
        }),
      "changed::tint-gtk3",
      () =>
        this._runOperation(async (cancellable) => {
          await this._updateAppStyles(cancellable);
        }),
      "changed::tinting-strength",
      () =>
        this._runOperation(async (cancellable) => {
          await this._updateShellStyles(cancellable);
          await this._updateAppStyles(cancellable);
          await this._reloadGtkStylesheet(cancellable);
        }),
      "changed::darker",
      () =>
        this._runOperation(async (cancellable) => {
          await this._updateShellStyles(cancellable);
          await this._updateAppStyles(cancellable);
          await this._reloadGtkStylesheet(cancellable);
        }),
      "changed::recolor-folders",
      () =>
        this._runOperation(async (cancellable) => {
          await this._updateIconPack(cancellable);
        }),
      "changed::recolor-apps",
      () =>
        this._runOperation(async (cancellable) => {
          await this._updateIconPack(cancellable);
        }),
      "changed::morewaita",
      () =>
        this._runOperation(async (cancellable) => {
          await this._updateIconPack(cancellable);
        }),
      "changed::prefer-light",
      () =>
        this._runOperation((cancellable) => {
          this._updateShellStyles(cancellable);
        }),
      "changed::full-light",
      () =>
        this._runOperation((cancellable) => {
          this._updateShellStyles(cancellable);
        }),
      this,
    );

    this._interfaceSettings.connectObject(
      "changed::color-scheme",
      () =>
        this._runOperation(async (cancellable) => {
          const colorScheme =
            this._interfaceSettings.get_string("color-scheme");

          if (this._settings.get_boolean("prefer-light"))
            this._loadShellStylesheet(cancellable);
          await this._updateAppStyles(cancellable);

          if (!this._settings.get_boolean("custom-color")) {
            let uri =
              colorScheme === "prefer-dark"
                ? this._bgSettings.get_string("picture-uri-dark")
                : this._bgSettings.get_string("picture-uri");

            let newColor = await ColorUtils.calculateVibrantColor(uri);
            const currentColor = this._settings.get_string("accent-color");

            if (newColor !== currentColor) {
              await this._autoApplyWallpaperColor(newColor, cancellable);
            }
          }

          this._setupWallpaperFileMonitor();
        }),
      "changed::accent-color",
      () => {
        if (this._settings.get_boolean("gnome-colors")) {
          this._settings.set_string(
            "accent-color",
            this._interfaceSettings.get_string("accent-color"),
          );
        }
      },
      this,
    );

    const handleWallpaperChange = () => {
      const lightUri = this._bgSettings.get_string("picture-uri");
      const darkUri = this._bgSettings.get_string("picture-uri-dark");

      const lightChanged = this._lastLightUri !== lightUri;
      const darkChanged = this._lastDarkUri !== darkUri;

      this._lastLightUri = lightUri;
      this._lastDarkUri = darkUri;

      // External apps (GNOME Settings, file managers, wallpaper tools)
      // usually only update one of the two keys. Deduplicating on the
      // effective key alone would swallow changes made to the other one.
      if (!lightChanged && !darkChanged) return;

      // Some apps set both keys back-to-back; debounce so the change is
      // evaluated (and the right key chosen) only once.
      this._pendingWallpaperChange = {
        light: this._pendingWallpaperChange?.light || lightChanged,
        dark: this._pendingWallpaperChange?.dark || darkChanged,
      };

      if (this._wallpaperDebounceId)
        GLib.Source.remove(this._wallpaperDebounceId);

      this._wallpaperDebounceId = GLib.timeout_add(
        GLib.PRIORITY_DEFAULT,
        100,
        () => {
          this._wallpaperDebounceId = null;
          const { light: lightWasChanged, dark: darkWasChanged } =
            this._pendingWallpaperChange ?? {};
          this._pendingWallpaperChange = null;

          if (!lightWasChanged && !darkWasChanged) return GLib.SOURCE_REMOVE;

          console.log(
            `[ChromaLeon] wallpaper change detected: lightChanged=${lightWasChanged} darkChanged=${darkWasChanged} light=${this._bgSettings.get_string("picture-uri")} dark=${this._bgSettings.get_string("picture-uri-dark")}`,
          );

          const isDark =
            this._interfaceSettings.get_string("color-scheme") ===
            "prefer-dark";

          // Colorize the wallpaper matching the current color scheme when
          // it changed; otherwise follow the wallpaper that was just
          // picked.
          const uri =
            isDark && darkWasChanged
              ? this._bgSettings.get_string("picture-uri-dark")
              : !isDark && lightWasChanged
                ? this._bgSettings.get_string("picture-uri")
                : isDark
                  ? this._bgSettings.get_string("picture-uri")
                  : this._bgSettings.get_string("picture-uri-dark");

          console.log(`[ChromaLeon] applying color from: ${uri}`);
          this._runOperation(async (cancellable) => {
            this._settings.set_boolean("custom-color", false);
            await this._autoApplyWallpaperColor(null, cancellable, uri);
          });
          this._setupWallpaperFileMonitor();
          return GLib.SOURCE_REMOVE;
        },
      );
    };

    // Baseline both URIs before connecting so the first change event is
    // not treated as "both keys changed".
    this._lastLightUri = this._bgSettings.get_string("picture-uri");
    this._lastDarkUri = this._bgSettings.get_string("picture-uri-dark");

    this._bgSettings.connectObject(
      "changed::picture-uri-dark",
      handleWallpaperChange,
      "changed::picture-uri",
      handleWallpaperChange,
      this,
    );

    this._setupWallpaperFileMonitor();

    this._configId = this._settings.connect("changed::create-shortcut", () => {
      this._updateDesktopFile();
    });

    if (
      this._interfaceSettings.get_string("icon-theme") === "Adwaita" &&
      this._settings.get_boolean("recolor-folders")
    ) {
      this._interfaceSettings.set_string("icon-theme", "ChromaLeon");
    }

    this._updateDesktopFile();

    this._runOperation((cancellable) => {
      this._updateStyles(false, true, cancellable);
    });
  }

  disable() {
    // Necessary to keep accent colors consistent when unlocking the session

    clearRecolorTimeout();

    this._settings?.disconnectObject(this);
    this._bgSettings?.disconnectObject(this);
    this._interfaceSettings?.disconnectObject(this);

    if (this._configId) {
      this._settings?.disconnect(this._configId);
      this._configId = null;
    }

    if (this._timeoutId) {
      GLib.Source.remove(this._timeoutId);
      this._timeoutId = null;
    }

    if (this._reloadGtkTimeout) {
      GLib.Source.remove(this._reloadGtkTimeout);
      this._reloadGtkTimeout = null;
    }

    if (this._reloadGtkTimeout) {
      GLib.Source.remove(this._reloadGtkTimeout);
      this._reloadGtkTimeout = null;
    }

    if (this._restoreTimeout) {
      GLib.Source.remove(this._restoreTimeout);
      this._restoreTimeout = null;
    }

    ThemeUtils.resetShellThemeBase();
    ThemeUtils.removeGtkStylesheet();
    FileUtils.removeDesktopFile();

    if (this._customStylesheet) {
      ThemeUtils.removeShellStylesheet(this._customStylesheet);
      this._customStylesheet = null;
    }

    if (this._interfaceSettings?.get_string("icon-theme") === "ChromaLeon") {
      this._interfaceSettings.set_string("icon-theme", "Adwaita");
    }

    this._reloadGtkStylesheet();

    this._cancellable?.cancel();
    this._cancellable = null;
    this._opChain = Promise.resolve();

    if (this._wallpaperDebounceId) {
      GLib.Source.remove(this._wallpaperDebounceId);
      this._wallpaperDebounceId = null;
    }
    this._pendingWallpaperChange = null;

    if (this._wallpaperFileMonitor) {
      this._wallpaperFileMonitor.disconnect();
      this._wallpaperFileMonitor = null;
    }
    this._monitoredWallpaperUri = null;

    this._settings = null;
    this._bgSettings = null;
    this._interfaceSettings = null;
    this._a11ySettings = null;
  }

  _runOperation(fn) {
    this._cancellable?.cancel();

    const cancellable = new Gio.Cancellable();
    this._cancellable = cancellable;

    this._opChain = this._opChain
      .catch(() => {})
      .then(async () => {
        if (cancellable.is_cancelled()) return;

        try {
          await fn(cancellable);
        } catch (e) {
          if (!isCancelledError(e)) {
            this._settings?.set_string("last-error", e.message ?? String(e));
          }
        } finally {
          if (this._cancellable === cancellable) {
            this._cancellable = null;
          }
        }
      });
  }

  _updateDesktopFile() {
    const shouldCreate = this._settings.get_boolean("create-shortcut");
    if (shouldCreate) {
      FileUtils.createDesktopFile(this.path);
    } else {
      FileUtils.removeDesktopFile();
    }
  }

  async _autoApplyWallpaperColor(color, cancellable, uri) {
    throwIfCancelled(cancellable);
    if (this._settings.get_boolean("custom-color")) {
      await this._updateShellStyles(cancellable);
      await this._updateAppStyles(cancellable);
      return;
    }

    if (!uri) {
      let colorScheme = this._interfaceSettings.get_string("color-scheme");
      uri =
        colorScheme === "prefer-dark"
          ? this._bgSettings.get_string("picture-uri-dark")
          : this._bgSettings.get_string("picture-uri");
    }

    if (!color) color = await ColorUtils.calculateVibrantColor(uri);
    console.log(`[ChromaLeon] computed color: ${color} (from ${uri})`);
    throwIfCancelled(cancellable);

    const currentColor = this._settings.get_string("accent-color");
    const colorChanged = color !== currentColor;

    if (colorChanged) {
      console.log(
        `[ChromaLeon] accent-color: ${currentColor} -> ${color}`,
      );
      this._settings.set_string("accent-color", color);
    } else {
      console.log(`[ChromaLeon] color unchanged (${color}), restyling`);
      await this._updateStyles(false, false, cancellable);
    }
  }

  async _updateIconPack(cancellable) {
    throwIfCancelled(cancellable);

    const iconFolders = this._settings.get_boolean("recolor-folders");
    const iconApps = this._settings.get_boolean("recolor-apps");
    const morewaita = this._settings.get_boolean("morewaita");
    const accent = this._settings.get_string("accent-color");
    const gnomeColors = this._settings.get_boolean("gnome-colors");

    if (this._timeoutId) {
      GLib.Source.remove(this._timeoutId);
      this._timeoutId = null;
    }

    try {
      await ThemeUtils.updateIconPack(
        accent,
        iconFolders,
        iconApps,
        morewaita,
        gnomeColors,
        cancellable,
      );
    } catch (error) {
      if (isCancelledError(error)) throw error;
      this._settings.set_string("last-error", error.message);
    }
  }

  async _updateStyles(
    updateIcons = false,
    styleChanged = false,
    cancellable = null,
  ) {
    throwIfCancelled(cancellable);

    const gnomeColors = this._settings.get_boolean("gnome-colors");

    await this._updateShellStyles(cancellable);
    throwIfCancelled(cancellable);
    await this._updateAppStyles(cancellable);

    if (!gnomeColors && styleChanged) {
      throwIfCancelled(cancellable);
      await this._reloadGtkStylesheet(cancellable);
    }

    if (updateIcons) {
      throwIfCancelled(cancellable);
      await this._updateIconPack(cancellable);
    }
  }

  async _updateShellStyles(cancellable) {
    throwIfCancelled(cancellable);

    const color = this._settings.get_string("accent-color");
    const darker = this._settings.get_boolean("darker");
    const tintShell = this._settings.get_boolean("tint-shell");
    const gnomeColors = this._settings.get_boolean("gnome-colors");
    const tintPanel = this._settings.get_boolean("tint-panel");
    const tintStrength = this._settings.get_int("tinting-strength");
    const fullLight = this._settings.get_boolean("full-light");

    await ThemeUtils.updateShellStylesheet(
      this.path,
      color,
      tintShell,
      darker,
      gnomeColors,
      tintPanel,
      tintStrength,
      fullLight,
      cancellable,
    );

    this._loadShellStylesheet(cancellable);
  }

  _loadShellStylesheet(cancellable = null) {
    throwIfCancelled(cancellable);

    const cacheDir = GLib.get_user_cache_dir();

    const lightFile = Gio.File.new_for_path(`${cacheDir}/chromaleon-shell.css`);
    const darkFile = Gio.File.new_for_path(
      `${cacheDir}/chromaleon-shell-dark.css`,
    );
    const customStylesheet = Gio.File.new_for_path(
      `${cacheDir}/chromaleon-shell-custom.css`,
    );

    const isLight = this._shouldUseLightShell();
    const activeFilePath = isLight ? lightFile.get_path() : darkFile.get_path();

    if (activeFilePath) {
      ThemeUtils.applyShellThemeBase(activeFilePath);
    }

    const themeContext = St.ThemeContext.get_for_stage(global.stage);
    const theme = themeContext?.get_theme();
    if (!theme) return;

    if (this._customStylesheet) {
      theme.unload_stylesheet(this._customStylesheet);
      this._customStylesheet = null;
    }

    const customCSS = this._settings.get_boolean("custom-css");
    if (customCSS && customStylesheet.query_exists(null)) {
      theme.load_stylesheet(customStylesheet);
      this._customStylesheet = customStylesheet;
    }
  }

  async _updateAppStyles(cancellable) {
    throwIfCancelled(cancellable);

    const color = this._settings.get_string("accent-color");
    const gtk3 = this._settings.get_boolean("tint-gtk3");
    const darker = this._settings.get_boolean("darker");
    const isDark =
      this._interfaceSettings.get_string("color-scheme") === "prefer-dark";
    const tintApps = this._settings.get_boolean("tint-apps");
    const gnomeColors = this._settings.get_boolean("gnome-colors");
    const tintStrength = this._settings.get_int("tinting-strength");

    await ThemeUtils.updateGtkStylesheet(
      this.path,
      color,
      tintApps,
      isDark,
      gtk3,
      darker,
      gnomeColors,
      tintStrength,
      cancellable,
    );
  }

  _shouldUseLightShell() {
    const preferLight = this._settings.get_boolean("prefer-light");
    const systemColorScheme =
      this._interfaceSettings.get_string("color-scheme");

    if (preferLight) {
      return systemColorScheme !== "prefer-dark";
    }
    return false;
  }

  _clearReloadTimeout(key) {
    if (this[key]) {
      GLib.Source.remove(this[key]);
      this[key] = null;
    }
  }

  // Some wallpaper tools (e.g. Damask) replace the contents of the
  // wallpaper file without touching the picture-uri settings. GNOME Shell
  // reloads the wallpaper on file changes, but our extension only listens
  // to dconf — so also watch the wallpaper file itself.
  _setupWallpaperFileMonitor() {
    if (this._wallpaperFileMonitor) {
      this._wallpaperFileMonitor.disconnect();
      this._wallpaperFileMonitor = null;
    }

    if (!this._bgSettings || !this._interfaceSettings) return;

    const isDark =
      this._interfaceSettings.get_string("color-scheme") === "prefer-dark";
    const uri = this._bgSettings.get_string(
      isDark ? "picture-uri-dark" : "picture-uri",
    );

    if (!uri || !uri.startsWith("file://")) return;
    if (this._monitoredWallpaperUri === uri) return;

    const file = Gio.File.new_for_uri(uri);
    if (!file.query_exists(null)) return;

    try {
      this._wallpaperFileMonitor = file.monitor(
        Gio.FileMonitorFlags.NONE,
        null,
      );
      this._wallpaperFileMonitor.connect("changed", () => {
        console.log(`[ChromaLeon] wallpaper file modified: ${uri}`);
        this._runOperation(async (cancellable) => {
          this._settings.set_boolean("custom-color", false);
          await this._autoApplyWallpaperColor(null, cancellable, uri);
        });
      });
      this._monitoredWallpaperUri = uri;
      console.log(`[ChromaLeon] monitoring wallpaper file: ${uri}`);
    } catch (e) {
      console.log(`[ChromaLeon] failed to monitor ${uri}: ${e.message}`);
    }
  }

  async _reloadGtkStylesheet(cancellable = null) {
    throwIfCancelled(cancellable);

    const hotReload = this._settings.get_int("hot-reload");
    if (!hotReload) return;

    this._clearReloadTimeout("_reloadGtkTimeout");

    const now = GLib.get_monotonic_time();
    if (!this._lastReloadTime || now - this._lastReloadTime > 400_000) {
      this._lastReloadTime = now;
      await this._applyGtkReload(hotReload, cancellable);
      return;
    }

    this._reloadGtkTimeout = GLib.timeout_add(
      GLib.PRIORITY_DEFAULT,
      300,
      () => {
        this._reloadGtkTimeout = null;
        this._lastReloadTime = GLib.get_monotonic_time();
        this._applyGtkReload(hotReload, cancellable);
        return GLib.SOURCE_REMOVE;
      },
    );
  }

  async _applyGtkReload(hotReload, cancellable) {
    if (cancellable?.is_cancelled()) return;

    const hc = this._a11ySettings.get_boolean("high-contrast");

    if (hotReload === 1) {
      this._a11ySettings.set_boolean("high-contrast", !hc);
      this._a11ySettings.set_boolean("high-contrast", hc);
    } else if (hotReload === 2) {
      await this._runSmoothReload(hc, cancellable);
    }
  }

  // This is necessary to force GTK4 applications to reload the stylesheet cache when the accent color changes.
  // This is done by toggling high-contrast mode on and off, which triggers a reload.
  // Gio.Subprocess is required in this case to prevent interface glitches when switching high contrast mode.

  async _runSmoothReload(hc, cancellable) {
    const schema = "org.gnome.desktop.a11y.interface";
    const cmd = `gsettings set ${schema} high-contrast ${!hc} && gsettings get ${schema} high-contrast > /dev/null && gsettings set ${schema} high-contrast ${hc}`;

    try {
      const proc = Gio.Subprocess.new(
        ["bash", "-c", cmd],
        Gio.SubprocessFlags.NONE,
      );

      await new Promise((resolve, reject) => {
        proc.wait_async(cancellable || null, (p, res) => {
          try {
            p.wait_finish(res);
            resolve();
          } catch (e) {
            reject(e);
          }
        });
      });

      this._clearReloadTimeout("_restoreTimeout");
      this._restoreTimeout = GLib.timeout_add(
        GLib.PRIORITY_DEFAULT,
        3000,
        () => {
          this._restoreTimeout = null;
          if (this._a11ySettings?.get_boolean("high-contrast") !== hc) {
            this._a11ySettings?.set_boolean("high-contrast", hc);
          }
          return GLib.SOURCE_REMOVE;
        },
      );
    } catch (e) {
      if (!isCancelledError(e)) {
        this._settings?.set_string(
          "last-error",
          `GTK reload error: ${e.message}`,
        );
      }
    }
  }
}
