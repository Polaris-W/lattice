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
    LibraryPanel.tsx      组件库：已安装 / 可安装 / 加载失败
    InspectorPanel.tsx    属性面板：层级、穿透、尺寸、权限授予
    SettingsMenu.tsx      设置浮层：本机档案、外观、网格吸附、关于（Ctrl+, 唤出）
    icons.tsx             16px 图标集（Glyph / ICON / ThemeGlyph / PanelGlyph / WidgetIconMark），顶栏、菜单、面板共用
    desktop.ts            Placement → WidgetWindowSpec，坐标换算，投放/收回命令
  runtime/
    manifest.ts           清单校验与归一化；Permission 类型与中文标签（唯一真源）
    registry.ts           组件发现：bundled（public/widgets）+ user（%APPDATA%）；入口地址解析
    bridge.ts             RPC 桥：方法表、权限闸门、平台内置方法
public/widgets/           官方组件包（未安装前只是"可发现"）
examples/counter/         第三方组件的参考实现，拖进窗口即可安装
scripts/
  widget-index.mjs        生成 public/widgets/index.json
  tauri.mjs               tauri CLI 包装（补工具链 PATH）
src-tauri/src/
  lib.rs                  命令注册、WebView2 启动参数、自定义协议注册
  protocol.rs             lattice-widget:// 静态文件服务（用户组件的 HTML/CSS/JS）
  runner.rs               Placement → 真实窗口的增量同步、宿主页配置、事件回传
  desktop.rs              Win32：WorkerW 挂载、HWND_BOTTOM/TOPMOST、圆角裁剪、扩展样式、底层守卫
  state.rs                平台状态落盘（state.json，原子替换）
  widget_store.rs         组件私有存储落盘（widget-data/<id>.json）
  widgets.rs              用户组件的扫描 / 安装 / 卸载
src-tauri/capabilities/
  default.json            主窗口权限
  widget.json             组件窗口权限（widget-* 标签）
docs/                     架构、组件规范、路线图与踩坑
```

---

## 4. 五条不变量（改代码前必读）

1. **零内置**。平台本身不含任何组件。随应用分发的包（`bundled`）必须显式"安装"（记进 `installedIds`）才可用；用户目录里的包（`user`）在磁盘上即已装。不要为了"体验好一点"让 bundled 自动可用，那会把扩展平台退化成桌面工具。

2. **两个宿主，一套桥**。画布里的 `WidgetFrame.tsx` 和桌面上的 `widgetHost.ts` 都必须走 `runtime/bridge.ts` 的同一张方法表。**任何"只在预览能用"或"只在桌面能用"的分叉都是 bug**，不是特性。

3. **鉴权靠窗口引用，不靠 origin**。沙箱 iframe 的 origin 是字符串 `"null"`，所有组件一样，`event.origin` 分不出实例。必须 `event.source === iframe.contentWindow`。

4. **权限按 `widgetId` 授予，不按实例**。语义是"你信不信任这段代码"，跟桌面上摆了几份无关。

5. **落盘不用 localStorage**。这台机器上 WebView2 把 localStorage 放内存里，进程一退就没了。所有持久化都走文件（`state.json` / `widget-data/*.json`），写入用"临时文件 + 原子替换"。

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
- **两套坐标**。`placement.x/y` 是画布坐标，`desktopRects[instanceId]` 是屏幕坐标。投放时优先用后者。主窗口最小化后 `screenX/screenY` 是 `-32000` 这类哨兵值，`desktop.ts` 里有缓存兜底，别删。
- **入口地址是算好的绝对地址，下游不要再拼**。`registry.ts::resolveEntryUrl` 负责分流：`bundled` → `<应用源>/widgets/<id>/<entry>`，`user` → `http://lattice-widget.localhost/<id>/<entry>`。`buildSpecs` 原样塞进 spec，宿主页拿到什么就 `iframe.src` 什么。以前宿主页自己 `base + entry`，接上用户组件后必然拼错。
- **组件存储是"落盘 + 广播"两件事**。Rust 每次写完 `widget_store_*` 都 `emit("lattice:widget-store")`，两个宿主（`WidgetFrame.tsx` / `widgetHost.ts`）把它转成 `{ type: "store-changed", payload: { key } }` 推给 iframe，组件收到重读。少了广播，画布和桌面的两个实例就各持一份内存列表，谁后写谁把对方的新增整块抹掉 —— 用户看到的是"加了几条，回头只剩一条"。新增写存储的组件必须处理这条推送（写法见 WIDGET_SPEC）。

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
- 组件拿不到 `localStorage`、读不到 `parent` 的 DOM，一切能力走桥。
- 组件里所有颜色从 `--lattice-*` 变量来，别硬编码明暗。

### 试第三方组件 / 改安装链路

`examples/counter` 就是现成的样本（计数器，用 `storage` 权限）。把它整个目录拖进应用窗口即可安装，改完再拖一次会覆盖旧版本（`install_widget` 先删后拷）。要换样本就照着它的四个文件改，`id` 必须与目录名一致。

安装这条路只有三个环节，出问题按顺序查：

1. `App.tsx::installFromPaths` —— webview 的 `onDragDropEvent` 给的是真实路径，直接丢给 `install_widget`
2. `widgets.rs::install_widget` —— 校验 id、删旧目录、递归复制
3. `registry.ts::loadRegistry` —— 重新扫描，`source === "user"` 的包自动算已安装

### 改窗口行为

都在 `src-tauri/src/desktop.rs`：扩展样式（`WS_EX_NOACTIVATE` / `TOOLWINDOW` / `LAYERED|TRANSPARENT`）、WorkerW 挂载、`SetWindowRgn` 圆角。圆角半径 `CORNER_RADIUS = 12`，和画布 `.lattice-widget` 对齐。

**"能不能打字"由清单的 `interactive` 决定，不要按组件名硬编码。** `interactive: true`（默认）的组件不挂 WorkerW、去掉 `WS_EX_NOACTIVATE`、压到 `HWND_BOTTOM`，并且挂一个**底层守卫**（子类化拦 `WM_WINDOWPOSCHANGING`，给"往上提"的请求加上 `SWP_NOZORDER` —— 原地不动）。守卫是关键：Windows 激活窗口时会顺手把它提到最前，点一下便签它就窜到浏览器上面、切走再掉回去 —— 一进一出就是"闪来闪去"。拦掉 z 序不影响激活，键盘照样进得来（实测：窗口不动、`SendInput` 的字符照样落进 textarea 并落盘）。改了这块要同时看三处：`desktop::apply` / `desktop::set_sink` / `install_guard`、`manifest.ts` 的归一化、以及 `apply_to` 里的线程与顺序问题（见下）。

**守卫是"开关 + 子类化"两件事，顺序不能反。** 开关是一个窗口属性（`set_sink`，任意线程可同步翻转），子类化只能回窗口线程装（`install_guard`，跨线程会静默返回 0）。`apply_to` 里必须**先翻开关再落层级**：否则切"置顶"那一下的 `HWND_TOPMOST` 会被还活着的守卫吃掉，组件永远上不去。

**不要加 `--disable-gpu-compositing`**，它会关掉 DirectComposition，WebView2 建不出来（`HRESULT 0x8007139F`）。GPU 相关的启动参数在 `lib.rs`，用 `LATTICE_GPU=1` 可以恢复默认。

---

## 8. 已知缺口（改之前先看这里，别当成 bug 修一半）

| 缺口 | 影响 | 需要的动作 |
| --- | --- | --- |
| **撤销授权不同步到已开窗口** | `Applied` 不含 permissions，宿主页的 `granted` 在 `boot()` 时固定 | 给 `Applied` 加 permissions 签名，变了就重载宿主页 |
| **没有每实例配置** | 组件想加"字号 / 显示日期 / 每页几条"只能自己画设置 UI、自己存 | 清单声明 schema，属性面板按 schema 渲染表单 |
| 组件加载失败没有兜底页 | 白屏，用户看不出是 404 还是组件自己的 JS 崩了 | 协议 404 时返回一页可读的错误 HTML；或宿主页监听 iframe 的 error |
| 无托盘、无重启恢复运行态、无 PerMonitorV2 | 重启回到设计态（刻意的，先让用户看见画布） | 见 ROADMAP v0.2 / v0.3 |

已修（别再改回去）：用户组件能加载了。`protocol.rs` 提供 `lattice-widget://`，`registry.ts` 按来源分流入口地址，`buildSpecs` 传绝对地址。**不要再让宿主页自己拼前缀**，也不要给协议放宽路径校验。

已修（别再改回去）：卸载组件要连 `placements` 一起清。只删 `installedIds` 会留下一个指向不存在组件的幽灵实例 —— 计数多一个，画不出来也点不到，只能手改 `state.json` 才能收拾。

已修（别再改回去）：拖动/缩放都要过 `clampAnchor`。不夹的话组件能被拖到屏幕外，右上角那颗按钮跟着出界，用户再也没有着力点把它拉回来。**不要改成"限制整个窗口在屏幕内"**：半截悬在边上是很正常的用法，只保证锚点抓得住就够了。

已修（别再改回去）：同一组件的多个实例靠 `store-changed` 收敛，不要退回成"每个实例自己缓存一份列表"。那正是"待办只剩一条"的成因。

已修（别再改回去）：组件存储改成**键级原子写 + 读不缓存**。`bridge.ts` 不再持有 `storeCache`，`storage.set` 走 Rust 的 `widget_store_update`（进程内加锁读-改-写）。任何"为了省 IPC 加回一层缓存"的改动，都会重新引入"桌面写的内容被主窗口的旧 map 覆盖"。

已修（别再改回去）：桌面组件能打字了。以前所有桌面窗口都是 `WS_EX_NOACTIVATE` + WorkerW 子窗口，键盘事件进不来。现在按 `manifest.interactive` 分流（见 §7），可输入的窗口压在最底层并挂上底层守卫 —— 点它不会窜到别的窗口前面，也不会在失焦时掉回去，所以不闪。**不要再加"失焦回沉"那套逻辑**：守卫已经保证它一直在最底层，回沉只会多一次 `SetWindowPos`，白白让 z 序抖一下。

已修（别再改回去）：属性面板改尺寸要**同时写 `placement` 和 `desktopRects`**。`buildSpecs` 优先用 `desktopRects` 里的尺寸（那是用户拖边缘改过的真实值），只写 `placement` 的话，已经投放到桌面的组件不会变。

已修（别再改回去）：iframe 的沙箱必须带 `allow-forms`。少了这一位，浏览器会把表单提交整条拦掉 —— `submit` 事件不触发、控制台不报错，组件里"输入框 + 回车"这种最普通的写法静默失效（待办清单就这么空转了一整版：字打得进去，回车没反应，列表永远是"Nothing here yet"）。`tests/todo-add.html` 钉住了这件事：同一条提交路径，有 `allow-forms` 就写盘，没有就 0 次写盘。改沙箱属性时两处一起改：`src/widgetHost.ts`（桌面窗口）和 `src/platform/WidgetFrame.tsx`（画布）。

已修（别再改回去）：右上角那块地方要让给窗饰。桌面窗口的功能图标浮在 `top: 6px; right: 6px`，大约 97×28，鼠标一进卡片就淡入，而且**真的能点**。组件把输入框、按钮、可点列表项摆在那儿，用户点下去点到的是"收回"。待办清单的解法是顶部先放一条 22px 标题栏（`padding-right: 96px`），窗饰正好落在标题栏右端。新组件照抄这条，或者整块内容避开右上角。

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
- 改了窗口行为：只能 `npm run tauri:dev` 实机看。注意**改 Rust 会重启应用，桌面上的组件会被收回**（`desktopMode` 不持久化），重新点一次「投放到桌面」即可，摆放和数据都在。
- 改了协议 / 安装链路：拿 `examples/counter` 当样本 —— 拖进窗口 → 出现在「已安装」→ 放到画布 → 授权 `storage` → 点几下 → 看 `%APPDATA%\com.iron-tom.lattice\widget-data\demo.counter.json` 有没有写进去。协议本身只能在应用里探（浏览器态没有 Rust，`lattice-widget.localhost` 压根不解析）：预期真文件 200 + 正确 `Content-Type`，`..` / 大写 id / 不存在的组件全部 404。
- **驱动真机 UI 用键盘，不要用合成鼠标**。`SendInput` 的键盘事件能进 WebView2（`SetForegroundWindow` 之后发 `Ctrl+R` 能刷新、往输入框打字能落盘），但 `mouse_event` 的点击进不去：悬停生效（tooltip 会弹）、click 不生效。另外 `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=…` 对 Tauri 无效（Tauri 自己设了 additional args，覆盖掉了），端口不会起来，别指望用 CDP 连真机。要验 UI 就在 `npm run dev` 的浏览器态用 CDP，真机只用来看"实际长什么样"。
- 抓真机窗口用 `PrintWindow(hwnd, hdc, 2 /*PW_RENDERFULLCONTENT*/)`，被别的窗口盖住也能抓到；配合 `ShowWindow(h, 4 /*SHOWNOACTIVATE*/)` 不抢用户焦点。
- 提交信息用 `feat:` / `fix:` / `docs:` / `chore:` 前缀，一句话说清"改了什么"，不写"update file"。
