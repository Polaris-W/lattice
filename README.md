# 棂 · Lattice

可扩展的 Windows 桌面小组件平台。第三方用 HTML / CSS / JS 写组件，平台负责把它们安全地放到桌面上。

> 棂（líng）是窗格上的木格。桌面上的每一个格子，都是一个可以自己长出来的小组件。

## 现状

v0.1 是**设计态骨架**：能扫描组件、拖到画布上摆位置、调层级与穿透、逐项授予权限，组件在沙箱 iframe 里真实运行并通过 RPC 桥调用平台能力。

还没做的：把画布上的组件变成真正的独立桌面窗口（见 [ROADMAP](./docs/ROADMAP.md)）。

## 技术栈

| 层 | 选型 | 为什么 |
| --- | --- | --- |
| 外壳 / 窗口 | Tauri 2 + `windows-sys` | 常驻应用对内存敏感；Win32 行为要直调 |
| UI | React 19 + TypeScript | 与组件生态一致 |
| 构建 | Vite 8 | 快，且与 Tauri 官方模板对齐 |
| 状态 | Zustand（带 persist） | 平台状态很浅，不需要更重的东西 |
| 样式 | 纯 CSS + CSS 变量 | 定制工作台，变量层比工具类更可控 |
| 组件运行时 | 沙箱 iframe + postMessage RPC | 见 [ARCHITECTURE](./docs/ARCHITECTURE.md) |

## 快速开始

```bash
npm install
npm run tauri:dev     # 完整桌面应用（首次要编译 Rust）
npm run dev           # 只跑前端，浏览器里调试 UI
npm run tauri:build   # 出安装包：src-tauri/target/release/bundle/nsis
```

环境要求：Node ≥ 20、Rust 工具链、WebView2（Win11 自带）。

## 目录

```
src/
  platform/          平台外壳：画布、组件库、属性面板、平台状态
  runtime/           组件运行时：manifest 校验、注册表、RPC 桥
public/widgets/      内置组件（每个目录一个组件包）
scripts/             构建辅助（生成组件索引）
src-tauri/
  src/widgets.rs     组件包扫描 / 安装 / 卸载
  src/desktop.rs     窗口层级、鼠标穿透、焦点行为（Win32）
docs/
  ARCHITECTURE.md    架构与取舍
  WIDGET_SPEC.md     组件规范（写组件看这个）
  ROADMAP.md         路线图与已知缺口
```

## 写一个组件

```
public/widgets/lattice.hello/
  manifest.json
  index.html
  widget.js
```

```json
{
  "id": "lattice.hello",
  "name": "你好",
  "version": "0.1.0",
  "entry": "index.html",
  "size": { "w": 200, "h": 100, "minW": 120, "minH": 60 },
  "layer": "desktop",
  "permissions": ["clock"]
}
```

组件里用 `parent.postMessage({ __lattice: 1, type: "request", id, method, params }, "*")` 调平台能力，完整协议见 [WIDGET_SPEC](./docs/WIDGET_SPEC.md)。改完执行 `npm run widgets:index` 让平台发现新组件。

## 许可

MIT
