# 壁纸变更 → 强调色更新：问题排查与修复记录

> 分支：`icookie`（基于上游 `0a75e7a` "update translations"）
> 日期：2026-09-09
> 状态：✅ 已修复并验证

## 1. 问题现象

- 在 GNOME 设置 / 扩展设置里换壁纸 → 强调色正常更新
- 在文件管理器（nautilus）、其他壁纸软件（如 Damask）中换壁纸 → **强调色不更新**
- 换壁纸后手动切换一次深色/浅色模式 → 强调色才更新
- 扩展设置页打开时，页面上的壁纸预览和强调色也不随外部换壁纸更新，只有重新打开设置窗口才刷新

## 2. 排查过程

### 2.1 第一轮审计：dconf 监听逻辑（代码审查）

扩展通过 `Gio.Settings`（schema `org.gnome.desktop.background`）监听
`changed::picture-uri` 和 `changed::picture-uri-dark` 两个信号。该机制对任何
写 dconf 的应用都有效（GNOME 设置、nautilus 等），**检测本身不是问题**。

真正的问题在去重逻辑（`extension.js`）：

```js
const handleWallpaperChange = async () => {
  let currentUri = /* 只取当前 color-scheme 对应的那个键 */;
  if (this._lastWallpaperUri === currentUri) return;  // ← 吞掉另一个键的变更
  ...
```

去重只跟踪"生效键"（深色模式 → `picture-uri-dark`，否则 `picture-uri`）。
外部应用通常只写其中一个键：

| 切换来源 | 写入的键 | 深色模式下生效键是否变化 | 结果 |
|---|---|---|---|
| 扩展自己的设置 UI | 两个都写 | 是 | ✅ 更新 |
| nautilus / GNOME 设置 | 通常只写一个 | 否 | ❌ 信号触发了但被早退吞掉 |

这解释了"切换深浅色模式才更新"——`changed::color-scheme` 处理器会重新从
生效键取 URI 并算色，绕过了坏掉的壁纸变更路径。

### 2.2 第二轮：嵌套会话 + 日志定位

在嵌套会话（`dbus-run-session -- gnome-shell --devkit`）中给扩展加了
`[ChromaLeon]` 前缀的调试日志后测试，发现：

- 扩展链路完全正常：任何 dconf 写入都被检测、算色、应用、并实时同步到设置页
- **但 nautilus 和 Damask 的"设置壁纸"操作根本没有写入 dconf**
  （`gsettings monitor` 无输出，dconf 文件 mtime 不变）
- 嵌套会话与真实桌面会话各跑一个 dconf-service、共用同一个
  `~/.config/dconf/user` 文件，会互相覆盖对方的写入（last-writer-wins），
  干扰测试，最终改在真实桌面会话验证

### 2.3 第三轮：找到真正根因（文件覆盖型换壁纸）

对比 `~/.config/background` 文件状态：

```
dconf 壁纸键:  file:///home/icookie/.config/background   （始终不变）
~/.config/background:
  md5:  9fbdabc6... → 4bff2197...   （内容被替换了！）
  mtime: 每次 Damask 换壁纸都会更新
```

**Damask（`app.drey.Damask`，flatpak）的换壁纸方式是直接覆盖固定路径下
壁纸文件的内容，从不修改 dconf 的 `picture-uri`。**

GNOME Shell 自己监听壁纸文件变化，所以屏幕壁纸会变；但扩展（包括上游原版）
只监听 dconf URI → 这种换壁纸方式永远不会被检测到。

## 3. 修复内容

### 3.1 双键跟踪 + 去抖（commit `9889fcc`）

`extension.js`：

- `_lastLightUri` / `_lastDarkUri` 分别跟踪两个键，**任一变化都触发**
- 取色键的选择策略：
  - 生效键（匹配当前 color-scheme）变了 → 用生效键
  - 只有另一个键变了 → 跟随用户刚选的壁纸
- 100ms 去抖：某些应用会连续写两个键，合并为一次处理
- `_autoApplyWallpaperColor(color, cancellable, uri)` 增加可选 `uri` 参数，
  避免二次读取生效键取到旧值
- enable 时用当前值初始化基线，避免首个事件被误判为"双键都变了"

### 3.2 设置页实时更新（commit `7afea98`）

扩展设置页运行在**独立进程**中，`chromaleon.js`：

- 新增监听自己 schema 的 `changed::accent-color` → 实时刷新颜色块/副标题
  （之前只监听 `changed::gnome-colors`，强调色要重开窗口才刷新）
- 壁纸预览采用与主扩展一致的双键跟踪 + 去抖逻辑
- 窗口关闭时正确断开新信号、清理定时器

### 3.3 壁纸文件监控（commit `e4f754c`）——真正根因的修复

- 扩展端：对当前生效的壁纸文件挂 `Gio.FileMonitor`，**文件内容被替换时
  同样触发取色更新**；dconf URI 变化或深浅色切换时自动重新挂载
- 设置页端：同样加文件监控，预览实时刷新
- 顺带修复 `utils/colorUtils.js`：`calculateVibrantColor` 在文件读取/解码
  失败时 Promise 永不 resolve（会挂死整个操作链），现在记录日志并
  resolve(null)
- 全链路加入 `[ChromaLeon]` / `[ChromaLeon-prefs]` 调试日志

### 3.4 Fork 标识（commit `d327fad`）

`metadata.json`：

- uuid 改为 `user-accent-colors@icookie.shell-extension`
- 显示名改为 `ChromaLeon (icookie)`

可与上游扩展并存。⚠️ 注意：两者共用同一套 gsettings schema
（`org.gnome.shell.extensions.chromaleon`），**同时启用会互相干扰**，
测试/使用时应只启用其中一个。

## 4. 分支与提交

```
e4f754c fix: detect wallpaper changes made by replacing the wallpaper file
d327fad chore: rebrand fork with unique uuid to coexist with upstream
7afea98 fix: live-update prefs page when wallpaper changes externally
9889fcc fix: detect wallpaper changes from external apps
0a75e7a update translations                        ← 基准（上游 translations 分支顶端）
```

## 5. 安装与测试

```bash
# 打包安装
zip -rq /tmp/user-accent-colors@icookie.shell-extension.zip . -x ".git/*" -x "*.zip"
gnome-extensions install --force /tmp/user-accent-colors@icookie.shell-extension.zip
```

注意：

- **新 uuid 需要重启 GNOME Shell 才会被识别**（注销/登录；Wayland 下无
  Alt+F2 r）。修改扩展代码后同样需要重启 shell——该版本 shell 缓存扩展
  模块，disable/enable 不重载代码
- 用 Extension Manager 从网上装的扩展能立即生效，是因为它调用 shell 自身
  的 D-Bus 方法 `InstallRemoteExtension`，由 shell 进程自己完成安装；
  `gnome-extensions install` 是在进程外解压，shell 启动时只扫描一次目录
- 启用 `ChromaLeon (icookie)` 后建议禁用原版 `user-accent-colors@fabito02`

测试矩阵（均已验证）：

| 场景 | 预期 |
|---|---|
| 文件管理器换壁纸（浅色模式） | 强调色实时更新 |
| 文件管理器换壁纸（深色模式） | 强调色实时更新（原必挂场景） |
| Damask 换壁纸（覆盖文件内容型） | 强调色实时更新 |
| 设置页打开时外部换壁纸 | 预览与强调色实时更新 |
| 切换深浅色模式 | 行为不变，按新生效键取色 |
| 快速连续切换多张壁纸 | 去抖后只处理一次，跟随最后一张 |

## 6. 已知限制

- **纯色/渐变壁纸**：`picture-uri` 为空，颜色在 `primary-color` /
  `secondary-color` 键中。当前（含上游）不支持从纯色提取强调色。如需支持，
  应监听 `primary-color`
- `picture-options`（铺满方式：stretch/zoom/centered…）不影响图片内容，
  无需监听
- flatpak 壁纸应用的设置写入被沙箱隔离，无法影响宿主 dconf；Damask 走
  文件覆盖路线，已被文件监控覆盖

## 7. 调试手段备忘

```bash
# 实时监控壁纸相关 dconf 键
gsettings monitor org.gnome.desktop.background

# 查看扩展日志（真实会话）
journalctl --user --since "5 min ago" | grep ChromaLeon

# 嵌套会话
dbus-run-session -- gnome-shell --devkit > /tmp/nested-shell.log 2>&1 &
# ⚠️ 嵌套会话与真实会话共享 ~/.config/dconf/user，两个 dconf-service 会
#    互相覆盖写入，不适合做壁纸变更测试
```
