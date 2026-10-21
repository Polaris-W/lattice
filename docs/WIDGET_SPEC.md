# 组件规范

写给要开发棂组件的人。看完这一页你就能写出一个能跑的组件。

## 1. 组件包结构

一个组件就是一个目录，最少两个文件：

```
my-widget/
  manifest.json     必需，清单
  index.html        必需（文件名由 manifest.entry 指定）
  ...               其余文件随意：js / css / 图片
```

不需要构建、不需要打包工具。目录丢进 `public/widgets/` 后执行 `npm run widgets:index`，平台就能发现它。

## 2. manifest.json

```json
{
  "id": "lattice.clock",
  "name": "时钟",
  "version": "0.1.0",
  "description": "大字号时钟，显示日期与时区",
  "author": "Lattice",
  "entry": "index.html",
  "size": { "w": 240, "h": 140, "minW": 160, "minH": 110 },
  "layer": "desktop",
  "permissions": ["clock", "storage"],
  "sdk": "^0.1"
}
```

| 字段 | 必需 | 默认 | 说明 |
| --- | --- | --- | --- |
| `id` | 是 | — | 反向域名风格，全局唯一。只允许小写字母、数字、`.`、`-` |
| `name` | 否 | 目录名 | 显示名 |
| `version` | 是 | — | 语义化版本 |
| `description` | 否 | `""` | 一句话说明，显示在组件库 |
| `author` | 否 | `未知作者` | |
| `entry` | 否 | `index.html` | 相对组件目录的入口 |
| `size` | 否 | `240×140` | `w/h` 初始尺寸，`minW/minH` 缩放下限 |
| `layer` | 否 | `desktop` | `desktop` 贴桌面 / `top` 置顶 |
| `permissions` | 否 | `[]` | 申请的平台权限，见下表 |
| `sdk` | 否 | `^0.1` | 依赖的 SDK 版本区间 |

清单不合法时组件不会消失，而是出现在组件库底部的「加载失败的组件」里并给出原因 —— 便于排错。

## 3. 权限

默认全拒，用户在属性面板里逐项勾选。**申请了但没被授予时，调用会返回 `permission_denied`，组件必须自己降级。**

| 权限 | 授予后可用 |
| --- | --- |
| `clock` | `clock.now` |
| `storage` | `storage.get` / `storage.set` / `storage.remove` |
| `clipboard:write` | `clipboard.write` |
| `network` | 预留（v0.3） |
| `system:monitor` | 预留（v0.3） |
| `media:control` | 预留（v0.4） |

只申请你真正用到的。申请一堆用不上的权限，用户会直接不装。

## 4. 桥 API

### 消息格式

组件 → 宿主：

```js
parent.postMessage(
  { __lattice: 1, type: "request", id: 1, method: "clock.now", params: {} },
  "*"
);
```

宿主 → 组件：

```js
{ __lattice: 1, type: "response", id: 1, ok: true, result: {...} }
{ __lattice: 1, type: "response", id: 1, ok: false, code: "permission_denied", error: "..." }
```

`id` 自增，用于把响应配回请求。**每次请求都应该设超时**，宿主无响应时不能让 UI 卡死。

### 方法表

| 方法 | 权限 | 参数 | 返回 |
| --- | --- | --- | --- |
| `clock.now` | `clock` | — | `{ now, epochMs, timeZone, utcOffsetMinutes }` |
| `storage.get` | `storage` | `{ key }` | 存进去的值，不存在返回 `null` |
| `storage.set` | `storage` | `{ key, value }` | `{ ok: true }` |
| `storage.remove` | `storage` | `{ key }` | `{ ok: true }` |
| `clipboard.write` | `clipboard:write` | `{ text }` | `{ ok: true }` |
| `theme.get` | — | — | CSS 变量字典，见下 |
| `window.close` | — | — | 关闭当前组件实例 |

### 宿主 → 组件的推送

| 消息 | 时机 | 载荷 |
| --- | --- | --- |
| `{ __lattice: 1, type: "theme", payload }` | 主题切换、组件加载完成 | CSS 变量字典 |
| `{ __lattice: 1, type: "ready" }` | 组件主动发出，表示已就绪 | 宿主收到后会立刻推一次主题 |

主题字典的键：`--lattice-bg`、`--lattice-surface`、`--lattice-text`、`--lattice-text-muted`、`--lattice-border`、`--lattice-accent`、`--lattice-radius`、`--lattice-font`。

组件应当把这些值写到自己根元素的 CSS 变量上，这样明暗主题切换是零成本的。

## 5. 沙箱限制

组件跑在 `sandbox="allow-scripts"` 的 iframe 里，**没有** `allow-same-origin`。所以：

| 不能用 | 替代方案 |
| --- | --- |
| `localStorage` / `sessionStorage` | `storage.*` 桥方法 |
| `fetch()` 读自己的文件 | 用 `<link>` / `<script>` 标签加载 |
| 访问 `parent` 的 DOM 或变量 | 桥方法 |
| Cookie / IndexedDB | 暂不支持 |
| `alert` / `confirm` | 在组件内自己画 UI |

这些限制不是缺陷，是安全边界：**组件是不可信代码**，它唯一能做的事就是通过桥申请能力。

## 6. 最小示例

`manifest.json`：

```json
{
  "id": "lattice.hello",
  "name": "你好",
  "version": "0.1.0",
  "entry": "index.html",
  "size": { "w": 200, "h": 100, "minW": 120, "minH": 60 },
  "permissions": ["clock"]
}
```

`index.html`：

```html
<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <style>
      html, body { margin: 0; height: 100%; background: transparent; }
      body {
        display: grid;
        place-items: center;
        color: var(--fg, #ecebe6);
        font: 13px system-ui, "Microsoft YaHei", sans-serif;
      }
    </style>
  </head>
  <body>
    <div id="out">…</div>
    <script src="widget.js"></script>
  </body>
</html>
```

`widget.js`：

```js
let seq = 0;
const pending = new Map();

function call(method, params) {
  return new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    parent.postMessage({ __lattice: 1, type: "request", id, method, params }, "*");
    setTimeout(() => {
      if (!pending.has(id)) return;
      pending.delete(id);
      reject(new Error("超时：" + method));
    }, 3000);
  });
}

addEventListener("message", (event) => {
  const data = event.data;
  if (!data || data.__lattice !== 1) return;

  if (data.type === "theme") {
    const map = {
      "--lattice-text": "--fg",
      "--lattice-text-muted": "--muted",
      "--lattice-accent": "--accent",
      "--lattice-border": "--border",
    };
    for (const [source, target] of Object.entries(map)) {
      if (data.payload[source]) {
        document.documentElement.style.setProperty(target, data.payload[source]);
      }
    }
    return;
  }

  if (data.type !== "response") return;
  const entry = pending.get(data.id);
  if (!entry) return;
  pending.delete(data.id);
  data.ok ? entry.resolve(data.result) : entry.reject(Object.assign(new Error(data.error), { code: data.code }));
});

call("clock.now")
  .then((info) => {
    document.getElementById("out").textContent = new Date(info.epochMs).toLocaleTimeString();
  })
  .catch((error) => {
    document.getElementById("out").textContent =
      error.code === "permission_denied" ? "需要「读取系统时间」权限" : "读取失败";
  });

parent.postMessage({ __lattice: 1, type: "ready" }, "*");
```

## 7. 调试

- 组件报错不会崩平台，只会让那个组件白屏。开发时先在浏览器里跑 `npm run dev`，再用 DevTools 打开 iframe 的独立控制台。
- 清单写错时组件库底部会列出原因，先看那里。
- 桥调用全部返回 Promise，务必 `.catch()`，否则权限未授予时会静默失败。
