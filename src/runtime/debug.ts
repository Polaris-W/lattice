/**
 * 调试面板的数据总线。
 *
 * # 要解决什么
 *
 * 组件跑在沙箱 iframe 里，它的 `console.log` 宿主看不见、devtools 要单独连
 * （WebView2 的 devtools 还得先开远程调试端口）。所以"这个组件到底有没有在
 * 调桥""那次调用为什么失败"这两件事，以前只能靠加 `console.info` 再猜 ——
 * 而 vite dev **不转发组件窗口的 console**（这条坑真踩过一整轮）。
 *
 * 现在：桥的每一次调用、组件里的每一条日志，都汇成一条 `DebugRecord`，
 * 攒成一批发给主窗口，由调试面板显示。
 *
 * # 为什么走事件而不是 invoke
 *
 * 桌面窗口和主窗口是两个 webview，桥在各自的宿主页里跑。`emit` 是现成的
 * 跨窗口通道，而且**不需要新的 Rust 命令**（`core:default` 里已经给了
 * `event:allow-emit`）。代价是主窗口只能收到"面板打开之后"的记录 —— 所以
 * 主窗口自己在启动时就订阅，环形缓冲留在前端，打开面板能看到之前的历史。
 *
 * # 为什么要攒批
 *
 * 一次桥调用一条记录，而时钟每秒一跳。逐条 `emit` 等于把 IPC 流量翻倍。
 * 攒 400ms 或者攒够 50 条再发一次，面板看起来仍然是"实时"的。
 */

export const DEBUG_EVENT = "lattice:debug";

export type DebugKind = "call" | "log";

export interface DebugRecord {
  /** epoch 毫秒 */
  at: number;
  kind: DebugKind;
  widgetId: string;
  instanceId: string;
  /** 桥调用是方法名；日志是级别（log / warn / error） */
  name: string;
  ok: boolean;
  /** 桥调用的耗时（毫秒）；日志恒为 0 */
  ms: number;
  /** 失败原因 / 日志正文 */
  text: string;
}

/** 面板最多留这么多条。时钟每秒一条，400 条够看六分多钟。 */
const MAX_RECORDS = 400;
/** 攒批的间隔 */
const FLUSH_DELAY = 400;
/** 一批最多带多少条，多了就分几次发 */
const FLUSH_BATCH = 50;

/**
 * 组件发来的 console 消息（由注入的上报脚本转发）。
 *
 * 和 `isWidgetErrorReport` 是两条独立的通道：错误走 `__lattice_diag`、
 * 日志走 `__lattice` 加 `type: "log"`。之所以复用桥的标记，是因为两个宿主
 * 都已经在筛 `__lattice` 了，多一个 `type` 比分叉出第三个标记省事。
 */
export function isWidgetLog(data: unknown): data is { [key: string]: unknown; type: "log"; payload: { level?: string; text?: string } } {
  if (!data || typeof data !== "object") return false;
  const candidate = data as Record<string, unknown>;
  return candidate.__lattice === 1 && candidate.type === "log";
}

const records: DebugRecord[] = [];
const listeners = new Set<(records: readonly DebugRecord[]) => void>();

let mirror = false;
let pending: DebugRecord[] = [];
let flushTimer: ReturnType<typeof setTimeout> | null = null;

function inTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

function notify(): void {
  for (const listener of [...listeners]) {
    try {
      listener(records);
    } catch {
      /* 面板自己画错了不该影响记录 */
    }
  }
}

function scheduleFlush(): void {
  if (flushTimer !== null) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    void flush();
  }, FLUSH_DELAY);
}

async function flush(): Promise<void> {
  if (!mirror || !inTauri() || pending.length === 0) {
    pending = [];
    return;
  }
  const batch = pending.slice(0, FLUSH_BATCH);
  pending = pending.slice(batch.length);
  try {
    // 动态 import：浏览器预览（`npm run dev`）里没有 Tauri，静态 import 会炸
    const { emit } = await import("@tauri-apps/api/event");
    await emit(DEBUG_EVENT, batch);
  } catch {
    pending = [];
    return;
  }
  if (pending.length > 0) scheduleFlush();
}

/**
 * 记一条。
 *
 * 桌面窗口（宿主页）要先调 `enableMirror()`，记录才会被转发到主窗口；
 * 主窗口自己调用时只进本地缓冲 —— 否则它会把记录发给自己。
 */
export function trace(entry: Omit<DebugRecord, "at"> & { at?: number }): void {
  const record: DebugRecord = { at: entry.at ?? Date.now(), ...entry } as DebugRecord;
  records.push(record);
  if (records.length > MAX_RECORDS) records.splice(0, records.length - MAX_RECORDS);
  notify();

  if (mirror) {
    pending.push(record);
    if (pending.length >= FLUSH_BATCH) {
      void flush();
    } else {
      scheduleFlush();
    }
  }
}

/** 收别的窗口发来的一批记录 */
export function ingest(batch: unknown): void {
  if (!Array.isArray(batch)) return;
  let changed = false;
  for (const item of batch) {
    if (!item || typeof item !== "object") continue;
    const record = item as DebugRecord;
    if (typeof record.at !== "number" || typeof record.name !== "string") continue;
    records.push(record);
    changed = true;
  }
  if (!changed) return;
  if (records.length > MAX_RECORDS) records.splice(0, records.length - MAX_RECORDS);
  notify();
}

/** 宿主页在启动时调一次：之后的记录都会转发到主窗口 */
export function enableMirror(): void {
  mirror = true;
}

export function subscribe(listener: (records: readonly DebugRecord[]) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function snapshot(): readonly DebugRecord[] {
  return records;
}

export function clear(): void {
  records.length = 0;
  pending = [];
  notify();
}

// ---------------------------------------------------------------------------
// 面板的纯逻辑
// ---------------------------------------------------------------------------

export interface DebugFilter {
  /** `all` 不过滤；否则只留这一类 */
  mode: "all" | DebugKind;
  /** 只看失败 */
  onlyFailures: boolean;
  /** 大小写不敏感，匹配方法名 / 组件 id / 实例 id / 正文 */
  query: string;
}

export function filterRecords(
  records: readonly DebugRecord[],
  filter: DebugFilter,
): DebugRecord[] {
  const needle = filter.query.trim().toLowerCase();
  return records.filter((record) => {
    if (filter.mode !== "all" && record.kind !== filter.mode) return false;
    if (filter.onlyFailures && record.ok) return false;
    if (!needle) return true;
    return (
      record.name.toLowerCase().includes(needle) ||
      record.widgetId.toLowerCase().includes(needle) ||
      record.instanceId.toLowerCase().includes(needle) ||
      record.text.toLowerCase().includes(needle)
    );
  });
}

export interface DebugSummary {
  calls: number;
  logs: number;
  failures: number;
}

export function summarize(records: readonly DebugRecord[]): DebugSummary {
  let calls = 0;
  let failures = 0;
  for (const record of records) {
    if (record.kind === "call") calls += 1;
    if (!record.ok) failures += 1;
  }
  return { calls, logs: records.length - calls, failures };
}
