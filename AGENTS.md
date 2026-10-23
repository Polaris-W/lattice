# AGENTS.md —— 接手这个仓库先读这一页

写给任何要在这个仓库里改代码的人或模型。目标：读完这一页，不用通读源码就能动手，且不会踩已经踩过的坑。

> 约定：这份文件只写**稳定事实**和**判断依据**。具体的坑与解法在 [docs/ROADMAP.md](./docs/ROADMAP.md)，组件协议在 [docs/WIDGET_SPEC.md](./docs/WIDGET_SPEC.md)，取舍论证在 [docs/ARCHITECTURE.md](./docs/ARCHITECTURE.md)。三者与本文冲突时，以代码为准，并顺手修文档。

---

## 1. 这是什么

**棂 / Lattice** —— 可扩展的 Windows 桌面小组件平台。第三方用纯 HTML/CSS/JS 写组件，平台负责把它们安全地放到桌面上。

当前状态：v0.2 收尾。能装组件包（把文件夹拖进窗口）、能把组件变成真的桌面窗口、能拖能缩能锁、布局与组件数据重启不丢；第三方组件经 `lattice-widget` 协议从 `%APPDATA%` 直接加载。剩下的是 v0.3 的事，见 §8 与 [ROADMAP](./docs/ROADMAP.md)。

想先知道"为什么现在是这样"，读 [ROADMAP 的「被推翻的六个决定」](./docs/ROADMAP.md#被推翻的六个决定)——每个决定都写着当初怎么选、被什么撞翻、现在怎么补。

技术栈：Tauri 2 + React 19 + TypeScript + Vite 8 + Zustand。Rust 侧只做窗口与文件，不碰 UI。

---

## 2. 三十秒上手

```bash
npm install
npm run dev          # 只跑前端（http://localhost:1420），不需要 Rust
npm run tauri:dev    # 完整桌面应用，改 Rust 会自动重编译重启
npm run tauri:build  # 出 NSIS 安装包
npm run typecheck    # tsc --noEmit，提交前跑一下
```

**浏览器里 `isTauri()` 为 false**，所以「投放到桌面」是灰的，其余（画布、组件沙箱、桥、权限）都能验。

工具链是 `windows-gnu`，缺 `windres` / `gcc`，`scripts/tauri.mjs` 会把 `../.toolchain/mingw64/bin` 和 `../.toolchain/gcc-shim` 塞进 PATH。**不要绕过这个包装脚本直接跑 `npx tauri`**，否则编译会在 `resource.rc` 上报错。

---

## 3. 目录地图

```
src/
  App.tsx                 平台外壳：顶栏、编排、桌面窗口回传事件的处理
  main.tsx                React 入口
  styles.css              平台样式层（CSS 变量 + 语义类，不引 Tailwind）
  widgetHost.ts           桌面窗口的宿主页：装 iframe、画窗饰、处理拖拽缩放
  widgetHost.css          窗饰与缩放手柄样式
  platform/
    store.ts              Zustand + 文件落盘适配器（Placement / 授权 / 主题 / desktopRects）
    Canvas.tsx            画布：放置、空态、缺失组件占位
    WidgetFrame.tsx       画布里的一个组件实例 = 一个沙箱 iframe + 拖拽缩放
    LibraryPanel.tsx      组件库：已安装 / 可安装 / 加载失败 + 搜索过滤
    InspectorPanel.tsx    属性面板：层级、穿透、尺寸、权限授予
    SettingsMenu.tsx      设置浮层：本机档案、外观、网格吸附、关于（Ctrl+, 唤出）
    icons.tsx             16px 图标集（Glyph / ICON / ThemeGlyph / PanelGlyph / WidgetIconMark），顶栏、菜单、面板共用
    desktop.ts            Placement → WidgetWindowSpec，坐标换算，投放/收回命令
    autostart.ts          开机自启的读写与"路径漂移"判定（`Run` 注册表项）
  runtime/
    manifest.ts           清单校验与归一化；Permission 类型与中文标签（唯一真源）
    config.ts             每实例配置：清单 schema（5 类字段）、归一化、值合并
    registry.ts           组件发现：bundled（public/widgets）+ user（%APPDATA%）；入口地址解析
    bridge.ts             RPC 桥：方法表、权限闸门、平台内置方法
    appearance.ts         底板外观模型：归一化、合成色、亮度阈值
    diagnostics.ts        错误通道：认出组件报上来的错、去重指纹、挑主错误
    widget-reporter.js    注入进组件文档的上报脚本（**唯一真源**，两条发文档的路都读它）
    schedule.ts           心跳时间轴：可见性取"与"、不可见停摆、回来补一拍
    screen-fit.ts         纯几何：锚点选屏、夹紧（入参一律物理像素，`tests/screen-fit.html` 钉着）
    library-search.ts     组件库搜索：切词 + 单包命中判定（纯函数，`tests/library-search.html` 钉着）
public/widgets/           官方组件包（未安装前只是"可发现"）
examples/counter/         第三方组件的参考实现，拖进窗口即可安装
scripts/
  widget-index.mjs        生成 public/widgets/index.json
  widget-diagnostics-plugin.mjs  给内置组件注入上报脚本（dev 中间件 + build 收尾）
  widget-diagnostics.test.mjs    注入规则的单测（`npm run test:injection`）
  tauri.mjs               tauri CLI 包装（补工具链 PATH）
src-tauri/src/
  lib.rs                  命令注册、WebView2 启动参数、自定义协议注册、主窗口关闭守卫
  protocol.rs             lattice-widget:// 静态文件服务（用户组件的 HTML/CSS/JS）
  csp.rs                  组件文档的 CSP：一处生成策略，protocol.rs 只负责挂头
  egress.rs               出网闸门：WebView2 层拦帧导航，组件出不去
  network.rs              出网代理（WinHTTP）：权限 → 白名单 → 形状，三道闸
  network_policy.rs       上面那道的纯逻辑：URL 解析 + 主机白名单匹配（9 条单测）
  crash.rs                ICoreWebView2::add_ProcessFailed 胶水：认崩溃类型、记账、重载
  crash_policy.rs         上面那道的纯逻辑：何时重载 / 何时放弃（9 条单测）
  diagnostics.rs          组件坏了给人看的东西：兜底页 + 注入的错误上报脚本
  runner.rs               Placement → 真实窗口的增量同步、宿主页配置、事件回传、暂停开关
  tray.rs                 托盘图标与菜单（打开主窗口 / 暂停全部 / 退出）
  watch.rs                组件目录监听（ReadDirectoryChangesW + 300ms 静默去抖）
  watch_policy.rs         上面那道的纯逻辑：读通知缓冲区（5 条单测）
  autostart.rs            HKCU Run 注册表项：开机自启的读写与修复
  autostart_policy.rs     上面那道的纯逻辑：命令行的拼 / 剥（5 条单测）
  desktop.rs              Win32：WorkerW 挂载、HWND_BOTTOM/TOPMOST、圆角裁剪、扩展样式、底层守卫
  visibility.rs           真实可见性：从 WindowEvent::Resized 推，发 lattice:window-visible
  wallpaper.rs            截壁纸（宿主页底板的第一层）
  metrics.rs              系统指标（sysmon 组件用），直接调 Win32 不引 crate
  instance.rs             单实例：命名互斥体 + 命名事件
  state.rs                平台状态落盘（state.json，原子替换）
  widget_store.rs         组件私有存储落盘（widget-data/<id>.json）
  widgets.rs              用户组件的扫描 / 安装 / 卸载
src-tauri/installer-hooks.nsh  NSIS 钩子：卸载时删掉 Run 注册表项（只此一处）
src-tauri/capabilities/
  default.json            主窗口权限
  widget.json             组件窗口权限（widget-* 标签）
tests/                    纯逻辑与布局的浏览器断言（tests/*.html，跑在 dev server 上）
docs/                     架构、组件规范、路线图与踩坑
```

---

## 4. 十四条不变量（改代码前必读）

1. **零内置**。平台本身不含任何组件。随应用分发的包（`bundled`）必须显式"安装"（记进 `installedIds`）才可用；用户目录里的包（`user`）在磁盘上即已装。不要为了"体验好一点"让 bundled 自动可用，那会把扩展平台退化成桌面工具。

2. **两个宿主，一套桥**。画布里的 `WidgetFrame.tsx` 和桌面上的 `widgetHost.ts` 都必须走 `runtime/bridge.ts` 的同一张方法表。**任何"只在预览能用"或"只在桌面能用"的分叉都是 bug**，不是特性。

3. **鉴权靠窗口引用，不靠 origin**。沙箱 iframe 的 origin 是字符串 `"null"`，所有组件一样，`event.origin` 分不出实例。必须 `event.source === iframe.contentWindow`。

4. **权限按 `widgetId` 授予，不按实例**。语义是"你信不信任这段代码"，跟桌面上摆了几份无关。

5. **落盘不用 localStorage**。这台机器上 WebView2 把 localStorage 放内存里，进程一退就没了。所有持久化都走文件（`state.json` / `widget-data/*.json`），写入用"临时文件 + 原子替换"。

6. **底板是平台的，组件只读令牌**。颜色 / 浓度 / 磨砂由宿主页画（`wallpaper.rs` 截壁纸 + `widgetHost.ts` 三层叠），组件一行代码都不参与。所以：`html, body` 必须保持透明；组件里**不许写死颜色**，字色、强调色、描边全部取 `--lattice-text` / `--lattice-accent` / `--lattice-border` —— 底板一变浅，平台会把它们整体翻一遍，写死的值不会跟着翻。出厂外观（`auto / 1 / 0`）下平台**不覆盖任何令牌**，默认样子必须跟没有这个功能时一像素不差。

7. **错误通道不是桥**。`__lattice_diag`（组件报错）和 `__lattice`（桥请求/响应）是两条独立的消息，两个宿主都必须**先认错误、再认桥**，而且 `isWidgetErrorReport` 只认结构不认来源 —— 来源校验（`event.source === iframe.contentWindow`）在它之前做。混在一起的后果不是崩溃，是**组件能靠伪造一条"错误"骗到宿主的一次回话**，或者反过来每次加载都弹一张错误卡。改 `runtime/widget-reporter.js` 里的 `tag` 就要同步改 `runtime/diagnostics.ts` 的 `REPORT_TAG`，`tests/diagnostics.html` 钉住了这个字面量。

8. **权限是活的，不是启动快照**。用户在属性面板撤掉一项，**已经开着的窗口必须当场失去它**。两个宿主各存一份 `granted`（`widgetHost.ts` 的 `Set`、`WidgetFrame.tsx` 的 `grantedRef`），桥每次调用都读它；Rust 侧 `HostConfig.permissions` 由 `sync_widget_windows` 每轮比对，变了就 `emit_to("lattice:widget-permissions")`。四条约束：比对必须**先排序去重**（grants 数组换个顺序不等于权限变了，否则点一下开关就重载一次组件）；载荷必须带 `instanceId`（`emit_to` 是广播，见第 9 条）；宿主收到后既要换集合**也要** `reloadWidget()`（只换集合的话，组件在授权前写进界面的"权限被拒"不会自己回头）；`create()` 里登记 `HostConfig` 时也要用排好序的那份，否则新窗口第一轮同步就会误判成"变了"；画布卡片上那句 `Needs …`（`WidgetFrame` 的 `missing`）要按最新 `grants` 过滤，只在点 `Grant` 时清的话，用户改从属性面板勾回来就会一直挂着。

9. **`emit_to` 是广播，收件人自己认领**。`emit_to(label)` 听着像"只发给那个窗口"，其实不是：JS 侧 `listen()` 注册的监听器 target 是 `Any`，而 Tauri 的匹配规则是 `target == Any || filter(target)`（`event/listener.rs::match_any_or_filter`）—— **任何** emit 都会送到**每个**窗口的 `Any` 监听器上。所以凡是"发给某个窗口"的事件，载荷里都要带身份（`instanceId` 或窗口 `label`），由宿主页比一次再处理。不带的后果不是报错，是**串味**：拖 A 的底板滑杆四张卡片一起变色，撤 A 的一项权限四个组件一起重载、未落盘的草稿当场丢。`lattice:theme` 是唯一**故意**全局的（平台切明暗，所有窗口都该跟着换）。

10. **看不见就别跑**。组件的心跳一律挂在 `runtime/schedule.ts` 的时间轴上，不自己 `setInterval`。窗口不可见时整条时间轴停摆，回来只补一拍。**"不可见"有两个来源**：`document.visibilityState` 和 Rust 发来的 `lattice:window-visible` —— 前者对"窗口最小化"完全无感（实测最小化前后都是 `visible`），只盯它等于没停。加了新的"窗口状态"判断，先想清楚该不该停摆，别在组件里各写一套。

11. **关窗口 ≠ 删用户数据**。`widget_close` 收一个 `reason`，**只有 `reason == "user"`（宿主页 ✕ 按钮）才发 `lattice:widget-close` 让主窗口删 placement**；别的来路（组件自己调桥的 `window.close`、或将来任何新入口）只关窗口，实例记进 `Runner.suppressed`，本次运行不再重建。placement 是用户摆好的布局，属于用户数据；窗口只是它的一个渲染。一条命令兼两种语义的代价，是任何一次意外调用都会静默删掉用户的东西 —— 这条坑真实发生过三次。加新的"关闭"入口时，`reason` 必须显式传，不许省；`widget_close` 里那行 `eprintln!` 也不许删，它记录的正是"谁关的"。（`reason: user` 这一路仍然会真的删 —— 手滑的兜底不在这里，在 UI 侧：`removePlacement` 会把快照留在 `lastClosed` 里，主窗口底部弹 8 秒 `Undo`。所以**别在 `removePlacement` 之外的地方直接 `filter` 掉 placement**，那等于绕开撤销。）

12. **组件的 CSP 只在 `csp.rs` 里改**。组件是不可信代码，沙箱挡"碰宿主"，CSP 挡"往外发"。四条必须记住的：
    - **`'self'` 在这里是废的**。组件跑在 `sandbox="allow-scripts"` 的 iframe 里，文档源是 opaque，`'self'` 匹配不到任何东西 —— 写上等于把组件自己的 `widget.js` 也拦了，组件白屏。协议源必须显式写出来。
    - **协议源跟平台走**：Windows 是 `http://lattice-widget.localhost`，别处是 `lattice-widget://localhost`，必须和 `runtime/registry.ts::widgetSchemeBase` 一字不差。两处对不上，症状是"组件坏了"，最难查。
    - **`connect-src` 收在组件自己的 origin 上，不是 `'none'`**。组件 `fetch("./data.json")` 是正当用法；而放行自己的 origin 不构成出网通道 —— `lattice-widget://` 是只读文件服务，GET 只回这个组件自己的文件。
    - **CSP 不等于堵死**。`location.href = "https://…/?d="` 这种自我导航它管不了（没有 `navigate-to` 指令）。这道缝由 `egress.rs` 补：每个组件窗口建完立刻挂 `FrameNavigationStarting`，在导航发生前取消。**别把这条当成"以后再说的加固"** —— 它和 CSP 是一套的两半，只有 CSP 的话，组件照样能把数据拼进 URL 送出去。

13. **配置按实例，权限按组件**。`grants` 的键是 `widgetId`（问的是"你信不信任这段代码"），`configs` 的键是 `instanceId`（问的是"这一份要怎么显示"）。两者别互相借：配置挪到 `widgetId`，两个时钟就共享 12/24 小时制；权限挪到 `instanceId`，用户要为同一个组件授权两遍。**值只在 `runtime/config.ts::resolveConfig` 里合并**（缺的键补出厂值、非法值退回出厂值），Rust 只透传 —— 规则散到两边，画布和桌面就会显示得不一样。配置变化**不重载**组件（推 `config-changed`），只有权限变化才重载。

14. **联网是"按组件的白名单"，不是"有权限就能连"**。`network.fetch` 过三道闸，顺序不能换：`permissions` 里有 `network` → 目标主机在 `manifest.network.hosts` 里 → 请求形状合法（方法 / 头数 / 体积）。四条别踩回去的：
    - **没有通配符，这是故意的**。`*.example.com` 写起来方便，但它把"我允许这一个接口"变成"我允许整个域"，而这个平台的权限面板只显示一行名字 —— 用户没法审阅到底放行了什么。要多个主机就列多个。
    - **端口算身份的一部分**。`127.0.0.1:8787` 不等于 `127.0.0.1`；不写端口就是默认的 80 / 443。少了这条，"允许本机调试端口"等于"允许本机全部端口"。
    - **重定向必须关掉**（`WINHTTP_OPTION_REDIRECT_POLICY_NEVER`）。跟随 302 等于白名单失效：放行 `a.com`，`a.com` 把组件 302 到 `evil.com`，数据就出去了。现在的行为是把 302 原样当响应交回组件，由组件自己决定要不要再发一次（那时又要过一遍白名单）。
    - **走 IPC，不搭本地 HTTP 代理**。开一个 `127.0.0.1:xxxx` 的代理端口就等于给组件留了一条绕过桥的路（它 `fetch` 那个端口没人拦），而 IPC 通道只有宿主页能说话。
    这条是**加了一扇门，不是拆了别的门**：CSP（不变量 12）和 `egress.rs` 的导航拦截照旧生效，组件仍然不能自我导航把数据拼进 URL 送走。

---

## 5. 一次组件渲染，链路上有谁

```
App.tsx  placements ──► buildSpecs() ──► invoke("sync_widget_windows", { specs })
                                              │
                                    runner.rs create()
                                              │ 先登记 HostConfig，再 build()，再 show()，最后 apply_to()
                                              ▼
                            WebviewWindow(label="widget-<instanceId>", url=widget-host.html)
                                              │
                                   widgetHost.ts boot() → invoke("widget_host_config")
                                              │
                                       套一层 <iframe sandbox="allow-scripts allow-forms">
                                              │
                                     组件 postMessage 请求 ──► handleBridgeRequest()
                                              │
                                     defineMethod 的 handler（先查权限）
```

几个容易搞错的地方：

- **建窗口必须 `show()` 在 `apply_to()` 之前**。`ShowWindow` 会把窗口提到最前，顺序反了层级就白设。
- **`sync_widget_windows` / `close_widget_windows` / `widget_close` 必须是 `async fn`**。同步命令跑在主线程，而 `build()` 要把建窗口的活投递回主线程再等结果——命令占着主线程等自己，直接死锁。
- **不要维护 `Mutex<窗口表>`**。窗口存在性交给 `app.get_webview_window`；Runner 只存极轻的 `HostConfig`，且必须在 `build()` **之前**写入，宿主页随时来问都能立刻拿到。
- **同步是增量的**。`Runner::diff` 只写变化的维度（pos / size / layer）。无条件 `set_position` 会把用户正在拖的窗口拽回去。
- **同一时刻只允许一条同步在飞**。`desktop.ts` 的 `serial()` 把 `syncDesktop` / `closeDesktop` 串成一条链。两条并发跑会各自查到 `get_webview_window(label) == None`，然后各 `build()` 一次 —— 同一个实例出现两个窗口，一个归 Tauri 管、一个是孤儿（位置尺寸完全一样，看着像只有一个，其实两份 WebView2）。并发建窗口还会把 IPC 拖到超时，界面上那颗按钮从此永久变灰。
- **关主窗口 ≠ 退出**。桌面上还有组件窗口时，`lib.rs::guard_main_close` 会 `prevent_close()` + `hide()`。真正的退出是设置菜单里的 `Quit Lattice`（`quit_app`）或托盘菜单的 `Quit`。别把 `hide()` 换成 `close()`：主窗口一旦销毁，唤回它的入口就只剩托盘和单实例事件（`Local\Lattice.Wake`），少一个就是"用户只能去任务管理器"。
- **单实例靠 Win32 命名对象**（`instance.rs`）：互斥体 `Local\Lattice.Instance` 判重，事件 `Local\Lattice.Wake` 唤回。互斥体句柄**不能** `CloseHandle` —— 关掉对象就消失，下一个进程会以为自己是第一个。
- **两套坐标**。`placement.x/y` 是画布坐标，`desktopRects[instanceId]` 是屏幕坐标。投放时优先用后者。主窗口最小化后 `screenX/screenY` 是 `-32000` 这类哨兵值，`desktop.ts` 里有缓存兜底，别删。
- **宿主页是三层，不是一层**。`canvas`（壁纸，`filter: blur`）在 z=0，`veil`（底色 rgba）在 z=1，`iframe`（组件）在 z=2，内描边在 `body::after`（z=5）。往宿主页加任何全屏元素之前先想清楚它该落在哪一层 —— 内描边当初就因为画在 `body` 上被壁纸层盖掉了。
- **外观变更走 `Appearance` 这一个字段**，有两条路，别再加第三条：`widget_set_appearance` 是拖滑杆时的即时通道（面板直接推给那个窗口），`sync_widget_windows` 是兜底（新窗口、重启、画布上还没投放的实例）。两者都经过 `Runner::set_appearance`，它只在真的变了才 `emit`，所以同一次改动被两条路各推一遍也不会把宿主页刷两遍。
- **入口地址是算好的绝对地址，下游不要再拼**。`registry.ts::resolveEntryUrl` 负责分流：`bundled` → `<应用源>/widgets/<id>/<entry>`，`user` → `http://lattice-widget.localhost/<id>/<entry>`。`buildSpecs` 原样塞进 spec，宿主页拿到什么就 `iframe.src` 什么。以前宿主页自己 `base + entry`，接上用户组件后必然拼错。
- **组件存储是"落盘 + 广播"两件事**。Rust 每次写完 `widget_store_*` 都 `emit("lattice:widget-store")`，两个宿主（`WidgetFrame.tsx` / `widgetHost.ts`）把它转成 `{ type: "store-changed", payload: { key } }` 推给 iframe，组件收到重读。少了广播，画布和桌面的两个实例就各持一份内存列表，谁后写谁把对方的新增整块抹掉 —— 用户看到的是"加了几条，回头只剩一条"。新增写存储的组件必须处理这条推送（写法见 WIDGET_SPEC）。**覆盖前一定经过 `write_atomic`**：它先留一代 `.bak` 再原子替换，所以别在别处直接 `fs::write` 这个文件 —— 绕过它就没有退路（这条是拿用户的便签和待办换来的）。

### 用户组件是怎么被加载的

```
registry.ts  entryUrl = http://lattice-widget.localhost/<id>/index.html
     │
     ├─ 画布：WidgetFrame 的 <iframe src>
     └─ 桌面：spec.entry → HostConfig.entry → widgetHost.ts 的 <iframe src>
                        │
                protocol.rs::handle()
                        │  uri.path() = "/<id>/<相对路径>"
                        ▼
        %APPDATA%\com.iron-tom.lattice\widgets\<id>\<相对路径>
```

三条硬约束：

- **Windows 上必须用 `http://<scheme>.localhost/`**，不是 `<scheme>://localhost/`。写错不会报错，只是白屏。
- **协议只认 `uri.path()`**，不看 host；`split_path` 的第一段就是组件 id，任何 `..` / 盘符 / 反斜杠都 404。别为了"支持绝对路径"放宽这条 —— 那等于让组件读整个磁盘。
- **响应带 `Access-Control-Allow-Origin: *`**。iframe 是 opaque 源，组件 `fetch` 自己的 json 在浏览器看来就是跨域，不带这个头会静默失败。

---

## 6. 状态都在哪

| 东西 | 位置 | 谁写 |
| --- | --- | --- |
| 摆放、已安装、授权、主题、网格吸附、本机档案、桌面矩形 | `%APPDATA%\com.iron-tom.lattice\state.json` | `store.ts` → `state_write` |
| 组件私有数据 | `%APPDATA%\com.iron-tom.lattice\widget-data\<widgetId>.json` | `bridge.ts` → `widget_store_write` |
| 用户安装的组件 | `%APPDATA%\com.iron-tom.lattice\widgets\<id>\` | `widgets.rs` |
| 内置组件 | `public/widgets/<id>/` + 构建期生成的 `index.json` | `scripts/widget-index.mjs` |

`store.ts` 里有一个 `hydrated` 闸门：**水合完成前不许写盘**。读状态是异步的，中间任何一次 set 都会把默认空状态盖到磁盘上。加新的持久化字段时，记得同时改 `partialize`，否则重启就丢。

`profile`（本机档案）不是账号系统：平台没有服务端，登录只是把昵称/邮箱写进同一份 `state.json`，用于界面上的称呼。**不要**把它当成身份或权限依据 —— 组件授权看的是 `grants`，与是否登录无关。真要做多设备同步时，换掉 `store.ts` 里的 `signIn` / `signOut` 即可，`SettingsMenu.tsx` 不用动。

---

## 7. 常见改动的配方

### 加一个桥方法

1. 需要新权限 → `runtime/manifest.ts` 的 `Permission` 联合类型、`normalizePermissions` 的白名单、`PERMISSION_LABELS`
2. `runtime/bridge.ts` 里 `defineMethod("ns.method", "permission-or-null", handler)`；参数校验失败抛 `BridgeError("bad_params", ...)`
3. 要碰系统/文件 → 写 Rust 命令，注册进 `lib.rs` 的 `invoke_handler`
4. `docs/WIDGET_SPEC.md` 的方法表补一行（第三方只认这张表）
5. 权限未授予时**返回结构化错误**，不要抛异常——组件要能降级

### 加一项组件配置

1. 清单里写 `config`（`runtime/config.ts` 的 `ConfigField` 是唯一真源，5 类：`toggle` / `number` / `text` / `select` / `date`）。**不要**为它加平台状态字段，也别让组件自己画设置 UI
2. 组件里 `config.get` 读一次 + 处理 `config-changed` 推送（WIDGET_SPEC §2.3）。两件事都要做：只读一次的话，用户拨开关组件不会动
3. 要加新的**字段类型**才需要动三处：`ConfigField` 联合类型、`normalizeConfig` 的 `switch`、`InspectorPanel` 的 `ConfigControl`。顺手补 `tests/config.html` —— 它钉住"坏字段丢弃 / 非法值退回出厂 / 未知键不外泄"
4. 属性面板、画布、桌面三条路都读 `resolveConfig`，不要在别处自己补默认值

### 加一个平台状态字段

1. `store.ts`：interface + 初始值 + action
2. `partialize` 里加上（不加 = 不持久化）
3. 运行态要用的话，一路加下去：`buildSpecs` → `WidgetWindowSpec`（TS）→ `WidgetWindowSpec`（Rust）→ `HostConfig` → **`Applied`**

第 3 步最后那个 `Applied` 最容易漏。`Applied` 是"已经写进 Win32 的状态"，不在里面的字段永远不会触发窗口更新——撤销权限对已打开的桌面窗口无效，就是这么来的。

### 改三栏布局

`App.tsx` 的 `<main class="lattice-main">` 是个三列 grid：组件库 280 / 画布 1fr / 属性 320。收起态是 `is-left-collapsed` / `is-right-collapsed` 两个修饰类，把那一列压成 40px 竖条（按钮还在，随时能拉开）。改这块要连着看三处：

- 40px 得容得下 `.lattice-icon-btn.is-large`（30px），别收得比按钮还窄
- `.lattice-panel` 上的 `overflow: hidden` 不能删：列宽动画中间列会比内容窄，删了卡片会溢到画布上
- `nextFreeSlot` 按画布**实际宽度**换行，收起面板后画布变宽是预期行为 —— 不要为了"位置稳定"给画布设 min-width

### 加一个官方组件

```
public/widgets/<id>/
  manifest.json    id 必须是反向域名、version 是语义化版本
  index.html       入口，文件名与 manifest.entry 一致
  icon.svg         图标（manifest.icon 指过来）；16×16 视框、1.4 描边
  widget.js        自己写 call()/主题映射（参考 lattice.todo）
  style.css
```

然后 `npm run widgets:index`（`dev` / `build` 会自动跑）。注意：

- **图标只当形状用**：平台拿它当 CSS 遮罩、用 `currentColor` 上色，所以 SVG 里 `fill` 写什么色都行，深色浅色自动对。也因此**永远不要**把组件的 SVG 内容直接塞进主窗口的 DOM（第三方内容，`<script>` 会跟着跑），只让它以图片身份参与遮罩。
- **不要用原生表单控件**。沙箱文档的 `color-scheme` 被强制成 `normal`，原生 checkbox/radio 会按浅色主题画，在深色卡片上几乎看不见。用 `appearance: none` 自绘。
- **"整行可拖"和"整行可点"必须分得开**。`lattice.todo` 的行既能拖起来排序，又能点一下勾掉：判据是 4px 阈值，且抬手后浏览器补的那次 `click` 要吃掉（`suppressClick` 用 `setTimeout(..., 0)` 复位 —— click 在它之前同步派发）。别用 HTML5 拖放：沙箱是不透明源，跨文档的 `dataTransfer` 靠不住；自己算还能控制让位动画。
- **要定时器就用 `schedule.every`，不要 `setInterval`**。组件里开定时器等于绕开平台的"不可见就停摆"（不变量 10）。`schedule.every({ every: 1000 })` 拿一个订阅号，`tick` 消息里带着它，认准自己那一条再刷新；组件卸载 / 重载时 `schedule.clear(id)`。第一次要立刻显示的话（速率类指标靠两次采样做差）在 `every()` 之后自己先调一次数据方法建基线 —— Rust 侧第一次采样一定返回 0，那是设计，不是 bug。
- **卡片顶上给窗饰让位**。桌面窗口右上角那排按钮浮在组件内容之上且**能点**，通栏的输入框 / 第一行文字会被它压住。标题栏留出 `padding-right: 96px`（待办）或顶上一条 24px 状态条（便签），见 WIDGET_SPEC §5.1。
- **组件拿不到 `localStorage`、读不到 `parent` 的 DOM，一切能力走桥。**
- **组件里所有颜色从 `--lattice-*` 变量来，别硬编码明暗。**
- **要用户调的参数写进清单的 `config`，别在卡片里画设置 UI。** 卡片只有 240×140，而且组件自己的存储是按 `widgetId` 的 —— 两个实例会共享同一份偏好。属性面板按实例渲染，那才是用户期望的粒度（见下面的配方）。

### 试第三方组件 / 改安装链路

`examples/counter` 就是现成的样本（计数器，用 `storage` 权限）。把它整个目录拖进应用窗口即可安装，改完再拖一次会覆盖旧版本（`install_widget` 先删后拷）。要换样本就照着它的四个文件改，`id` 必须与目录名一致。

安装这条路只有三个环节，出问题按顺序查：

1. `App.tsx::installFromPaths` —— webview 的 `onDragDropEvent` 给的是真实路径，直接丢给 `install_widget`
2. `widgets.rs::install_widget` —— 校验 id、删旧目录、递归复制
3. `registry.ts::loadRegistry` —— 重新扫描，`source === "user"` 的包自动算已安装

### 改窗口行为

都在 `src-tauri/src/desktop.rs`：扩展样式（`WS_EX_NOACTIVATE` / `TOOLWINDOW` / `LAYERED|TRANSPARENT`）、WorkerW 挂载、`SetWindowRgn` 圆角。圆角半径 `CORNER_RADIUS = 12`，和画布 `.lattice-widget` 对齐。

**"能不能打字"由清单的 `interactive` 决定，不要按组件名硬编码。** `interactive: true`（默认）的组件不挂 WorkerW、去掉 `WS_EX_NOACTIVATE`、压到 `HWND_BOTTOM`，并且挂一个**底层守卫**（子类化拦 `WM_WINDOWPOSCHANGING`，给"往上提"的请求加上 `SWP_NOZORDER` —— 原地不动）。守卫是关键：Windows 激活窗口时会顺手把它提到最前，点一下便签它就窜到浏览器上面、切走再掉回去 —— 一进一出就是"闪来闪去"。拦掉 z 序不影响激活，键盘照样进得来（实测：窗口不动、`SendInput` 的字符照样落进 textarea 并落盘）。改了这块要同时看三处：`desktop::apply` / `desktop::set_sink` / `install_guard`、`manifest.ts` 的归一化、以及 `apply_to` 里的线程与顺序问题（见下）。

**"窗口看不看得见"由 `visibility.rs` 说，不由 `document.visibilityState` 说。** 主窗口最小化之后 `visibilityState` 仍然是 `visible`（实测），所以可见性从 Rust 观测、按窗口下发 `lattice:window-visible`。触发点有两个，**少一个就会出现"最小化能停、收起不能停"**：`WindowEvent::Resized`（最小化/还原在 Windows 上都是 `WM_SIZE`）+ `hide()` / `show()` 之后显式 `sync()`（这两条不动尺寸，不触发 Resized）。`sync()` 自己按 label 去重，只在**变化**时发 —— 拖边缩放会连着触发几十次 Resized，每次都发等于让组件把心跳重排几十遍。载荷带 `label`，因为 `emit_to` 是广播（不变量 9）。

**页面这边还得自己拉一次初始状态。** 事件是"变了才发"，而页面可能是在窗口**已经**最小化之后才加载的（热更新、权限变更重载、改完 Rust 重启），那一次变化早就过去了。所以 `hookWindowVisibility` 在订阅之后补一句 `isMinimized()`，把初始状态对齐 —— 少了它，热更新一次就要等用户再最小化一遍才会重新停摆。

**守卫是"开关 + 子类化"两件事，顺序不能反。** 开关是一个窗口属性（`set_sink`，任意线程可同步翻转），子类化只能回窗口线程装（`install_guard`，跨线程会静默返回 0）。`apply_to` 里必须**先翻开关再落层级**：否则切"置顶"那一下的 `HWND_TOPMOST` 会被还活着的守卫吃掉，组件永远上不去。

**不要加 `--disable-gpu-compositing`**，它会关掉 DirectComposition，WebView2 建不出来（`HRESULT 0x8007139F`）。GPU 相关的启动参数在 `lib.rs`，用 `LATTICE_GPU=1` 可以恢复默认。

---

## 8. 已知缺口（改之前先看这里，别当成 bug 修一半）

| 缺口 | 影响 | 需要的动作 |
| --- | --- | --- |
| **底板透不出后面的窗口** | 磨砂层是"壁纸"，不是"压在组件后面的浏览器窗口"——系统的模糊半径写死，做不成滑杆，二者只能选一个 | 要么接受，要么换 `SetWindowCompositionAttribute` 并放弃连续滑杆（见 ROADMAP 被推翻的决定 7） |
| **动态壁纸会滞后** | 截图有 2s 缓存，壁纸幻灯片 / Wallpaper Engine 最多晚 2 秒 | 换成壁纸变更通知（`SystemEvents`）后主动失效缓存 |
| **画布预览只是近似** | 画布没有壁纸可采样，只用 `color-mix` 算"底色盖在主题底色上"的合成色，模糊完全看不出来 | 要看得准只能投放出去；别试图在画布里模拟模糊 |
| **被别的窗口挡住时照跑** | 可见性只认"最小化 / 收起"两种状态，挡在浏览器后面不算 —— 组件的定时器还在跳。系统监控这种每 1 秒采一次的组件，被挡住时仍在花 CPU | 要么接 `IsWindowVisible` 之外的遮挡查询（`DwmGetWindowAttribute` 的 cloak / occlusion 位，行为随系统版本变），要么给组件一个"降低频率"的档位。别指望 `IntersectionObserver`：沙箱 iframe 里的可见性由父文档决定，拿不到窗口遮挡 |
| **`widget_close` 会莫名其妙被调** | 开发期撞到过**三次**"卡片自己没了、桌面窗口也没了"。加了 `reason` + 日志后抓到：都是 `reason: user`，宿主页里那层鼠标探针也抓到 `isTrusted: true` 的 `mousedown`，落点正是那颗 22×22 的 ✕ 中心 —— 是**真输入**，不是代码派发。但**不是人**：有一轮在没人碰鼠标的几分钟里，四个窗口各发了一条。干净环境盯 70 秒又一次都不来。所以这条坑没结：`✕` 的 click 有个还没找到的派发方 | **架构上的毛病已修**（第 11 条不变量）：非 `user` 来路只关窗口不删 placement；`reason: user` 这一路仍然会删，但**已经可撤销**（`lastClosed` + 8 秒 Undo 条）。剩下的线索：`widget_close` 现在会打出点击特征，实测一次真点击是 `trusted detail=1 pointer=mouse at=140,20`，和那几次的 `(203,15)`（220 宽窗口 ✕ 的中心）同形；而窗饰透明时点击会被手滑保护丢掉 —— 所以那几次**窗饰是可见的、指针就停在组件窗口上**。下一步是查"指针停在组件窗口上时，系统为什么把别处的点击投给了它" |
| **CSP 只盖用户组件** | 内置组件走前端资源管线、拿不到 CSP 头（它们随二进制分发，信任级别和平台本体一样）。同一份代码装成内置和装进用户目录，**联网**行为不一样 —— 错误上报不在此列，那条已经两条路都注入了 | 要么让内置组件也走 `lattice-widget://`，要么接受这个不对称 —— 已经在 `docs/WIDGET_SPEC.md` 5.2 里对组件作者写清楚了。别在宿主页想办法补，头只能在发文档的那一端加 |
| **混合 DPI 只验了一半** | 夹紧链路已改成全程物理像素，但**这台机器两块屏都是 96 DPI**（1728×1080 ×2），"跨到不同缩放的屏"这条路径只走了代码、没走过真机 | 找一台接 4K 屏（150% 或 175%）的机器，把组件拖过去再拖回来，看锚点是不是还跟着指针；`screen-fit.ts` 的纯几何部分已经被 `tests/screen-fit.html` 钉住，要补的是 `widgetHost.ts` 里那几处 `scaleFactor()` 重取 |

已修（别再改回去）：**改组件文件不用再手动重载**。`watch.rs` 用 `ReadDirectoryChangesW` 盯两个根（用户组件目录 + `public/widgets`），递归，合并成一条 `lattice:widgets-changed` 发给主窗口；`widgetHost.ts` 按 `${config.widgetId}/` 前缀过滤后自己 `reloadWidget()`。四条别踩回去：**去抖按"静默 300ms"算、不是固定 300ms**（存一次盘会连出三四个事件，固定窗口会把一次保存切成两次重载，组件闪两下）；**必须有 `MAX_HOLD` 上限（2000ms）**——一直存盘的话"静默"永远等不到，没有上限就永不触发；**安装/卸载期间要抑制**（`SUPPRESS` 那个 `AtomicBool` + `Suppress` RAII），装一个组件是几十个文件的批量拷贝，不抑制就是十几次重载；**只重载受影响的组件**，别的组件跟着刷新等于把用户正在打的字清掉。

已修（别再改回去）：**有托盘了**。`tray.rs` 三项：打开主窗口 / 暂停全部组件 / 退出，左键单击直接唤回主窗口（`show_menu_on_left_click(false)`）。两条：**托盘菜单和设置菜单必须走同一组命令**（`toggle_paused` / `instance::show_main` / `app.exit`），各写一套的话两边状态会飘——托盘说"Resume"、设置菜单里那个勾却是空的；**暂停项的文案要跟着 `widgets_paused` 走**，每次点击后重新 `set_text`，别只在建菜单时写一次。

已修（别再改回去）：**开机自启**。`autostart.rs` 读写 HKCU 的 `Run` 值 `Lattice`，写入时命令带引号（`"<exe>"`），卸载由 `installer-hooks.nsh` 的 `NSIS_HOOK_PREUNINSTALL` 删掉。三条：**只修不建**——`reconcile()` 只在"用户已经开过"且路径漂移时改写，别让它顺手把没开的项打开；**只在 release 构建里修**，dev 的 exe 路径每次编译都变，改了就变成"开机启动一个已经不存在的调试版"；**设置菜单要显示"路径已失效"**（`isStaleTarget()`），否则用户看到勾是亮的、开机却没反应，只能自己去翻注册表。

已修（别再改回去）：**暂停 = 把窗口藏起来**，不是停掉调度器。`Runner.paused` 是 `AtomicBool`，`apply_pause` 遍历所有 `widget-` 窗口 `hide()` / `show()`，新建窗口时如果处于暂停态就直接建成隐藏的。之所以不"只停调度器"：组件仍然在画、仍然在跑自己的 `requestAnimationFrame`，用户看不到却在烧 CPU；而 `hide()` 顺带把 `document.visibilityState` 翻成 `hidden`，调度器那条链路（不变量 10）自动跟着停，不用再写一套。**`show()` 会把窗口提到最前**，恢复之后要补一次 `apply_to()` 把层级落回去，否则置底的组件会跳到所有窗口前面。

已修（别再改回去）：**渲染进程崩了能自己回来**。`crash.rs` 挂 `add_ProcessFailed`，`crash_policy.rs` 决定"重载还是放弃"：只有 `render` / `gpu` 两种类型重载，`browser` 直接放弃（那是整个 WebView2 进程，重载只会原地再崩），其余类型只上报一次。三条：**重载要在另一个线程上、延 120ms**——在崩溃回调里同步重建窗口会把 WebView2 卡死；**必须记账限流**（60 秒窗口内最多 3 次），否则一个必崩的组件会变成每秒一次的重载风暴，CPU 打满、日志刷屏；**放弃时要让用户能手动重试**（`lattice:widget-crashed` → 主窗口底部那张 `.lattice-crash` 条 → `widget_reload`），只在日志里放弃等于组件静默消失。注意这条**只管渲染进程整体挂掉**，组件里 `throw` 一个异常不走这条路（那是错误通道的事，见不变量 7）。

已修（别再改回去）：**组件可以联网了，按白名单**。`network.rs` 是 WinHTTP 出网代理，`bridge.ts` 的 `network.fetch` 进它，三道闸见不变量 14。验的时候注意 **`WinHttpSendRequest` 的 `dwHeadersLength` 收的是字符数**（注册表那几个 API 收字节数，两个不一样），传错的表现是"每个带自定义头的请求都失败、`GetLastError()` 只给 `ERROR_INVALID_PARAMETER (87)`、不带头的请求却正常"—— 这条坑让人往白名单方向查了很久。

已修（别再改回去）：**多显示器夹紧改成全程物理像素**。`screen-fit.ts` 只算几何，`widgetHost.ts` 负责取数：`availableMonitors()` 的 `position` / `size` 和 `outerPosition()` / `innerSize()` 都是物理像素，**只有指针位移是 CSS 像素**，所以拖拽时要乘当前那块屏的 `scaleFactor`，而且**跨屏那一刻要重新取**（`scaleFactor()` 变了就把基准重设一次，否则跨到 150% 的屏上指针和窗口会以 1.5 倍速分家）。真机验过：把时钟窗口推到物理 `x=-5000`，重载宿主页后落在 `x=-1834`，即第二块屏左沿 `-1728` 加 24px 边距。

已修（别再改回去）：撤销授权必须当场生效。`HostConfig.permissions` 以前只在 `create()` 写一次，宿主页的 `granted` 也是启动时建一次 —— 撤掉 `storage` 之后桌面上那个组件照样能写盘。现在 `sync_widget_windows` 每轮比对权限（**先排序去重**，否则 grants 数组换个顺序就重载一次组件），变了 `emit_to("lattice:widget-permissions")`；宿主页清空重填集合并 `reloadWidget()`。只换集合不重载是不够的：组件在授权前写进界面的"权限被拒"不会自己回头。

已修（别再改回去）：没有桥方法的权限不许出现在可勾选列表里。`PERMISSION_READY`（`runtime/manifest.ts`）是唯一的判据，`InspectorPanel` 据此禁用开关并打 `soon`，`LibraryPanel` 据此画灰色虚线标签。加一项权限时**三处一起改**：`defineMethod` 注册方法、`PERMISSION_READY` 加进去、`PERMISSION_LABELS` 补文案 —— 只改前两处，界面上会少个名字。

已修（别再改回去）：重启会把组件放回桌面。`desktopMode` 与 `restoreOnLaunch` 都落盘，`App.tsx` 在**水合完成 + 清单读到**之后才恢复（少一个条件就会拿空列表同步一次，把窗口全关掉）。恢复时**不要**顺手最小化主窗口 —— 开机就把窗口藏起来，用户会以为应用没打开。

已修（别再改回去）：同步必须串行。见 §7 那条。并发两条 `sync_widget_windows` 会建出重复窗口（其中一个是孤儿，屏幕上看不出来），还会把 IPC 拖到超时、让按钮永久变灰。`serial()` 就在 `desktop.ts` 里，别绕过它直接 `invoke`。

已修（别再改回去）：用户组件能加载了。`protocol.rs` 提供 `lattice-widget://`，`registry.ts` 按来源分流入口地址，`buildSpecs` 传绝对地址。**不要再让宿主页自己拼前缀**，也不要给协议放宽路径校验。

已修（别再改回去）：组件加载失败不再是白屏。协议层失败时按请求类型分流 —— **文档导航**（`Sec-Fetch-Dest: document` / `iframe`）拿一页可读 HTML（`diagnostics.rs`），**子资源请求**拿空 body。这条分流不能省：组件 `fetch("x.json")` 拿到 HTML 会抛一个和真实原因无关的解析错误，比空 body 更难查。`wants_document()` 里那两个 `Sec-Fetch-*` 值是浏览器生成的，组件伪造不了。

已修（别再改回去）：内置组件也上报错误。以前注入只发生在 `protocol.rs`（`lattice-widget://`），而内置组件的文件走应用自己的源，协议层碰不到 —— 官方组件抛错既不弹卡也不出兜底页。现在**上报脚本只有一份**（`src/runtime/widget-reporter.js`），两条发文档的路各自读它：Rust 侧 `diagnostics.rs` 用 `include_str!` 编进二进制，前端侧 `scripts/widget-diagnostics-plugin.mjs` 在 dev 中间件和 `build` 收尾（`closeBundle`，必须排在 public 目录拷贝之后）各注一次。三处别踩回去：**改上报逻辑只改那个 .js**，两边各写一份必然漂；**两条路压行方式必须一致**（按行 trim 再用空格连成一行，末尾也 trim，否则字节不同、行号偏移对不上）；**`.html` 的守卫不能放宽**，`manifest.json` 被注一段脚本就整包废了。`npm run test:injection` 用和 Rust 单测同一批 fixture 钉住插入点。

已修（别再改回去）：注入的上报脚本必须**压成一行**。`event.lineno` 数的是文档里的行，注入多占一行，组件里所有内联脚本的行号就整体错位（真撞到过：第 15 行抛的错报成 `index.html:67:25`）。`snippet()` 负责压行，`reporter_source_has_no_line_comments` 这条单测保证源码里没有 `//`（压成一行时它会把后面全注释掉）。

已修（别再改回去）：组件不能把自己导航出去。`egress.rs` 在每个组件窗口建完后挂 `FrameNavigationStarting` + `NavigationStarting`，导航发生前取消。三条别踩回去：**宿主源从配置算、不要从 `window.url()` 取**（`build()` 返回时窗口还是 `about:blank`，第一版就是这么静默失效的）；**`webview2-com` 的版本必须和 tauri/wry 一致**（差一个次版本就是两个不兼容的 crate）；**前缀比较要防 `localhost:1420.evil.com`**。拦下来必须留一行 `egress blocked` —— 不然"组件突然不联网了"没法查。

已修（别再改回去）：组件不能往任意地址发数据了。`csp.rs` 一处生成策略，`protocol.rs` **只在 HTML 文档上挂头**（子资源响应上的 CSP 浏览器一律忽略，发给 `.js`/`.css` 只是白占字节）。三个坑都写在 `csp.rs` 的模块注释里，改之前先读：`'self'` 对 opaque origin 无效；协议源必须和 `widgetSchemeBase` 一致；`connect-src` 要放行组件自己的 origin 而不是 `'none'`。**别把策略散到调用点去拼字符串** —— 一份策略一处生成，才可能被单测钉住。

已修（别再改回去）：卸载组件要连 `placements` 一起清。只删 `installedIds` 会留下一个指向不存在组件的幽灵实例 —— 计数多一个，画不出来也点不到，只能手改 `state.json` 才能收拾。

已修（别再改回去）：拖动/缩放都要过 `clampAnchor`。不夹的话组件能被拖到屏幕外，右上角那颗按钮跟着出界，用户再也没有着力点把它拉回来。**不要改成"限制整个窗口在屏幕内"**：半截悬在边上是很正常的用法，只保证锚点抓得住就够了。

已修（别再改回去）：窗口最小化之后组件的心跳必须停。`document.visibilityState` 对最小化无感（实测最小化前后都是 `visible`），所以 `visibility.rs` 从 `WindowEvent::Resized` 推真实可见性、发 `lattice:window-visible`，调度器把它和 `visibilityState` 取"与"。**两个触发点缺一不可**：`hide()` / `show()` 不改尺寸、不触发 Resized，得在 `guard_main_close` 和 `instance::show_main` 里显式 `sync()`。真机验过：主窗口最小化 3.2 秒，画布那份 sysmon 0 拍、桌面那份 3 拍（说明只停了该停的那个）；还原后 1.2 秒 2 拍（补一拍 + 正常一拍）。

已修（别再改回去）：按窗口发的事件，载荷里必须带身份。`emit_to(label)` 实际是广播（不变量 9），所以 `lattice:appearance` / `lattice:widget-permissions` 带 `instanceId`、`lattice:window-visible` 带窗口 `label`，宿主页比对后才处理。加新事件时照这个来 —— 不带身份的后果是"改一个、变一片"，而且不会报错。

已修（别再改回去）：同一组件的多个实例靠 `store-changed` 收敛，不要退回成"每个实例自己缓存一份列表"。那正是"待办只剩一条"的成因。

已修（别再改回去）：组件存储改成**键级原子写 + 读不缓存**。`bridge.ts` 不再持有 `storeCache`，`storage.set` 走 Rust 的 `widget_store_update`（进程内加锁读-改-写）。任何"为了省 IPC 加回一层缓存"的改动，都会重新引入"桌面写的内容被主窗口的旧 map 覆盖"。

已修（别再改回去）：桌面组件能打字了。以前所有桌面窗口都是 `WS_EX_NOACTIVATE` + WorkerW 子窗口，键盘事件进不来。现在按 `manifest.interactive` 分流（见 §7），可输入的窗口压在最底层并挂上底层守卫 —— 点它不会窜到别的窗口前面，也不会在失焦时掉回去，所以不闪。**不要再加"失焦回沉"那套逻辑**：守卫已经保证它一直在最底层，回沉只会多一次 `SetWindowPos`，白白让 z 序抖一下。

已修（别再改回去）：属性面板改尺寸要**同时写 `placement` 和 `desktopRects`**。`buildSpecs` 优先用 `desktopRects` 里的尺寸（那是用户拖边缘改过的真实值），只写 `placement` 的话，已经投放到桌面的组件不会变。

已修（别再改回去）：iframe 的沙箱必须带 `allow-forms`。少了这一位，浏览器会把表单提交整条拦掉 —— `submit` 事件不触发、控制台不报错，组件里"输入框 + 回车"这种最普通的写法静默失效（待办清单就这么空转了一整版：字打得进去，回车没反应，列表永远是"Nothing here yet"）。`tests/todo-add.html` 钉住了这件事：同一条提交路径，有 `allow-forms` 就写盘，没有就 0 次写盘。改沙箱属性时两处一起改：`src/widgetHost.ts`（桌面窗口）和 `src/platform/WidgetFrame.tsx`（画布）。

已修（别再改回去）：右上角那块地方要让给窗饰。桌面窗口的功能图标浮在 `top: 6px; right: 6px`，大约 120×28（五颗按钮），鼠标一进卡片就淡入，而且**真的能点**。组件把输入框、按钮、可点列表项摆在那儿，用户点下去点到的是"收回"。待办清单的解法是顶部先放一条 22px 标题栏（`padding-right: 120px`），窗饰正好落在标题栏右端。新组件照抄这条，或者整块内容避开右上角。**给窗饰加按钮时，两个组件的 `padding-right` 和 `tests/note-layout.html` 的 `PILL_WIDTH` 要一起加**，否则正文又被压住。

同一条规矩还有个"看不见"的版本：**正文从顶上就开始排的组件**（便签）不会"点错"，而是正在写的那一行被压住 —— 打字的人手不离键盘、指针一动不动，窗饰也就不动。所以那 24px 里别留空带，放一条真信息（便签放的是保存状态）。判据是正文起点 `y ≥ 34`（窗饰下沿），`tests/note-layout.html` 直接量这个数。


---

## 9. 踩过的坑

**别在这里重复记录。** 统一写在 [docs/ROADMAP.md](./docs/ROADMAP.md) 的「踩过的坑」表里，一行一条：症状 / 真实原因 / 解法。踩到新坑就补一行，这是这个仓库最有价值的资产之一。

动手前值得先扫一眼的三条（都是"看起来像 UI bug，其实是平台机制"）：

- 卡片永远白底 → `color-scheme` 继承进了 iframe，不是 `background` 写错
- 点了「收回」窗口愣几百毫秒才消失 → `close()` 要等 WebView2 拆渲染进程，先 `hide()`
- 投放后组件跑到屏幕外 → 主窗口最小化时 `screenX/screenY` 是哨兵值

---

## 10. 代码风格

- **注释解释"为什么"，不解释"是什么"**。这个仓库的注释密度偏高，是刻意的：每个不直观的决定旁边都写了代价。改逻辑时同步改注释，过期的注释比没有注释更糟。
- **UI 文案一律英文**：界面、按钮、提示、错误信息、组件内容都算。代码注释用中文，文档用中文。
  README 分两版（`README.md` 英文、`README.zh-CN.md` 中文），`docs/` 只有中文。
  加新文案时别在中文里混英文，也别为了"亲切"把按钮写成中文——这条是被明确要求过的。
- 不引 Tailwind、不引 UI 库。平台 UI 用 CSS 变量 + 语义类；组件只认 `--lattice-*` 变量。
- 组件不需要构建步骤。**保持这一点**——"会写 HTML 就能写组件"是这个项目的门槛承诺。
- Rust 侧不 panic 到用户面前：命令返回 `Result<_, String>`，层级失败只 `eprintln!` 不中断同步。
- 新增交互前先问：这是平台该做的，还是组件该做的？窗饰（拖动/缩放/别针/收回）全部由宿主画，组件不参与。

---

## 11. 验证

- `npm run typecheck` —— 必跑，当前是干净的
- 改了组件 UI：`npm run dev` 后在浏览器里看；要截固定尺寸的图，用 Edge headless：
  ```bash
  msedge --headless=new --disable-gpu --force-device-scale-factor=2 \
    --virtual-time-budget=2000 --window-size=340,300 \
    --screenshot=out.png "http://localhost:1420/widgets/<id>/index.html"
  ```
  `--virtual-time-budget` 必须给，否则会截到 transition 的中间态。
- 改了桥 / 组件存储：`tests/bridge-storage.html` 与 `tests/note-save.html` 是自检页（`npm run dev` 后打开 `http://localhost:1420/tests/bridge-storage.html`）。前者验证并发写不丢键、跨窗口读到最新值；后者验证便签的保存顺序与载入竞态。动过存储或便签保存逻辑，先看这两个页面是不是全绿。
- 改了配置链路：`tests/config.html`（归一化、默认值、夹紧、未知键、`config.get`）。这条链路**在浏览器里就能验完**：属性面板 → store → 宿主 → 组件全在前端，只有桌面窗口那一段需要 Rust 透传。用 CDP 连画布 iframe 的 target（`type: "iframe"`）读组件里的文本，就能确认"拨一下开关，组件当场变"。
- 改了窗口行为：只能 `npm run tauri:dev` 实机看。**改 Rust 会重启应用**；`desktopMode` 与 `restoreOnLaunch` 都落盘，重启后组件窗口会自己回来（位置和数据都在），不用重新投放。
- **重启前先确认没有孤儿进程。** 杀掉 dev 任务不一定杀掉 `lattice.exe`：孤儿实例还活着时会**用它内存里的旧状态覆盖 `state.json`**（手动改文件会被它盖回去），而且它占着 WebView2 的用户数据目录，新进程会以 `HRESULT 0x800700AA "The requested resource is in use."` 在 `setup` 里 panic（表现为"改完 Rust 应用起不来了"，其实跟代码无关）。判据：`Get-Process lattice` 为空。真要改 `state.json` 就先退出应用。
- 改了协议 / 安装链路：拿 `examples/counter` 当样本 —— 拖进窗口 → 出现在「已安装」→ 放到画布 → 授权 `storage` → 点几下 → 看 `%APPDATA%\com.iron-tom.lattice\widget-data\demo.counter.json` 有没有写进去。协议本身只能在应用里探（浏览器态没有 Rust，`lattice-widget.localhost` 压根不解析）：预期真文件 200 + 正确 `Content-Type`，`..` / 大写 id / 不存在的组件全部 404。
- 改了组件库（列表 / 搜索 / 安装态）：`tests/library-search.html` 钉的是**判定规则**（空查询不筛、大小写与空白归一、多词 AND、权限名算命中、不做模糊匹配）。搜索的边界只在 `runtime/library-search.ts` 里写一份，组件里别再复制一遍 —— 复制的后果是"测试过了，界面上还是不对"。
- 改了错误通道 / 兜底页：`tests/diagnostics.html`（识别边界、两条通道不撞、去重指纹、主错误选择）。注入规则本身跑 `npm run test:injection`（9 条，`node:test`，**不需要 dev server**，fixture 和 Rust 单测是同一批：`<head>` 带属性、`<header>` 别认错、doctype 兜底、幂等、压行后行号不变、多字节安全）。Rust 那边 14 条单测在 `diagnostics.rs` 里，但**这台机器跑不了 `cargo test`**（安全策略拦 `target/debug/deps` 下新写的 exe，见 ROADMAP 坑表）。绕法：写个只有一行的壳子 `#[path = "../src-tauri/src/diagnostics.rs"] mod diagnostics;`，然后 `rustc --test 壳子.rs -o 壳子.exe && ./壳子.exe` —— 断言还是模块里那一份，不复制。
- 改了内置组件的注入：**两条路都要看**。dev 下 `curl -s http://localhost:1420/widgets/lattice.clock/index.html | grep -c 'data-lattice="diagnostics"'` 应该是 `1`（不是 `2`：中间件要幂等，否则 vite 自己把 `public/` 也注一遍就重了）；`npm run build` 之后再看 `dist/widgets/*/index.html`，构建日志末尾会有一行 `[lattice] 错误上报已注入 N 份内置组件文档`，`N` 要等于内置组件个数。**行数也要对**：`wc -l dist/widgets/<id>/index.html` 必须和 `public/widgets/<id>/index.html` 一样多，多一行就是压行失效、行号全错。
- **驱动真机 UI**：键盘事件能进 WebView2（`SetForegroundWindow` 之后发 `Ctrl+R` 能刷新、往输入框打字能落盘）；`mouse_event` 的点击**在宿主页的窗饰和错误卡上是生效的**（重载按钮就是这么验的），只是要先 `SetCursorPos` 再等 200–400ms —— 窗饰是 `body:hover` 才淡入的，移过去立刻点会点在还没出现的按钮上。往组件 iframe 里点则不可靠。
- **CDP 连真机是可行的**，而且比"看截图猜"靠谱得多：
  ```bash
  WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS="--in-process-gpu --remote-debugging-port=9333" npm run tauri:dev
  curl -s http://127.0.0.1:9333/json/list
  ```
  关键在 `lib.rs` 只在环境变量**没设过**的时候才注入 `--in-process-gpu`，所以自己设一份就整个覆盖掉了（以前这里写着"对 Tauri 无效"，是错的）。三个要点：组件 iframe 在列表里是 `type: "iframe"`，不是 `"page"`；画布那份和桌面那份 URL 一样，用 `window.outerWidth` 区分（画布那份等于主窗口宽度）；`public/` 下的 `widget.js` / `style.css` 改完，vite 会给新文档，但**同一个 iframe 里 `Page.navigate` 到同一 URL 不会重新拉模块**，得带个 `?__bust=<ts>`。
  最小化 / 还原可以直接在主窗口里 `invoke("plugin:window|minimize", { label: "main" })` —— capabilities 里已经开了 `core:window:allow-minimize`。
- **调宿主页（`widget-host.html`）不必启动 Tauri**：它整条启动链只有 `invoke("widget_host_config")` 一个入口依赖 Rust。用 CDP 的 `Page.addScriptToEvaluateOnNewDocument` 在页面脚本之前塞一个假的 `__TAURI_INTERNALS__`（`metadata.currentWindow.label` + `transformCallback` + `invoke`，`invoke` 对 `widget_host_config` 回一份固定配置、其余一律 resolve），再 `Page.navigate` 过去，页面就能在普通浏览器里跑起来。错误卡、底板、窗饰的样式都能这么调 —— 别为了看一眼卡片去重启应用。**注意这只是调 UI 的便利**：窗口真行为（置底、圆角裁剪、拖拽、点击穿透）还是只有实机能验。
- 数心跳要数**调度器的输出**，不要看界面数字（数字可能因为系统空闲而恰好不变）：在组件 iframe 里挂 `window.addEventListener("message", …)` 数 `type === "tick"`，再读一个计数器。**监听器只装一次、计数器挂在 `window.__probe` 上** —— 每次运行都 `addEventListener` 一个闭包的话，第 N 次运行就有 N 个监听器往同一个变量上加，3 拍被数成 12 拍，看着像"定时器越跑越多"，其实是被自己的探针骗了（真骗过一次）。
- **纯策略模块的单测跑法**：`cargo test` 在这台机器上跑不了（安全策略拦 `target/debug/deps` 下新写的 exe），绕法是写一个只有一行的壳子：
  ```rust
  #[path = "../src-tauri/src/network_policy.rs"] mod network_policy;
  ```
  `rustc --test 壳子.rs -o 壳子.exe && ./壳子.exe`。**这就是"纯逻辑要单独拆成一个文件"的原因 —— 拆出来才测得到**。断言只有一份（`#[cfg(test)] mod tests` 在模块内部），壳子别复制。
  能这么跑的只有不依赖 tauri / windows-sys / serde 的那几个：`diagnostics.rs`（14）、`network_policy.rs`（9）、`crash_policy.rs`（9）、`watch_policy.rs`（5）、`autostart_policy.rs`（5），共 42 条。剩下 17 条（`csp.rs` 3、`egress.rs` 3、`protocol.rs` 6、`widget_store.rs` 5）在带依赖的模块里，只有 `cargo test` 能跑，本机跑不了 —— 改动它们时靠 review 和真机验证。
  **别把纯逻辑塞回带依赖的模块里**：`watch.rs` / `autostart.rs` 的解析和拼串本来就是搬出去的，搬回去等于这 10 条断言从此没人跑。
- **CDP 选 target 必须认"完全相等"，不能只认"包含"**：主窗口是 `http://127.0.0.1:1420/`，宿主页是 `http://127.0.0.1:1420/widget-host.html` —— 后者**包含**前者的前缀，`url.includes(selector)` 会把主窗口的探针静默跑到宿主页上，返回空值也不报错（真踩过：以为桥坏了，其实是在一个已经卸载的页面上 `evaluate`）。所以先 `t.url === selector`，找不到再退到 `includes`。
- **宿主页在 CDP 里没有唯一 URL**：所有桌面窗口都是同一个 `widget-host.html`，靠 URL 分不出是谁。按 `host:<widgetId>` 取的办法是先连上每个 `widget-host.html` target，`evaluate("document.querySelector('iframe')?.getAttribute('src')")`，再按里面的组件 id 挑。想验崩溃隔离就 `Page.crash` 那个 target（组件 iframe 是 `type: "iframe"`，宿主页才是 `type: "page"`）。
- **验联网用一次性的探针组件，内容全英文**：在 `%APPDATA%\com.iron-tom.lattice\widgets\<探针id>\` 放一份 manifest（`"permissions": ["network"]` + `"network": {"hosts": ["127.0.0.1:8787"]}`）和两个文件，**别用真实组件、别填任何个人信息**。配套起一个本地服务（一个 `/ok` 回 JSON、一个 `/redirect` 302 到另一个端口），再在"另一个端口"上挂一个只要被请求就打日志的端点 —— **重定向有没有被跟随，看的是那个端点的日志，不是响应的状态码**。验完删目录、把 `state.json` 从备份还原。
- **托盘在不在，不用点菜单**：`EnumWindows` 枚举该进程的窗口，出现 `tray_icon_app` 这个类名就说明图标建成了（菜单项本身调的就是 `toggle_paused` / `show_main` / `app.exit`，那三个另有验法）。
- 抓真机窗口用 `PrintWindow(hwnd, hdc, 2 /*PW_RENDERFULLCONTENT*/)`，被别的窗口盖住也能抓到；配合 `ShowWindow(h, 4 /*SHOWNOACTIVATE*/)` 不抢用户焦点。
- 提交信息用 `feat:` / `fix:` / `docs:` / `chore:` 前缀，一句话说清"改了什么"，不写"update file"。
