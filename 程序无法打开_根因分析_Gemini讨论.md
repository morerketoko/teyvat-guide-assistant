# 提瓦特浏览器无法打开 - 根因分析报告（供 Gemini 讨论）

## 1. 现象（2026-08-27 实测）
- 双击 exe / 确认 UAC 后，进程存在（曾见 9 个实例），但窗口全部不显示：EnumWindows 枚举 24 个窗口，可见数为 0。

## 2. 证据链
- 进程均存活且无崩溃事件（wevtutil 查 Application 日志无本应用 Event ID 1000）→ 排除闪退。
- 窗口对象存在（含 TOPMOST 的浏览器窗口）但全部 WS_VISIBLE=0 → 窗口从未创建/显示。
- 源码版 npx electron . 复现；主进程日志在输出一行 toggle-pinned-mode: no browser window 后无任何后续（app.whenReady 未触发）。


## 3. 根本原因
- 上一轮新增 toggle-pinned-mode IPC handler 时拼接错乱：窗口存在性检查 if (!browserWindow ...) return; 游离到模块顶层（handler 体顺序颠倒）。
- 模块加载到该行时 browserWindow 仍为 null，顶层 return 直接中止 main.js 初始化。
- 其后的全部 ipcMain.on 注册与 app.whenReady().then(createMainWindow) 不再执行，主窗口从未创建。
- 启动日志中那条 toggle-pinned-mode: no browser window 正是顶层 return 前打印（早先被误判为普通 IPC 日志）。


## 4. 修复动作
- 重建 toggle-pinned-mode handler 为完整单一结构（检查、getNativeWindowHandle、setPinnedMode、贴片 blur/交互强前台、通知渲染进程）。
- 顺带修复 renderer.js 同轮引入的两处副作用：pinModeBtn 监听器嵌套进 toggleBrowserBtn 回调内、重复闭合括号及字面 \u0027 转义残留已清理。

## 5. 验证闭环
- node --check 全部 4 个 JS 通过。
- 源码版 npx electron .：主控窗口正常可见（枚举命中 提瓦特浏览器 - 控制台）。
- 重新 npm run build:dir 并以管理员启动新 exe：窗口同样可见。

## 6. 供 Gemini 讨论
1. Electron 主进程入口是单次初始化、一处顶层 return 即可全盘失效的结构，如何建立低门槛回归防线（例如启动冒烟测试：app.whenReady 后断言窗口已创建）？
2. 项目无单实例锁，多实例并存会互争 electron-store 配置，是否应引入 requestSingleInstanceLock？
3. requireAdministrator 导致每次启动弹 UAC 的体验问题，可否改为普通权限启动、需要置顶/快捷键时再提权？
4. 本次定位靠 进程存活 + 窗口枚举 + 事件日志 三板斧，是否有更快的日常诊断手段（如 --enable-logging 常规开启）便于快速判断窗口为何不显示？

