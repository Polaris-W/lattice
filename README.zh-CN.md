# 棂 · Lattice

[![ci](https://github.com/unraveltao/lattice/actions/workflows/ci.yml/badge.svg)](https://github.com/unraveltao/lattice/actions/workflows/ci.yml)

[English](./README.md) · 中文

可扩展的 Windows 桌面小组件平台。第三方用 HTML / CSS / JS 写组件，平台负责把它们安全地放到桌面上。

> 棂（líng）是窗格上的木格。桌面上的每一个格子，都是一个可以自己长出来的小组件。

## 现状

v0.2 是**能真的贴到桌面上的 demo**：平台开箱是空白的，安装官方组件包后把组件摆到画布上，组件在沙箱 iframe 里真实运行，通过 RPC 桥调用平台能力，权限逐项授予。点"投放到桌面"，每个组件变成一个独立的无边框窗口，主窗口最小化退场。

落到桌面上之后，窗口能拖、能缩、能用别针锁住，布局与组件数据重启不丢。顶栏右上角是设置：明暗、网格吸附、本机档案——登录只写本地 `state.json`，不上传、不联网。

第三方组件也能用：把整个文件夹拖进窗口就装好了，文件落在 `%APPDATA%`，经 `lattice-widget` 协议加载。[`examples/counter`](./examples/counter) 是一个可以直接拖进去的样本。

两侧面板都能收成 40px 竖条，把整块画布让出来；每个组件包也可以自带图标——组件库卡片、画布标题条、属性面板画的都是它，不再是"名字首字"的色块。

现在的界面（设置菜单展开）：

![平台界面](docs/screenshot-settings.png)

## 组件真的在桌面上

![组件浮在桌面上](docs/screenshot-desktop.png)

上图是实机截图：左边被普通窗口挡住的便签是 `layer: desktop`，中间压在窗口之上的待办是 `layer: top`，右边是倒计时。

"投放到桌面"之后：

- 每个 Placement 变成一个独立的 `WebviewWindow`，加载 `widget-host.html`，再由它套一层沙箱 iframe——**桌面窗口和画布预览跑的是同一套桥、同一套权限校验**，不会出现"预览能用、桌面上不能用"的分叉
- `layer: desktop` 的组件挂到 WorkerW（拿不到时降级 `HWND_BOTTOM`），沉在普通窗口之下；`layer: top` 的走 `HWND_TOPMOST`
- 窗口无边框、不进任务栏、`WS_EX_NOACTIVATE` 不抢焦点，形状由 `SetWindowRgn` 裁成圆角
- 画布上继续拖动、改层级，桌面窗口跟着走（120ms 防抖增量同步）

## 桌面窗口能直接摆弄

![桌面组件与窗饰](docs/screenshot-chrome.png)

组件浮在桌面上之后，把鼠标移到它身上，右上角浮出一排功能图标——这些是**宿主页画的，不是组件画的**，组件完全不用操心自己怎么被搬动：

| 图标 | 做什么 |
| --- | --- |
| ⣿ 拖动 | 按住搬窗口。用 `setPointerCapture` 跟踪指针，拖出窗口甚至拖出屏幕都不会断线 |
| ↓ / ↑ 层级 | 在"贴桌面"与"置顶"之间切换，立刻作用到 Win32 的 z-order |
| ⚲ 别针 | 锁住位置与大小。锁上之后拖拽和八条缩放手柄整体禁用，光标也跟着变成默认箭头 |
| ✕ 收回 | 关掉这个窗口，并把 placement 从画布上删掉（不是藏起来） |

八向缩放手柄贴着窗口边，四个角给了 18px 的余量——窗口被裁成圆角之后，圆角弧线外侧那几个像素压根不属于这个窗口，手柄得往里让一截才点得到。

松手时窗口矩形会报回主窗口存进 `desktopRects`，**下次投放优先用它**，而不是从画布坐标重新推。

## 布局是真的记住了

平台的落盘不用 `localStorage`：这台机器上的 WebView2 把它整个放在内存里，进程一退就没了。改成显式写文件：

```
%APPDATA%\com.iron-tom.lattice\
  state.json                  摆放、已安装、授权、主题、桌面矩形
  widget-data\lattice.note.json   组件私有存储，一个包一个文件
```

写入走"临时文件 + 原子替换"，写到一半断电也不会留下半截 JSON。组件私有存储也走同一条路（`storage.get / set / remove` 三个桥方法背后是 Rust 的文件读写），所以便签里的字、待办里的勾，重启之后都还在。

## 这个项目是怎么长出来的

一天之内，从骨架到真的贴在桌面上。代码量的台阶和每次"推翻重来"都记在 [ROADMAP](./docs/ROADMAP.md) 里，这里只放结论：

| 时间 | 里程碑 | 前端 / Rust / 样式（行） |
| --- | --- | --- |
| 02:40 | 骨架：清单、桥、权限、画布 | 1 268 / 358 / 548 |
| 09:54 | 第一个能跑的 demo | 1 553 / 358 / 680 |
| 11:22 | 组件真的贴到桌面 | 1 782 / 712 / 680 |
| 12:31 | 窗饰 + 状态落盘 | 2 282 / 1 123 / 868 |
| 现在 | 用户组件协议、可输入、存储同步、设置、面板收起与组件图标 | 3 433 / 1 649 / 1 834 |

比数字更有意思的是**六个被推翻的决定**：逐像素透明做不出来、`localStorage` 不落盘、`NOACTIVATE` 让便签打不了字、宿主页拼不对用户组件的路径、两个实例各持一份列表把待办吃掉、自己维护窗口表把自己锁死。每一个都写着当初为什么这么选、被什么撞翻、现在怎么补、代价是什么。

那 28 条「踩过的坑」是同一个过程的副产品，也是这个仓库最值钱的部分——它记的是这台机器的脾气，不是通用教条。

## 平台是空白的

装好第一次打开，桌面上什么都没有——像刚装好的 VS Code 没有插件。

- **核心不含任何组件**：画布、窗口层、组件宿主、权限系统、安装卸载、组件库、设置
- **官方组件没有特权**：`public/widgets` 下的包走和第三方完全相同的 manifest、沙箱、权限桥，只是"已经在你硬盘上"，不是"编译进了内核"
- **发现 ≠ 安装**：`bundled` 来源必须显式安装；`user` 来源（`%APPDATA%` 下的包）在磁盘上就算已装

这条原则的完整论述见 [ARCHITECTURE](./docs/ARCHITECTURE.md#零内置原则)。

## 权限是看得见的

组件撞到未授权的能力时，画布上直接弹出提示，一次授予全部所需权限，组件随即重新初始化：

![权限提示](docs/screenshot-permission.png)

沙箱 iframe **不含 `allow-same-origin`**，所以组件拿到的是不透明源：读不到宿主 DOM、没有可用的 `localStorage`、发出的请求带 `Origin: null`。它除了走桥，什么都做不了。桥的鉴权用 `event.source` 比对窗口引用而非 `event.origin`——沙箱 iframe 的 origin 都是字符串 `"null"`，靠它区分不出实例。

## 技术栈

| 层       | 选型                          | 为什么                                      |
| ------- | --------------------------- | ---------------------------------------- |
| 外壳 / 窗口 | Tauri 2 + `windows-sys`     | 常驻应用对内存敏感；Win32 行为要直调                    |
| UI      | React 19 + TypeScript       | 与组件生态一致                                  |
| 构建      | Vite 8                      | 快，且与 Tauri 官方模板对齐                        |
| 状态      | Zustand + 自定义落盘适配器           | 平台状态很浅，不需要更重的东西；存储层换成文件，避开 WebView2 的 localStorage 内存化    |
| 样式      | 纯 CSS + CSS 变量              | 定制工作台，变量层比工具类更可控                         |
| 组件运行时   | 沙箱 iframe + postMessage RPC | 见 [ARCHITECTURE](./docs/ARCHITECTURE.md) |

## 快速开始

```bash
npm install
npm run dev           # 浏览器里跑 demo：http://localhost:1420
npm run tauri:dev     # 完整桌面应用（首次要编译 Rust）
npm run tauri:build   # 出安装包：src-tauri/target/release/bundle/nsis
```

环境要求：Node ≥ 20、Rust 工具链、WebView2（Win11 自带）。

> 只想看 demo 的话用 `npm run dev`，不需要 Rust。桌面端目前需要 `windres`（mingw binutils）或 MSVC 工具链，见 ROADMAP 的环境说明。

接手这个仓库（或者换个模型 / 换个人接手）先读 [AGENTS.md](./AGENTS.md)：一页纸的项目地图、五条不变量、常见改动的配方、以及"别修一半"的已知缺口。

## 目录

```
AGENTS.md            接手文档：换模型 / 换人时先读这一页
LICENSE              MIT
src/
  platform/          平台外壳：画布、组件库、属性面板、平台状态
  runtime/           组件运行时：manifest 校验、注册表、RPC 桥
public/widgets/      官方组件包（未安装前只是"可安装"）
examples/counter/    第三方组件样本（拖进窗口即安装）
tests/               自检页：桥的并发写、便签的保存竞态
scripts/             构建辅助（生成组件索引、补工具链 PATH）
src-tauri/
  src/widgets.rs     组件包扫描 / 安装 / 卸载
  src/runner.rs      运行态：Placement → 真实窗口的增量同步、窗口控件回传
  src/protocol.rs    lattice-widget:// 静态文件服务（用户组件的 HTML/CSS/JS）
  src/desktop.rs     窗口层级、圆角裁剪、鼠标穿透、焦点行为、底层守卫（Win32）
  src/state.rs       平台状态落盘（state.json，原子替换）
  src/widget_store.rs 组件私有存储落盘（widget-data/<id>.json）
docs/
  ARCHITECTURE.md    架构与取舍
  WIDGET_SPEC.md     组件规范（写组件看这个）
  ROADMAP.md         进度、迭代时间线、被推翻的决定、踩过的坑
```

## 写一个组件

```
public/widgets/lattice.hello/
  manifest.json
  index.html
  icon.svg
  widget.js
```

```json
{
  "id": "lattice.hello",
  "name": "你好",
  "version": "0.1.0",
  "entry": "index.html",
  "icon": "icon.svg",
  "size": { "w": 200, "h": 100, "minW": 120, "minH": 60 },
  "layer": "desktop",
  "permissions": ["clock"]
}
```

组件里用 `parent.postMessage({ __lattice: 1, type: "request", id, method, params }, "*")` 调平台能力，完整协议见 [WIDGET\_SPEC](./docs/WIDGET_SPEC.md)。改完执行 `npm run widgets:index` 让平台发现新组件。

**不随应用分发的组件不用改仓库**：把整个目录从资源管理器拖进棂的窗口就装好了，文件会复制到 `%APPDATA%\com.iron-tom.lattice\widgets\<id>\`，由自定义协议 `lattice-widget://` 直接加载。[`examples/counter`](./examples/counter) 是一个可以直接拖进去的样本。

## 许可

[MIT](./LICENSE)
