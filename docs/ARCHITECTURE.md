# 架构

## 一句话

一个 Rust 外壳负责 Windows 窗口行为，一个 React 前端负责平台 UI 与组件运行时，第三方组件在沙箱 iframe 里运行，只能通过一条带权限校验的 RPC 桥跟平台说话。

## 三层

```
┌─────────────────────────────────────────────────────┐
│  平台外壳（React，主窗口）                            │
│  组件库 · 画布 · 属性面板 · 平台状态（Zustand）        │
├─────────────────────────────────────────────────────┤
│  组件运行时（runtime/）                               │
│  manifest 校验 · 注册表 · RPC 桥 + 权限闸门            │
├─────────────────────────────────────────────────────┤
│  沙箱组件（iframe，opaque origin）                     │
│  第三方 HTML/CSS/JS，只能 postMessage                  │
└─────────────────────────────────────────────────────┘
        ↕ Tauri 命令                  ↕ Win32
┌─────────────────────────────────────────────────────┐
│  Rust 侧                                             │
│  widgets.rs：组件包扫描 / 安装 / 卸载                  │
│  desktop.rs：层级、穿透、焦点（WorkerW / SetWindowPos）│
└─────────────────────────────────────────────────────┘
```

## 两个状态：设计态与运行态

这是最容易混淆的地方，先定清楚：

| | 设计态（v0.1 已实现） | 运行态（v0.2） |
| --- | --- | --- |
| 宿主 | 主窗口里的一块画布 | 每个组件一个独立 WebviewWindow |
| 用途 | 摆位置、调尺寸、配层级、授权限 | 真正贴在桌面上常驻 |
| 组件渲染 | iframe | WebviewWindow 的 webview |
| 生命周期 | 跟着主窗口 | 跟着平台进程 |

v0.1 先把**运行时协议、权限模型、组件包格式**这三件事定死，因为它们改起来最贵。窗口形态换掉时这三样完全不用动。

## 组件沙箱

`<iframe sandbox="allow-scripts">` —— 关键在**没有** `allow-same-origin`。

这带来一个不透明源（opaque origin），于是：

- 读不到父窗口 DOM、`window.parent` 上的任何属性
- `localStorage` 直接抛 `SecurityError`
- `fetch` 发出去带 `Origin: null`，跨源请求会被拦
- Cookie、IndexedDB 全部不可用

结论：组件**什么都干不了，除非走桥**。这就是整个安全模型的地基。

### 桥的鉴权

```ts
window.addEventListener("message", (event) => {
  if (event.source !== iframeRef.current.contentWindow) return;  // ① 来源校验
  if (!isBridgeRequest(event.data)) return;
  handleBridgeRequest(event.data, { granted });                   // ② 权限校验
});
```

① 用**窗口引用比对**而不是 `event.origin`。因为沙箱 iframe 的 origin 是字符串 `"null"`，所有组件都长一样，靠 origin 分不出实例，也就无法阻止 A 组件冒充 B 组件。

② 权限按 `widgetId` 授予（不是按实例）。语义是"你信不信任这段代码"，跟桌面上摆了几份无关。

未授权时返回结构化错误 `{ ok: false, code: "permission_denied" }`，不是抛异常 —— 组件需要自己降级（比如不显示剪贴板按钮），而不是整个崩掉。

## 组件包

组件是**目录**，不是构建产物：

```
lattice.clock/
  manifest.json    清单（契约）
  index.html       入口
  widget.js        逻辑
  style.css        样式
```

不需要打包、不需要构建步骤。这是刻意的：扩展平台的门槛必须低到"会写 HTML 就能写组件"。等 SDK 成熟后再引入可选的构建流程。

内置组件放 `public/widgets/`，随前端资源打包；用户安装的组件放 `%APPDATA%\com.iron-tom.lattice\widgets\`。

## 数据

| 数据 | 位置 | 说明 |
| --- | --- | --- |
| 组件摆放、层级、授权、主题 | 前端 `localStorage`（key `lattice.platform.v1`） | Zustand persist |
| 组件私有数据 | 前端 `localStorage`（key `lattice.widget.store.<widgetId>:<key>`） | 由宿主代存，组件自己碰不到 localStorage |
| 用户安装的组件 | `%APPDATA%\com.iron-tom.lattice\widgets\` | Rust 管理 |

组件数据放宿主而不是组件里，是为了将来换存储后端（SQLite）时组件不用改，也避免组件之间互相看到数据。

## 窗口行为（Win32）

三层需求，逐层加码：

1. **不抢焦点** —— `WS_EX_NOACTIVATE`，点组件不打断你正在打字的窗口。
2. **不进 Alt+Tab** —— `WS_EX_TOOLWINDOW`。
3. **鼠标穿透** —— `WS_EX_LAYERED | WS_EX_TRANSPARENT`，纯展示型组件开启。

层级有两种：

- `desktop`：`SetParent` 到 WorkerW。向 `Progman` 发 `0x052C` 让它派生 WorkerW，再枚举找到挂着 `SHELLDLL_DefView` 的窗口的兄弟 WorkerW，把组件挂上去。效果是组件沉到桌面图标之上、普通窗口之下。**这是"桌面小组件"体感的关键**。
- `top`：先 `SetParent(null)` 脱离，再 `HWND_TOPMOST`。

拿不到 WorkerW 时降级为 `HWND_BOTTOM`，至少不会浮在最上层挡住内容。

## 性能预算

常驻应用，预算是硬指标：

| 指标 | 目标 |
| --- | --- |
| 空载内存 | < 80 MB |
| 空载 CPU | ≈ 0% |
| 5 个组件时 CPU | < 2% |

手段：不可见组件暂停渲染、动画走 CSS `transform/opacity`、组件定时器统一由平台调度（v0.3）。

## 已知取舍

| 决定 | 代价 | 为什么接受 |
| --- | --- | --- |
| iframe 而非独立窗口（v0.1） | 组件不能真正贴桌面 | 先把协议和权限模型定死，窗口形态是后置的机械替换 |
| 不引入 Tailwind | 手写 CSS 更长 | 定制工作台用变量层更可控，少一个构建依赖 |
| `csp: null` | 没有 CSP 兜底 | 待组件协议接入后一并锁定，避免现在就锁死导致 dev 环境难调 |
| 用户组件暂不可渲染 | 有"待接入"状态 | 需要 `lattice-widget://` 协议，见 ROADMAP 第 1 项 |
