# Insert「再呼出失败」根因分析报告 —— 供 Gemini 讨论

## 1. 现状与关键事实（实测）

- Insert 已能触发呼出动作（键盘钩子/消息泵修复已生效）。
- **窗口显示出来了，但位于游戏（exe）窗口的后面** —— 即浏览器窗口的 Z-Order 在游戏之下。
- 现象不是"按键没到"，而是"**呼出后窗口没真正置顶到游戏之上**"。
- 由此把问题域锁定为 **窗口置顶（Z-Order）链路失效**，键盘钩子与呼出动作本身基本排除。

## 2. 当前置顶链路的三个环节（逐环节弱点分析）

### 环节 1：Electron 侧 `setAlwaysOnTop(true, 'screen-saver')`
- Windows 上 Electron 的 level 参数（screen-saver 等）**无效**，实质只做一次 `SetWindowPos(HWND_TOPMOST)`。
- 对刚 `show()` 的窗口立即调用：Electron 的 show/activate 内部逻辑**可能重置**置顶状态，置顶未持久。
- 本环节只在"呼出瞬间"生效一次，之后靠环节 3 兜底。

### 环节 2：C++ `SetWindowAlwaysOnTop(hwnd, true)`
- 做 TOPMOST + **额外添加 `WS_EX_NOACTIVATE`**（`high_priority_topmost.cc:85`）。
- **`WS_EX_NOACTIVATE` 是焦点杀手**：带该风格的窗口无法被激活/获得焦点。
- 对 Z-Order 影响不大（TOPMOST 仍可置顶），但会让窗口"呼出来了却抢不到焦点、无法交互"，与"呼出但操作不了"的体验吻合。
- 结尾 `SetWindowPos(hwnd, (HWND)-1, ...)`：`(HWND)-1` 就是 `HWND_TOPMOST`，属合理操作。

### 环节 3：监控线程（每 500ms 一轮）
- 用 `GetTopWindow(GetDesktopWindow())` 取顶层窗口链，只检查 **前 10 个**（`high_priority_topmost.cc:148-167`）。
- 弱点 a：**top10 检查不可靠** —— 该链顺序/覆盖并不严格等于"可视层序"，且多显示器场景下更不可靠；若窗口被误判"已在 top10"，就**跳过置顶**。
- 弱点 b：**500ms 周期 vs 游戏高频活动** —— 游戏每帧渲染/每次输入都可能恢复自己的置顶/前台，500ms 一轮的反制**大概率输掉拉锯**。
- 弱点 c：只在"不在 top10"时才置顶，不是无条件刷新，存在误判盲区。

## 3. 根因候选（按可能性排序）

| # | 候选根因 | 证据/推理 |
|---|---------|----------|
| R1 | **游戏窗口同为 TOPMOST（或持续把自身激活到顶）**，与浏览器 TOPMOST 形成拉锯，游戏高频活动胜出 | 无边框全屏游戏常见；TOPMOST 之间按"最近一次置顶/激活"排序，浏览器被持续压后；与"窗口在游戏后面"完全吻合 |
| R2 | 监控线程 top10 误判 + 500ms 周期抢不过游戏 | 环节 3 弱点 a/b；若 R1 成立则叠加恶化 |
| R3 | `WS_EX_NOACTIVATE` 导致焦点抢不到，用户感知为"无法呼出/呼出无效" | 环节 2；是焦点问题不是 Z 序问题，与截图事实不完全一致，属次级问题 |
| R4 | `bringToForeground` 标题匹配失败（大小写敏感 + 空标题窗口被跳过 + 网页标题动态变化） | `EnumWindowsProc` 直接 `find()` 子串、大小写敏感；标题不匹配则返回 false，前置仅靠 Electron focus()（受 Windows 前台锁限制，游戏持有前台时大概率失败）——**影响焦点，不影响置顶** |

**核心判断：R1 + R2 合力** —— 游戏维持自身在顶（同为 TOPMOST 或持续激活），浏览器仅靠"呼出瞬间置顶 + 500ms 反制"抢不回来，于是窗口一直压在游戏后面。R3/R4 是焦点侧的伴生问题。

## 4. 需要验证的关键实验（请 Gemini/动手前先做）

1. **确认游戏窗口是否有 WS_EX_TOPMOST**：SPY++ 或 DebugView 日志查看 exe 窗口 exStyle。若为 TOPMOST → R1 成立。
2. **确认拉锯**：呼出后不操作，观察浏览器窗口是否被游戏"自然压回"（0-3 秒内）；用 DebugView 看监控线程是否持续输出置顶重试。
3. **确认标题匹配**：DebugView 看 `bringToForeground("<title>") -> false` 的频率（R4 是否持续发生）。
4. **确认焦点**：呼出后 `browserWindow.isFocused()` 是否为 false（R3）。

## 5. 修复候选方案（供 Gemini 讨论取舍）

- **方案 1（建议主修）**：监控线程改为**无条件周期性刷新** `SetWindowPos(HWND_TOPMOST)` + `BringWindowToTop`，去掉"top10 判定"的误判盲区；周期从 500ms 缩至 ~150-200ms，并只在**窗口可见**时执行（避免隐藏窗口空转）。可与"呼出时强刷新"合并，赢下与游戏的拉锯。
- **方案 2（辅助）**：移除 `WS_EX_NOACTIVATE`，恢复窗口可激活/可拿焦点（对应 R3）。
- **方案 3（辅助/前提）**：把 electron-builder 提权落实（requireAdministrator 已配，需重新打包后以管理员运行），与游戏同级完整性，避免任何 UIPI 侧干扰。
- **方案 4（讨论项）**：呼出时若 `bringToForeground` 返回 false，主进程侧用 Electron `focus()` + 延迟 100-200ms 二次 `setAlwaysOnTop/focus` 重试（补偿标题匹配/前台锁时序）。
- **不推荐**：强行把游戏窗口置为非 TOPMOST（侵入游戏、易触发反作弊/兼容问题）。

## 6. 给 Gemini 的讨论问题

1. R1（游戏同为 TOPMOST + 拉锯）与 R2（500ms/top10 误判）哪个更可能是主因？是否需要先跑第 4 节的实验 A 来裁决？
2. "无条件周期性置顶刷新"（方案 1）是否会带来副作用（如全屏游戏下闪烁、被游戏反制、CPU 占用）？周期取多少合理？
3. `WS_EX_NOACTIVATE` 到底该删还是保留（保留的理由是"避免抢游戏焦点导致游戏暂停/切出"）？如果既要置顶又要不抢焦点，"置顶但不激活"和"抢前台"在 Insert 呼出场景下如何取舍？
4. 标题匹配（R4）在 Electron 下是否有更稳的替代（如用 `webContents`/原生窗口句柄直传，而不是按标题字符串找）？
5. 是否应把"呼出时强前台"与"游戏内常驻置顶"拆成两种模式（呼出瞬时抢焦点 vs 常驻仅置顶不抢焦点），从产品体验上是否更合理？


## 7. 追加：置顶与前台链路重构实施记录（2026-08-26）

> 对应任务书《重构置顶与前台链路》，改动已全部完成并编译通过。

### 7.1 已实施改动

**C++ 原生模块 src/native/src/high_priority_topmost.cc（整文件重写）**
- 废弃按窗口标题字符串找窗口（原标题匹配脆弱：大小写敏感、空标题被跳过、网页标题动态变化即失效）。
- 新增 GetHWNDFromArg 直传句柄，支持 Buffer（Electron getNativeWindowHandle 返回值）、BigInt、Number。
- 移除 WS_EX_NOACTIVATE，恢复窗口可激活、可聚焦（对应原根因 R3 焦点杀手）。
- 新增 ForceForegroundAndTopmost：AttachThreadInput 穿透前台焦点锁，随后 ShowWindow、SetWindowPos TOPMOST、BringWindowToTop、SetForegroundWindow、SetFocus，最后分离线程输入。
- 监控线程重构：周期 500ms 缩至 200ms；废弃 GetTopWindow 遍历 top10 模糊判定，改用精确 GetWindow(目标, GW_HWNDPREV) 判断上方是否还有窗口，有则 SetWindowPos TOPMOST 且带 SWP_NOACTIVATE、SWP_NOSENDCHANGING 无激活修正。
- 导出接口：startWindowMonitoring、stopWindowMonitoring、setWindowTopmost、getVisibleWindows、forceForegroundAndTopmost。

**src/native/lib/topmost.js（重写）**
- 全部改为 HWND 直传，移除旧 bringToForeground 标题匹配接口（对应原讨论问题 4）。

**src/main/main.js（主进程改造）**
- summonBrowserWindow：show/restore 后立即调 C++ forceForegroundAndTopmost(hwndBuffer)，随后 50ms、150ms 两次连击补偿（瞬时爆发刷新，对抗游戏高频激活拉锯），200ms 后 Electron focus 补击。
- toggleBrowserVisibility：窗口可见且聚焦才隐藏，否则一律执行召唤（避免全屏游戏遮挡下 isVisible 误判为隐藏而非呼出）。
- startBrowserWindowMonitoring：HWND buffer 直传 C++ 监控线程，失败兜底。
- 旧引用 showAndFocusBrowserWindow、startAdvancedTopmost、bringToForeground 已清零。

### 7.2 编译验证
- npx node-gyp rebuild --target=27.3.11 --dist-url=https://electronjs.org/headers --arch=x64 编译成功（仅 shortcut.cc 原有 C4530 警告）；.node 导出名与 JS 调用逐项核对无缺失。

### 7.3 追加讨论点
- 呼出 0/50/150ms 爆发叠加常驻 200ms GW_HWNDPREV 监控，对 CPU 与游戏性能的影响需要实测评估。
- 移除 WS_EX_NOACTIVATE 后呼出会抢游戏焦点（无边框全屏可能失焦暂停），是否拆成呼出抢焦点与常驻仅置顶双模式。
- 若仍有残余拉锯，下一步考虑 DwmSetWindowAttribute 强化或二次 AttachThreadInput，还是依赖呼出爆发即可。
- 原第 4 节验证实验在重构后是否已闭环（游戏是否同为 TOPMOST、呼出后是否仍被自然压回）。