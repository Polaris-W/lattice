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

不需要构建、不需要打包工具。

**怎么让它出现在平台里**，两条路：

| 场景 | 做法 | 文件去哪儿 |
| --- | --- | --- |
| 你改的是随应用分发的内置组件 | 目录放进 `public/widgets/`，执行 `npm run widgets:index` | 跟着前端资源打包 |
| 你写的是第三方组件 | 把**目录**从资源管理器拖进棂的窗口 | 复制到 `%APPDATA%\com.iron-tom.lattice\widgets\<id>\` |

拖进来之后平台会自己扫描、安装、出现在「已安装」里，点一下就放到画布上。安装时会校验 `id`（只允许小写字母、数字、`.`、`-`），不合法的包会被拒绝并在组件库顶部提示原因。

内置组件和用户组件的加载协议不一样，但对你透明 —— 你只管在 HTML 里写**相对路径**：

```html
<link rel="stylesheet" href="style.css" />   <!-- ✅ -->
<script src="js/app.js"></script>            <!-- ✅ -->
<img src="/assets/logo.png" />               <!-- ❌ 绝对路径会被当成别的组件的文件 -->
```

用户组件由自定义协议 `lattice-widget://` 提供，地址形如 `<协议>/<id>/<相对路径>`，第一段永远是组件自己的 id。任何试图跳出自己目录的路径（`..`、盘符）都会 404。

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
  "interactive": true,
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
| `interactive` | 否 | `true` | 要不要键盘输入。纯展示的组件设 `false`，见下 |
| `sdk` | 否 | `^0.1` | 依赖的 SDK 版本区间 |

清单不合法时组件不会消失，而是出现在组件库底部的「加载失败的组件」里并给出原因 —— 便于排错。

### `interactive`：能不能打字

贴在桌面上的窗口默认带 `WS_EX_NOACTIVATE`，还会被挂到 WorkerW 下面变成桌面的子窗口 —— 这两件事叠起来，点进去键盘事件根本进不来，笔记、待办就只能看不能写。

所以清单里 `interactive`（默认 `true`）决定走哪条路：

* `true`（默认）：不挂 WorkerW，留在顶层窗口层但压到 `HWND_BOTTOM`，并且去掉 `WS_EX_NOACTIVATE`。点一下能拿到焦点、能打字；同时挂一个"底层守卫"，点它不会窜到别的窗口前面，也不会在失焦时掉回底层 —— 换句话说，它既写得进字，又一直老老实实待在桌面层。
* `false`：挂 WorkerW、保持 `WS_EX_NOACTIVATE`，是真正的"桌面背景"，最省事也最不打扰。

**纯展示的组件（时钟、倒计时、天气）建议显式写 `false`**：少一次激活，也就不会在点桌面的时候抢焦点。


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
| `storage.set` | `storage` | `{ key, value }` | `{ ok: true }`；`value` 为 `null` 等同于删除 |
| `storage.remove` | `storage` | `{ key }` | `{ ok: true }` |
| `clipboard.write` | `clipboard:write` | `{ text }` | `{ ok: true }` |
| `theme.get` | — | — | CSS 变量字典，见下 |
| `window.close` | — | — | 关闭当前组件实例 |

**写入是键级的，不是整份覆盖。** 平台在 Rust 侧加锁做「读 → 改这一个键 → 原子替换」，所以主窗口和桌面窗口里的同一个组件同时保存时，改不同键不会互相抹掉。组件不要自己去读整份 map 再写回去 —— 那等于绕过锁，又会退回成互相覆盖。

**读永远读盘，没有内存缓存。** 同一份数据在别的窗口被改过，下一次 `storage.get` 就能看到。代价是一次 IPC，几 KB 的文件不值得为它做缓存。

**但是：光"读得到"不够，还得知道"该读了"。** 同一个组件可以在画布上有一个实例、桌面上又有一个，两份各自持一份内存副本。平台在每次落盘后广播 `store-changed`（见下），收到就重读 —— 不做这件事，后写的那份会把对方刚加的内容整块覆盖，用户看到的是"加了几条，回头只剩一条"。

### 宿主 → 组件的推送

| 消息 | 时机 | 载荷 |
| --- | --- | --- |
| `{ __lattice: 1, type: "theme", payload }` | 主题切换、组件加载完成 | CSS 变量字典 |
| `{ __lattice: 1, type: "store-changed", payload }` | 本组件的私有存储被**任意**实例写入了 | `{ key }`，`key` 为空串表示整份文件被替换 |
| `{ __lattice: 1, type: "ready" }` | 组件主动发出，表示已就绪 | 宿主收到后会立刻推一次主题 |

`store-changed` 的标准处理方式（两个示例组件都是这么写的）：

```js
if (data.type === "store-changed" && (!data.payload.key || data.payload.key === "items")) {
  // 1. 自己有没落盘的改动 / 光标在输入框里 → 本地优先，直接跳过
  // 2. 否则重读这个键，内容没变就不要重画（自己的写入也会回声过来）
  reload();
}
```

不要收到通知就立刻写回，那会变成两个实例互相触发、无限刷新。

主题字典的键：`--lattice-bg`、`--lattice-surface`、`--lattice-text`、`--lattice-text-muted`、`--lattice-border`、`--lattice-accent`、`--lattice-radius`、`--lattice-font`。

组件应当把这些值写到自己根元素的 CSS 变量上，这样明暗主题切换是零成本的。

## 5. 沙箱限制

组件跑在 `sandbox="allow-scripts allow-forms"` 的 iframe 里，**没有** `allow-same-origin`。所以：

| 不能用 | 替代方案 |
| --- | --- |
| `localStorage` / `sessionStorage` | `storage.*` 桥方法 |
| `fetch()` 读自己的文件 | 用 `<link>` / `<script>` 标签加载 |
| 访问 `parent` 的 DOM 或变量 | 桥方法 |
| Cookie / IndexedDB | 暂不支持 |
| `alert` / `confirm` | 在组件内自己画 UI |
| 原生表单控件（`checkbox` / `radio` / `select`） | 沙箱文档的 `color-scheme` 被强制成 `normal`，原生控件按**浅色**主题绘制，在深色卡片上几乎看不见。用 `appearance: none` 自绘，勾选色取 `--lattice-surface`（深色主题浅底配深勾、浅色主题深底配白勾） |

这些限制不是缺陷，是安全边界：**组件是不可信代码**，它唯一能做的事就是通过桥申请能力。

`allow-forms` 是单独给的：沙箱里少了它，浏览器会把整个提交过程拦掉，`submit` 事件**根本不会触发**。也就是说 `<form>` + 输入框 + 回车这套最普通的写法会静默失效 —— 字打进去了，回车没反应，什么都不发生，连报错都没有。它不扩大权限面（表单只能提交到组件自己的不透明源，外发请求本来就能用 `fetch` 发），所以默认开着。

## 5.1 右上角要留出来

桌面窗口的功能图标（拖动 / 层级 / 别针 / 收回）浮在卡片右上角 `top: 6px; right: 6px`，整条大约 **97×28**，鼠标移进卡片就淡入。它盖在组件内容**上面**，而且是真的能点的。

所以组件的右上角是一块"窗饰保留区"：

- 不要在那里放输入框、按钮、可点的列表项 —— 用户点下去，点到的是"收回"。
- 顶部通栏的控件（比如待办清单的输入框）要么整体下移一行，要么像 `lattice.todo` 那样先放一条 22px 的标题栏，把这一行让出去。
- 纯展示的组件（时钟、图片）不用管，那块地方本来就是空的。

`lattice.todo` 的标题栏写法可以直接抄：一行 `22px` 高、`padding-right: 96px`（`97` 减去卡片自己的 `12px` 内边距），左边放标题、右边放计数。视觉上窗饰正好落在这条标题栏的右端，谁也不压谁。

## 6. 排版

组件窗口都很小，字号和字距的容错率比普通页面低得多。四条规矩：

**字体栈统一用这一串**（平台推下来的 `--lattice-font` 也是它，所以直接 `font-family: inherit` 就对）：

```css
--font: "Segoe UI Variable Text", "Segoe UI", "Microsoft YaHei UI",
  "Microsoft YaHei", "PingFang SC", "Hiragino Sans GB", system-ui, sans-serif;
```

拉丁字母交给 Segoe UI，汉字落到 YaHei UI——这是 Windows 自己的组合。**不要**把 `system-ui` 放最前面：它解析到 Segoe UI，而 Segoe UI 没有汉字，浏览器只能按自己的兜底字体补，混排时基线和字重会对不齐。

**不要写 `-webkit-font-smoothing: antialiased`。** 这条在 macOS 上是"让字更细腻"，在 Windows 上恰好相反：它关掉 ClearType 次像素渲染，中文小字立刻变细、发灰，像没对上焦。

**字号只有四档**：11（胶囊/元信息）、12（次要说明）、13（正文）、40+（大数字）。中文低于 12px 笔画会粘在一起，`11px` 只用于不承载信息的标签。

**数字和中文单位之间不加空格。** 正确写法是 `2027年1月1日`、`24小时制`、`49字`；写成 `2027 年 1 月 1 日` 是把西文词间距套到中文上，视觉上会散成五段。汉字与**阿拉伯数字**之间留一个空格是对的（`距离 2027年1月1日`），单位不算。

时间类数字一律加 `font-variant-numeric: tabular-nums`，否则秒数跳动时整行会左右抖。

## 7. 最小示例

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
      error.code === "permission_denied" ? "Needs clock permission" : "Could not read the time";
  });

parent.postMessage({ __lattice: 1, type: "ready" }, "*");
```

## 8. 调试

- 组件报错不会崩平台，只会让那个组件白屏。开发时先在浏览器里跑 `npm run dev`，再用 DevTools 打开 iframe 的独立控制台。
- 清单写错时组件库底部会列出原因，先看那里。
- 桥调用全部返回 Promise，务必 `.catch()`，否则权限未授予时会静默失败。
- 用户组件加载不出来时，先确认三件事：目录在 `%APPDATA%\com.iron-tom.lattice\widgets\<id>\`（组件库标题右边那颗文件夹图标能直接打开）、`manifest.json` 的 `id` 和目录名一致、HTML 里全是相对路径。
- 想单独验证协议有没有把文件发出去：`curl -i http://lattice-widget.localhost/<id>/index.html`（Windows 上是这个形式）。返回 404 就是路径不对，返回 200 但白屏就是组件自己的 JS 出错。
