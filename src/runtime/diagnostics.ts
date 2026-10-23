/**
 * 棂 / Lattice —— 组件出错的通道
 *
 * 组件跑在 `sandbox="allow-scripts"`（不含 `allow-same-origin`）的 iframe 里，
 * 源是不透明的：宿主读不到它的 `window.onerror`，也读不到它的 DOM。
 * 所以错误得由组件那一侧自己报上来 —— 由 `src-tauri/src/protocol.rs`
 * 在发 HTML 时注入一小段脚本（见 `diagnostics.rs` 的 `REPORTER`），
 * 它监听 `error` / `unhandledrejection`，再 `postMessage` 给宿主。
 *
 * 这里只负责"认出这条消息"，怎么显示是宿主页的事。
 *
 * 两条不能破的规矩：
 *   1. `REPORT_TAG` 必须和 Rust 侧那份脚本里的 `tag` 一字不差 —— 改了要一起改
 *   2. 这不是桥。它不带 `__lattice` 标记，绝不能掉进 `isBridgeRequest` 的分支，
 *      否则组件能靠伪造一条"错误"骗到宿主的一次响应
 */

/** 和 `src-tauri/src/diagnostics.rs` 里 `REPORTER` 的 `tag` 对应 */
export const REPORT_TAG = "__lattice_diag";

export type WidgetErrorKind = "script" | "promise" | "resource";

export interface WidgetErrorReport {
  kind: WidgetErrorKind;
  /** 已经截断过（Rust 侧 400 字），这里不再切 */
  message: string;
  /** `widget.js:12:5` 或资源地址 */
  where?: string;
  stack?: string;
}

/** 显示在错误卡片顶上那行小字 */
export const ERROR_KIND_LABEL: Record<WidgetErrorKind, string> = {
  script: "Script error",
  promise: "Unhandled rejection",
  resource: "Missing file",
};

/**
 * 是不是组件报上来的错误。
 *
 * 只认结构，不认来源 —— 来源由调用方拿 `event.source === iframe.contentWindow`
 * 把关，这里拿不到那个信息。
 */
export function isWidgetErrorReport(data: unknown): data is WidgetErrorReport {
  if (!data || typeof data !== "object") return false;
  const value = data as Record<string, unknown>;
  if (value.tag !== REPORT_TAG) return false;
  if (typeof value.message !== "string") return false;
  return value.kind === "script" || value.kind === "promise" || value.kind === "resource";
}

/**
 * 一条错误的指纹：同一个错反复报时用来去重。
 *
 * 只看 `kind + message + where`，不看堆栈 —— 堆栈里带着行号，可同一个循环里
 * 抛出来的错本来就应该算同一个。
 */
export function errorSignature(report: WidgetErrorReport): string {
  return `${report.kind}|${report.message}|${report.where ?? ""}`;
}

/**
 * 谁更值得看。
 *
 * 脚本异常压过资源缺失，因为"缺一张图"经常是前面那个异常的结果 ——
 * 真机上就撞到了：组件 `undefinedThing.value` 当场抛，紧接着 `<img>` 加载失败，
 * 只显示后到的那条的话，用户看到的是一句 "Failed to load img"，
 * 真正的原因被盖掉了。
 */
const SEVERITY: Record<WidgetErrorKind, number> = { script: 3, promise: 3, resource: 1 };

/** 挑主错误：先看严重程度，同级看谁先来（先抛的通常是根因） */
export function pickPrimary(reports: readonly WidgetErrorReport[]): WidgetErrorReport | null {
  let best: WidgetErrorReport | null = null;
  for (const report of reports) {
    if (!best || SEVERITY[report.kind] > SEVERITY[best.kind]) best = report;
  }
  return best;
}
