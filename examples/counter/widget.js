/**
 * 计数器 —— 第三方组件的示例
 *
 * 这个文件是 v0.4 的样子：业务逻辑只有下面这几行，桥、主题、配置、心跳
 * 全在 `lattice.js` 里（那是从 `@lattice/sdk` 拷过来的，跟着组件一起分发）。
 *
 * 对照老写法能看出 SDK 省了什么：
 *   - 手写 `seq` / `pending` / `setTimeout` 那一套请求-响应配对
 *   - 自己监听 message、自己认 `type === "theme"` / `"response"`
 *   - 自己把 `--lattice-*` 映射成 `--fg` 这类短名
 *   - 自己发 `ready`（忘了发，宿主就永远不推主题）
 *
 * 没有 SDK 也能写组件 —— 协议没变，WIDGET_SPEC 里那套 postMessage 一直有效。
 * SDK 只是把"每个组件都要重写一遍的 80 行"收起来。
 */
import { createLattice } from "./lattice.js";

const lattice = createLattice();

const valueEl = document.getElementById("value");
const bumpEl = document.getElementById("bump");
const hintEl = document.getElementById("hint");

let count = 0;

function render() {
  valueEl.textContent = String(count);
}

/**
 * 启动顺序值得看一眼：`await lattice.ready` 之后主题和配置**已经应用过**
 * 一次，所以第一次渲染就是对的颜色，不会先闪一下默认样式。
 */
await lattice.ready;

try {
  const stored = await lattice.storage.get("count");
  if (typeof stored === "number") count = stored;
} catch (error) {
  // 没授权 `storage` 也照样能计数，只是关掉窗口就归零 —— 明说，别装作没事
  if (error.code === "permission_denied") {
    hintEl.textContent = "Not saved: storage permission not granted";
  }
}

render();

bumpEl.addEventListener("click", () => {
  count += 1;
  render();
  // 写盘失败不该让按钮看起来坏了：数字已经加过了，最多是这次没存住
  lattice.storage.set("count", count).catch(() => {
    hintEl.textContent = "Not saved: storage permission not granted";
  });
});
