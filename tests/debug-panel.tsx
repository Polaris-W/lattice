/**
 * 调试面板的组件级检查。
 *
 * 前面的 `tests/debug.html` 钉的是总线（缓冲、攒批、过滤纯函数）；这一页把
 * **真正的组件**挂起来，验的是"接上 React 之后还对不对"：统计数字、三个过滤
 * 按钮、只看失败、冻住、清空。
 *
 * 为什么值得单独一页：过滤逻辑抽成纯函数之后，最容易坏的是**接线**（按钮点了
 * 没接上 state、统计用了未过滤的那份）。那种错纯函数测试一条都抓不到。
 *
 * 顺带它也是一张视觉验收图 —— 直接 `--screenshot` 就是这个面板长什么样。
 */

import { createRoot } from "react-dom/client";
// 平台样式：面板全靠 styles.css 里的令牌和 .lattice-debug-* 规则，不引入就是一堆裸 HTML
import "../src/styles.css";
import { DebugPanel } from "../src/platform/DebugPanel";
import { clear, trace } from "../src/runtime/debug";

const lines: string[] = [];
const log = (pass: boolean, text: string) => lines.push((pass ? "PASS " : "FAIL ") + text);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function seed() {
  clear();
  trace({
    kind: "call",
    widgetId: "lattice.clock",
    instanceId: "lattice.clock#4e78858c",
    name: "clock.now",
    ok: true,
    ms: 0.6,
    text: "",
  });
  trace({
    kind: "call",
    widgetId: "lattice.note",
    instanceId: "inst-note-1",
    name: "storage.get",
    ok: false,
    ms: 1.4,
    text: "permission not granted: storage",
  });
  trace({
    kind: "log",
    widgetId: "lattice.note",
    instanceId: "inst-note-1",
    name: "warn",
    ok: true,
    ms: 0,
    text: "draft is empty, nothing to save",
  });
  trace({
    kind: "call",
    widgetId: "lattice.sysmon",
    instanceId: "lattice.sysmon#9f21a0bd",
    name: "system.metrics",
    ok: true,
    ms: 12.4,
    text: "",
  });
  trace({
    kind: "log",
    widgetId: "lattice.clock",
    instanceId: "lattice.clock#4e78858c",
    name: "error",
    ok: false,
    ms: 0,
    text: "TypeError: cannot read properties of null (reading 'split')",
  });
}

const host = document.getElementById("panel")!;
const root = createRoot(host);

seed();
root.render(<DebugPanel open onClose={() => {}} />);
await sleep(120);

const $ = (selector: string) => host.querySelector(selector) as HTMLElement | null;
const rows = () => host.querySelectorAll(".lattice-debug-row").length;
const statText = () => $(".lattice-debug-stats")?.textContent ?? "";

/** 按可见文字点一颗按钮 */
function click(text: string) {
  const button = [...host.querySelectorAll("button")].find((item) => item.textContent?.trim() === text);
  if (!button) throw new Error(`no button labelled "${text}"`);
  button.click();
}

// ---- 1. 初次渲染 ----
log(rows() === 5, `五条记录都画出来了（${rows()}）`);
log(statText().includes("3") && statText().includes("bridge"), `统计行「${statText()}」`);
log(
  host.querySelectorAll(".lattice-debug-row.is-bad").length === 2,
  `失败的两行有标记（${host.querySelectorAll(".lattice-debug-row.is-bad").length}）`,
);
log($(".lattice-debug-kind.is-call") !== null, "桥调用那几行带 is-call（强调色）");

// ---- 2. 三个过滤按钮 ----
click("Bridge");
await sleep(60);
log(rows() === 3, `只看桥调用剩三条（${rows()}）`);
click("Console");
await sleep(60);
log(rows() === 2, `只看 console 剩两条（${rows()}）`);
click("All");
await sleep(60);
log(rows() === 5, `回到全部（${rows()}）`);

// ---- 3. 只看失败 ----
const failuresToggle = host.querySelector(".lattice-debug-toggle input") as HTMLInputElement;
failuresToggle.click();
await sleep(60);
log(rows() === 2, `只看失败剩两条（${rows()}）`);
failuresToggle.click();
await sleep(60);
log(rows() === 5, `取消后回到五条（${rows()}）`);

// ---- 4. 搜索 ----
const search = $(".lattice-debug-search") as HTMLInputElement;
const type = (value: string) => {
  // React 受控输入：直接改 value 不会触发 onChange，得走原生 setter
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  setter?.call(search, value);
  search.dispatchEvent(new Event("input", { bubbles: true }));
};
type("sysmon");
await sleep(60);
log(rows() === 1, `搜 sysmon 剩一条（${rows()}）`);
type("");
await sleep(60);
log(rows() === 5, `清空搜索回到五条（${rows()}）`);

// ---- 5. 冻住 ----
click("Pause");
await sleep(40);
trace({
  kind: "call",
  widgetId: "lattice.clock",
  instanceId: "lattice.clock#4e78858c",
  name: "clock.now",
  ok: true,
  ms: 0.5,
  text: "",
});
await sleep(80);
log(rows() === 5, `冻住期间新记录不上屏（${rows()}）`);
click("Resume");
await sleep(80);
log(rows() === 6, `解冻后补齐（${rows()}）`);

// ---- 6. 清空 ----
click("Clear");
await sleep(80);
log(rows() === 0, `清空后没有行（${rows()}）`);
log(
  ($(".lattice-debug-empty")?.textContent ?? "").includes("Nothing yet"),
  `空状态给了说明「${$(".lattice-debug-empty")?.textContent ?? ""}」`,
);

// ---- 7. 再塞一点数据，留一张好看的验收图 ----
seed();
await sleep(120);

const failed = lines.filter((line) => line.startsWith("FAIL")).length;
document.getElementById("out")!.innerHTML =
  `<span class="${failed === 0 ? "ok" : "bad"}">pass=${lines.length - failed} fail=${failed}</span>\n` +
  lines
    .map((line) => `<span class="${line.startsWith("PASS") ? "ok" : "bad"}">${line}</span>`)
    .join("\n");
(window as unknown as { __done: boolean }).__done = true;
