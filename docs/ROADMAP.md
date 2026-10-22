# 路线图

这份文件不只记"还要做什么"。它记三件事：

1. **走到了哪** —— 进度总览、当前规模
2. **哪些决定被现实推翻过** —— 每次想"这个方案显然更好"之前，先翻这一节
3. **踩过的坑** —— 一行一条，症状 / 真实原因 / 解法

第 2 节比第 1 节重要。待办会变，被推翻的理由不会。

---

## 进度总览

| 版本 | 主题 | 状态 | 一句话证明 |
| --- | --- | --- | --- |
| v0.1 | 骨架 | ✅ 完成 | 组件在沙箱里跑起来，桥与权限能验 |
| v0.2 | 真桌面 | ✅ 完成 | 组件是独立的 Win32 窗口，能拖能缩能锁，重启不丢 |
| v0.3 | 平台能力 | 进行中 | 系统指标、网络代理、调度器、崩溃隔离 |
| v0.4 | 开发体验 | 未开始 | SDK、脚手架、打包工具 |
| v0.5 | 分发 | 未开始 | 组件商店、签名、更新 |

**当前规模**（截至 `f2f132f`，2026-10-22 23:50）：

| 指标 | 数值 | 备注 |
| --- | --- | --- |
| 前端 TS/TSX | 3 216 行 | 平台外壳 + 运行时 |
| 样式 CSS | 1 757 行 | 纯手写，无 UI 库 |
| Rust | 1 649 行 | 窗口、协议、落盘 |
| 官方组件 + 示例 | 1 588 行 | 4 个官方包 + 1 个第三方样本 |
| Tauri 命令 | 20 个 | |
| 权限 | 6 项 | clock / storage / clipboard:write / network / system:monitor / media:control |
| 踩过的坑 | 27 条 | 见文末 |

---

## 迭代时间线

一天之内，从"骨架"到"真的贴在桌面上"。

| 时间 | 提交 | 做了什么 | 规模（TS / Rust / CSS） |
| --- | --- | --- | --- |
| 02:40 | `b6fbbf8` | 骨架：清单、注册表、沙箱桥、权限闸门、画布、Win32 初版 | 1 268 / 358 / 548 |
| 09:35 | `abd20c0` | 改成**零内置**：官方包也必须显式安装 | 1 477 / 358 / 631 |
| 09:54 | `fb2a1b6` | 第一个能跑的 demo：官方组件包、就地授权 | 1 553 / 358 / 680 |
| 11:22 | `b8fbc95` | 组件真的贴到桌面：每个 Placement 一个窗口 | 1 782 / **712** / 680 |
| 11:25 | `bbdc893` | 修：投放后组件被推到屏幕外（`screenX` 哨兵值） | — |
| 11:27 | `ed269c5` | 实机截图进文档 | — |
| 12:31 | `250ab45` | 窗饰（拖 / 层级 / 别针 / 收回）+ 状态落盘 | 2 282 / **1 123** / 868 |
| 23:50 | `f2f132f` | 用户组件协议、可输入、存储广播、边界夹紧、设置菜单 | **3 216** / **1 649** / **1 757** |

数字里能看到三处台阶：

- **11:22 Rust 358 → 712**：窗口层落地。之前所有窗口代码都是"写了但没接进流程"。
- **12:31 Rust 712 → 1 123**：窗饰回传 + 文件落盘。落盘这一项看着简单，实际是 400 行——因为要和"用户正在拖窗口"抢时序。
- **之后 Rust 1 123 → 1 649**：自定义协议 + 键级存储 + 窗口守卫。这一批几乎全是"被逼出来的"。

前端那 900 多行的涨幅九成在 CSS：UI 从"能用"变成"能看"，顺便把图标从 emoji 换成了内联 SVG（emoji 在不同 DPI 下粗细不一致，且没法跟随主题色）。

---

## 被推翻的六个决定

这一节是这份文档的核心。每条都写着**当初为什么这么选**、**什么把它撞翻了**、**现在怎么做**、**付出了什么代价**。

六个里，**四个是环境撞出来的**（显卡拿不到合成、WebView2 不落盘、Tauri 同步命令占主线程、Windows 激活时改 z 序），**两个是自己图省事埋的**（宿主页自己拼地址、每个实例各缓存一份数据）。

没有一个是"架构不够优雅"。这也解释了为什么坑表比待办清单长：真正拦住你的往往不是设计，而是你没预料到的那台机器。

### 1. 逐像素透明 → 不透明窗口 + 圆角裁剪

- **当初**：`transparent(true)` + `DwmEnableBlurBehindWindow`，指望组件像贴纸一样浮在壁纸上，形状完全自由。
- **撞墙**：逐像素透明要求 WebView2 走 DirectComposition。这台机器 GPU 进程起不来（混合显卡 + 虚拟显示适配器），软件渲染下拿不到 alpha 通道，卡片永远是白的。试过 `--disable-gpu-compositing`，窗口直接建不出来（`HRESULT 0x8007139F`）。
- **现在**：窗口不透明，**宿主页自己画卡片**（底色 + 1px 内描边），`SetWindowRgn` + `CreateRoundRectRgn` 把外形裁成 12px 圆角。缩放时重新裁一次。
- **代价**：圆角弧线外侧那几个像素不属于窗口，缩放手柄必须往里让 18px（Windows 自己的窗口也一样）；异形窗口、投影、模糊背景暂时都做不了。

### 2. `localStorage` → 文件

- **当初**：Zustand 的 `persist` 默认走 `localStorage`，一行配置就完事。
- **撞墙**：这台机器 WebView2 的 `localStorage` 全在内存里。`EBWebView/Default/Local Storage` 从来没被创建过——页面内写入后读回正常，**磁盘上就是没有**，优雅退出也一样。重启布局全丢，对桌面平台是硬伤。
- **现在**：`StateStorage` 换成 Tauri 命令，写 `state.json`（临时文件 + 原子替换）；组件私有存储同样落文件。顺带把存储接口从"整块覆盖"改成**键级原子写**（`widget_store_update`，进程内锁内读-改-写）。
- **代价**：每次读写都要过 IPC；`store.ts` 里必须先立一道 `hydrated` 闸门，否则异步水合完成前任何一次 set 都会把空状态盖到磁盘上。

### 3. 一律"点了不打扰" → 按 `interactive` 分流 + 底层守卫

- **当初**：所有桌面窗口都 `WS_EX_NOACTIVATE`，还挂进 WorkerW 当桌面的子窗口。追求"绝不抢焦点"。
- **撞墙**：便签、待办打不了字——键盘焦点根本进不来。但去掉 `NOACTIVATE` 之后，点一下它就窜到浏览器前面，切走又掉回桌面，**一进一出就是"闪来闪去"**。
- **现在**：清单加 `interactive`（默认 `true`）：不挂 WorkerW、去掉 `NOACTIVATE`、压到 `HWND_BOTTOM`，再子类化拦 `WM_WINDOWPOSCHANGING`，给"往上提"的请求补 `SWP_NOZORDER` —— 激活照给，z 序原地不动。
- **代价**：多一层守卫，而且**守卫是"开关 + 子类化"两件事**：开关是窗口属性（任意线程可翻），子类化只能回窗口线程装（`SetWindowSubclass` 跨线程会静默返回 0，不报错）。切"置顶"前必须先翻开关，否则那一下 `HWND_TOPMOST` 会被守卫吃掉。

### 4. 宿主页自己拼入口地址 → 一处算绝对地址 + 自定义协议

- **当初**：宿主页 `base + entry` 拼 iframe 的 `src`。bundled 组件的资源就在前端目录里，够用。
- **撞墙**：用户组件的文件在 `%APPDATA%`，前端资源里没有，`/widgets/<id>/...` 这条路径够不到。组件"装了但打不开"，卡片写着"待接入"。
- **现在**：`registry.ts::resolveEntryUrl` 一处算出绝对地址，`buildSpecs` 原样透传；`protocol.rs` 提供 `lattice-widget` 协议，把 `%APPDATA%` 下的组件当静态站点发。路径穿越在**百分号解码之后**判断，未知 MIME 一律按二进制发。
- **代价**：Windows / Android 上自定义 scheme 必须写成 `http://lattice-widget.localhost/`，写成 `lattice-widget://localhost/` 连请求都发不出去（不报错，只是白屏）；iframe 是 opaque 源，响应必须带 `Access-Control-Allow-Origin: *`，否则组件 `fetch` 自己的 json 会被当跨域拦掉。

### 5. 每个实例缓存一份存储 → 读不缓存 + 落盘后广播

- **当初**：桥里持有一份 `storeCache`，省 IPC。组件读自己数据不必每次都过 Rust。
- **撞墙**：画布一个实例、桌面一个实例，各持一份内存列表。A 加完 B 还停在旧列表，B 随便动一下就整块写回去——用户看到的是**"加了几条待办，回头只剩一条"**。
- **现在**：读不缓存；写走 `widget_store_update` 做键级合并；每次落盘后 Rust 广播 `lattice:widget-store`，两个宿主转成 `store-changed` 推给 iframe，组件收到重读（自己的写入还在飞时推迟到落地）。
- **代价**：读写都要 IPC；**每个用 `storage` 的组件都必须处理这条推送**，不处理就是"多实例必丢数据"。这条已写进 `WIDGET_SPEC`。

### 6. 自己维护窗口表 → 交给 Tauri 的注册表

- **当初**：`Mutex<HashMap<label, WebviewWindow>>` 自己管窗口，看起来最直接。
- **撞墙**：建窗口时新窗口的宿主页立刻回调 `widget_host_config` 来抢同一把锁 —— 死锁，表现为 `HRESULT 0x8007139F`。同一类错误还有一次：**Tauri 2 的同步命令跑在主线程**，而 `build()` 要把建窗口的活投递回主线程再等结果，命令占着主线程等自己，界面直接冻住、日志停在 `sync specs=N`。
- **现在**：窗口存在性问 `app.get_webview_window`，不自己记账；Runner 只存极轻的 `HostConfig`，且必须在 `build()` **之前**写入；所有建窗口的命令都是 `async fn`，落到运行时线程池。
- **代价**：不能在"建窗口过程中"读窗口状态；`HostConfig` 的登记顺序成了隐式契约，改动这块要先看 AGENTS.md §5。

**一条总结**：这六个都不是"架构错了"，是"环境比文档狠"。所以每次撞墙之后，除了改代码，还往坑表补一行——那 27 行就是这台机器教我的东西。

---

## v0.1 —— 骨架（已完成）

目标是把最贵的三个决定定死：组件包格式、桥协议、权限模型。

- [x] Tauri 2 + React 19 + TS 工程骨架
- [x] 组件清单校验与归一化（`runtime/manifest.ts`）
- [x] 组件注册表：内置（index.json）+ 用户安装（Rust 扫描）
- [x] 沙箱 iframe 运行时 + 来源校验的 RPC 桥
- [x] 权限闸门与逐项授予 UI
- [x] 画布：拖动、缩放、网格吸附、层级标记、鼠标穿透开关
- [x] Win32：`WS_EX_NOACTIVATE` / `WS_EX_TOOLWINDOW` / 穿透 / WorkerW 挂载 / 置顶
- [x] 组件包安装与卸载（Rust 命令，含 id 合法性校验）
- [x] 两个可运行的示例组件：时钟、待办
- [x] 明暗主题与主题令牌下发

## v0.2 —— 真桌面（已完成）

从"画布上的预览"变成"真的贴在桌面上"。

- [x] **每个组件一个 WebviewWindow** —— 由 Placement 派生真实窗口，主窗口最小化退场
- [x] **层级实机接入** —— `desktop.rs` 的 `apply_window_layer` 已接进窗口创建流程
- [x] **圆角** —— `SetWindowRgn` 把窗口裁成圆角矩形（见"被推翻的决定"第 1 条）
- [x] **桌面窗口的窗饰** —— 右上角四个功能图标（拖动 / 层级 / 别针 / 收回）+ 八向缩放手柄，全部由宿主页 `widgetHost.ts` 自绘，组件不参与
- [x] **别针锁定** —— `placement.pinned` 落到 Win32 之外的一层：锁住后拖拽与缩放手柄整体禁用，光标也跟着变
- [x] **位置与尺寸回写** —— 松手时把窗口矩形报回主窗口，存进 `desktopRects`，下次投放优先用它
- [x] **状态落盘** —— 平台状态与组件私有存储都写文件（`%APPDATA%\com.iron-tom.lattice`），重启不丢
- [x] **主题热更新** —— 平台切明暗时广播给所有桌面窗口，不用重开
- [x] **桌面组件可输入** —— 清单 `interactive` 分流：要写字的组件不挂 WorkerW、能拿键盘焦点，靠底层守卫压住 z 序
- [x] **属性面板改尺寸** —— 宽/高精确输入 + 恢复默认，同时写画布与桌面矩形
- [x] **组件存储跨实例同步** —— 每次落盘后广播 `lattice:widget-store`，同一组件的画布实例与桌面实例自动重读，不再互相覆盖
- [x] **窗口位置兜底** —— 拖动与缩放都以右上角那颗按钮为锚点夹回显示器工作区，拖到屏幕外也能拖回来
- [x] **`lattice-widget://` 自定义协议** —— 用户安装的组件从 `%APPDATA%` 直接加载，路径穿越与 id 校验都在协议层
- [x] **安装链路** —— 把组件文件夹拖进窗口即安装（`install_widget` 先删后拷 + webview 拖放事件），组件库标题栏可直达组件目录
- [x] **设置菜单** —— 顶栏头像（`Ctrl+,`）唤出：本机档案、外观、网格吸附、关于
- [x] **图标集** —— 内联 SVG 取代 emoji，随主题上色，不再受 DPI 影响

**验收结果**（2026-10-22 实机，不是"应该能"）：

| 项 | 实测 |
| --- | --- |
| 拖动 | 指针位移 `+80,+40`，窗口从 `(30,700)` 到 `(110,740)`，分毫不差 |
| 缩放 | 右下角 `260×200 → 320×240`；右边单独 `320 → 250`；小于 `minW/minH` 会夹紧 |
| 别针 | 锁上后同样拖 80px，窗口纹丝不动；解锁立刻恢复 |
| 收回 | 窗口消失，`state.json` 里 `placements: []`、`desktopRects: {}` 同步清空 |
| 重启 | 摆放、已安装、授权、主题、便签文字、待办勾选全部从磁盘恢复 |

验收标准（已达成）：关掉主窗口后，桌面上的组件仍在，切窗口不被遮挡，点击不抢焦点。

**没做的，挪进 v0.3**：多显示器 PerMonitorV2、托盘、组件加载失败的兜底页、重启后自动把组件放回桌面。

### 踩过的坑（都已解决，别再踩）

| 症状                                                          | 真实原因                                                                                       | 解法                                                                |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------- |
| 命令里调 `sync_widget_windows` 之后界面直接冻住，日志停在 `sync specs=N`，无报错 | Tauri 2 的**同步命令跑在主线程**，而 `WebviewWindowBuilder::build()` 要把建窗口的活儿投递回主线程再等它完成 —— 命令占着主线程等自己 | 命令改成 `async fn`，落到运行时线程池                                          |
| 同上，但表现为 `WebView2 error HRESULT(0x8007139F)`                | 持有 `Mutex<窗口表>` 去建窗口，新窗口的宿主页立刻回调 `widget_host_config` 抢同一把锁                                | 不维护窗口表，窗口存在性交给 `app.get_webview_window`；宿主页配置在 `build()` **之前**登记 |
| 主窗口一片白，`eval` 返回 Ok 但脚本没跑                                   | WebView2 的 GPU 进程起不来（混合显卡 + 虚拟显示适配器）                                                       | `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--in-process-gpu`          |
| 加上 `--disable-gpu-compositing` 后透明窗口建不出来                    | 该开关会关掉 DirectComposition，逐像素透明依赖它                                                          | 不要加这个开关                                                           |
| 组件窗口背景永远是白的，`transparent(true)` 无效                          | 逐像素透明要求 WebView2 走合成，软件渲染下拿不到；`DwmEnableBlurBehindWindow` 也压不住                             | 放弃逐像素透明：窗口不透明、宿主页自己画卡片、`SetWindowRgn` 裁圆角                         |
| `layer: desktop` 的组件跑到了最上层                                  | `window.show()` 在 `apply_to` 之后调用，ShowWindow 会把窗口重新提到最前                                    | 先 `show()` 再应用层级                                                  |
| 投放之后组件"消失"，`GetWindowRect` 显示在 -31000 一带                   | 主窗口最小化后 `window.screenX/screenY` 变成 `-32000` 哨兵值，防抖同步拿它重算画布原点，把窗口 `set_position` 到屏幕外      | 缓存上一次可信的原点，遇到哨兵值退回缓存                                             |
| `cargo build` 报 `export ordinal too large: 92606`           | `crate-type` 里有 `cdylib`，windows-gnu 要导出巨大符号表                                              | 只留 `rlib`                                                         |
| 组件内容明明写了 `background: transparent`，桌面卡片却是一块白板        | 平台在 `:root` 上设了 `color-scheme: dark`，它会继承进 iframe 元素、变成被嵌入文档的初始 color-scheme；只要不是 `normal`，Chromium 就给 iframe 画布刷一层不透明底色 | `iframe { color-scheme: normal }`（`widgetHost.css` 与 `styles.css` 各一处） |
| 缩放手柄"点不准"，正对着窗口角点按下去会穿到桌面                    | 窗口被 `SetWindowRgn` 裁成圆角后，圆角弧线外侧那几个像素不属于窗口，鼠标事件到不了                            | 四个角的手柄放大到 18px，让弧线以内的部分也落在手柄里；这是圆角窗口的固有代价，Windows 自己的窗口也一样 |
| 重启之后布局全丢，`localStorage` 里空空如也                        | 这台机器的 WebView2 把 localStorage 全放内存里，`EBWebView/Default/Local Storage` 从没被创建过（优雅退出也一样） | 状态改为显式写文件：`state.json` + `widget-data/<组件>.json`，走原子替换          |
| `layer: desktop` 的窗口其实没挂到 WorkerW                       | 部分 Win11 版本 `Progman` 自己承载 `SHELLDLL_DefView`，`0x052C` 之后也不会派生 WorkerW 兄弟窗口，查找返回 None | 已有降级：退成 `HWND_BOTTOM`，仍在所有普通窗口之下；真挂载留给后续版本                  |
| 点「收回」之后窗口要愣几百毫秒才消失                                       | `window.close()` 要等 WebView2 把渲染进程拆完，这段时间窗口还完整地定格在屏幕上                                     | 宿主页先 `hide()` 再走 IPC 关闭，失败则 `show()` 回滚；Rust 侧三处关闭路径同样先 hide 再 close |
| 桌面上的笔记/待办点进去打不了字，连光标都没有                                     | 桌面窗口一律带 `WS_EX_NOACTIVATE`，还被挂进 WorkerW 变成桌面的子窗口 —— 两条都让键盘焦点进不来                               | 清单加 `interactive`（默认 `true`）：不挂 WorkerW、去掉 `NOACTIVATE`、压到 `HWND_BOTTOM` |
| 点一下组件，它窜到所有窗口最前面，切走又掉回桌面 —— 看着就是"闪来闪去"                          | 可激活的窗口被激活时，Windows 会顺手把它提到 z 序最前。能打字和"待在桌面层"本来是冲突的                                        | 子类化拦 `WM_WINDOWPOSCHANGING`：给"往上提"的请求加 `SWP_NOZORDER`，原地不动。激活照给，z 序不动             |
| 守卫明明加了，窗口还是往上窜                                            | `SetWindowSubclass` 跨线程调用不报错，只返回 0 —— 从同步命令的线程装守卫会静默失败                                    | 用 `window.run_on_main_thread(...)` 回到窗口线程再装                                  |
| 用户组件"装了但打不开"，卡片写着"待接入"                                 | 用户组件的文件在 `%APPDATA%` 里，前端资源里没有，`/widgets/<id>/...` 这条路径够不到它                          | 注册 `lattice-widget` 协议，把 iframe 的 src 指向 `http://lattice-widget.localhost/<id>/<相对路径>`（`protocol.rs`） |
| 自定义协议的地址在 Windows 上一直 404                                  | Windows / Android 把自定义 scheme 挂在 `http://<scheme>.localhost/`，其它平台才是 `<scheme>://localhost/` —— 写成后者在 Windows 上连请求都发不出去 | `registry.ts::widgetSchemeBase()` 按 UA 分流；协议处理器只看 `uri.path()`，不关心 host |
| 组件里 `fetch("data.json")` 被 CORS 拦掉                            | iframe 是 `sandbox="allow-scripts"`，文档源是 opaque 的，取自己的文件在浏览器看来也算跨域                       | 协议响应统一带 `Access-Control-Allow-Origin: *`                                     |
| 卸载组件后顶栏计数比看得见的多一个                                     | 只删了 `installedIds`，没删 `placements`：留下一个指向不存在组件的幽灵，画不出来也点不到                            | `uninstall` 里先按 `widgetId` 清掉所有实例，再取消安装                                |
| 装完第三个组件"什么都没发生"                                        | `nextFreeSlot` 把换行线写死在 1600px，窄窗口下新组件被摆到可视区右侧，得横向滚才看得见                            | 换行位置按 `.lattice-canvas` 的实际 `clientWidth` 算                                  |
| `cargo test` 编译通过但一运行就 `0xc0000139 STATUS_ENTRYPOINT_NOT_FOUND` | windows-gnu 下 tauri 的测试二进制起不来（跟代码无关，`cargo build` / 真机运行都正常）                    | 纯函数逻辑靠端到端验证兜底（`curl` 协议、CDP 查 iframe）；换 msvc 工具链即可正常跑测试 |
| 组件拖到屏幕边缘外面，之后就再也拖不回来                                 | 拖动完全按指针位移走，没有任何边界约束；唯一能抓的按钮在窗口右上角，跟着窗口一起出界                          | `widgetHost.ts::clampAnchor`：以那颗按钮为锚点，至少留 24px 在某块显示器**工作区**内；按锚点选屏，跨屏拖动才不会被接缝卡住 |
| 加了几条待办，回头只剩一条                                            | 画布上一个实例、桌面窗口一个实例，各持一份内存列表。A 加完 B 还停在旧列表，B 随便动一下就整块写回去                      | Rust 每次落盘后广播 `lattice:widget-store`，两个宿主转成 `store-changed` 推给 iframe；组件收到就重读，自己的写入还在飞时推迟到落地 |
| 组件在桌面上的位置停在任务栏底下，按钮点不到                                | 夹边界用的是 `monitor.size`（含任务栏），不是 `monitor.workArea`                                            | `screenBoxes` 取 `workArea`，取不到才退回 `size`                                  |
| 切"置顶"没反应，组件还趴在桌面层                                         | 守卫摘得比 `HWND_TOPMOST` 晚：那一下 SetWindowPos 被守卫改写掉了                                                | 守卫状态用窗口属性做开关，`apply_to` 里**先翻开关再落层级**                                  |
| 属性面板改了尺寸，桌面上的组件纹丝不动                                       | `buildSpecs` 优先用 `desktopRects` 里的尺寸（那是用户拖边缘改过的真实值），只写 `placement.w/h` 会被它盖掉                      | 提交尺寸时两处一起写；`desktopRects` 有记录才写它                                         |

### 环境与构建（windows-gnu）

默认工具链是 `stable-x86_64-pc-windows-gnu`，它不自带 `windres`，也没有 `gcc`，  
而 `tauri-build` 要用 `windres` 编译 `resource.rc`、`windres` 又要调 `gcc -E`。

`scripts/tauri.mjs` 在启动 `tauri` 之前把两个目录塞进 `PATH`：

```
.toolchain/mingw64/bin     # MSYS2 binutils 里的 windres.exe
.toolchain/gcc-shim        # 一个只做透传的 gcc.exe（见 toolchain/gcc-shim/gcc.rs）
```

`npm run tauri:dev` / `tauri:build` 都走这个包装脚本，所以直接跑就行。  
换到 MSVC 工具链（`rustup default stable-x86_64-pc-windows-msvc`）就不需要这一套了。

### 运行时开关

| 变量                                          | 作用                                      |
| ------------------------------------------- | --------------------------------------- |
| `LATTICE_GPU=1`                             | 不注入 `--in-process-gpu`，恢复 WebView2 默认行为 |
| `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=...` | 自己指定 WebView2 启动参数（优先级最高）               |

## v0.3 —— 平台能力

v0.2 收尾时挪过来的四项排在前面。

- [ ] **组件加载失败的兜底页** —— 现在白屏，用户看不出是 404 还是组件自己的 JS 崩了；协议 404 返回可读 HTML
- [ ] **重启后自动把组件放回桌面** —— 现在刻意回到设计态（先让人看见画布），要做成可选项
- [ ] 多显示器与 PerMonitorV2 DPI 处理
- [ ] 托盘图标：显示设置、暂停全部组件、退出
- [ ] 系统指标数据源：CPU / 内存 / 磁盘 / 网络（`system:monitor` 权限落地）
- [ ] 网络白名单代理（`network` 权限落地，组件不直连）
- [ ] 平台统一调度器：组件定时器集中管理，不可见时暂停
- [ ] 组件崩溃隔离与自动恢复
- [ ] 撤销授权同步到已打开窗口（`Applied` 加 permissions 签名）
- [ ] 组件目录的文件系统监听（手工往目录里拷文件时也能自动刷新；拖放安装已经能用了）
- [ ] 每实例配置：清单声明 schema → 属性面板自动渲染表单
- [ ] 开机自启、单实例锁

## v0.4 —— 开发体验

- [ ] `@lattice/sdk` —— 把桥客户端、主题同步、类型定义封成包
- [ ] `create-lattice-widget` 脚手架
- [ ] 组件打包工具：目录 → `.lattice`（zip）
- [ ] 媒体控制权限（SMTC）
- [ ] 组件调试面板：实时日志、桥调用追踪

## v0.5 —— 分发

- [ ] 组件商店：远程 registry 索引 + 版本约束 + 签名校验
- [ ] 组件更新与回滚
- [ ] 组件评分与举报
- [ ] 权限变更提示（新版本申请了新权限时必须让用户重新确认）

## 长期要盯的风险

| 风险              | 说明                                                |
| --------------- | ------------------------------------------------- |
| **安全**          | 第三方组件是任意代码。沙箱 + 权限清单只是第一层，还要 CSP 锁定、网络白名单、签名校验    |
| **性能**          | 组件数量上去后，WebView 数量是内存杀手。需要考虑同一 WebView 内多组件，或空闲卸载 |
| **WorkerW 兼容性** | 挂桌面依赖未公开行为，Windows 大版本更新可能变。要有降级路径                |
| **组件生态冷启动**     | 平台价值取决于组件数量，早期需要官方做足够多高质量组件                       |
