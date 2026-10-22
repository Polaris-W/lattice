/**
 * 棂 / Lattice —— 宿主 ↔ 小组件 的 RPC 桥
 *
 * 安全模型：
 * 1. 小组件跑在 sandbox="allow-scripts"（不含 allow-same-origin）的 iframe 里，
 *    拿到的是不透明源：读不到宿主 DOM、没有可用的 localStorage、发不出同源请求。
 * 2. 因此组件的一切平台能力都必须走这条桥，桥是唯一出入口。
 * 3. 每个方法声明它需要的权限，未授予时返回结构化错误而不是抛异常，
 *    这样组件能优雅降级（例如不显示剪贴板按钮）。
 */

import { invoke } from "@tauri-apps/api/core";
import type { Permission } from "./manifest";

export const BRIDGE_TAG = "__lattice";

export interface BridgeRequestMessage {
  [BRIDGE_TAG]: 1;
  type: "request";
  id: number;
  method: string;
  params?: unknown;
}

export interface BridgeResponseMessage {
  [BRIDGE_TAG]: 1;
  type: "response";
  id: number;
  ok: boolean;
  result?: unknown;
  error?: string;
  code?: BridgeErrorCode;
  /** code 为 permission_denied 时，明确告诉宿主缺的是哪一项，便于就地提示授权 */
  permission?: Permission;
}

export type BridgeErrorCode = "unknown_method" | "permission_denied" | "bad_params" | "internal";

export interface BridgeContext {
  /** 组件实例 id：同一个组件可以同时放多个实例 */
  instanceId: string;
  /** 组件清单 id：存储命名空间按它隔离，同一组件的多个实例共享数据 */
  widgetId: string;
  /** 用户已授予的权限 */
  granted: ReadonlySet<Permission>;
  /** 回话给组件（由宿主注入，负责 postMessage 到正确的窗口） */
  reply: (payload: BridgeResponseMessage) => void;
  /** 组件请求关闭自己 */
  close: () => void;
}

type Handler = (params: unknown, ctx: BridgeContext) => unknown | Promise<unknown>;

interface MethodSpec {
  permission: Permission | null;
  handler: Handler;
}

const methods = new Map<string, MethodSpec>();

export function defineMethod(name: string, permission: Permission | null, handler: Handler): void {
  methods.set(name, { permission, handler });
}

export class BridgeError extends Error {
  constructor(
    readonly code: BridgeErrorCode,
    message: string,
  ) {
    super(message);
  }
}

/** 判断一条消息是不是本平台的桥请求 */
export function isBridgeRequest(data: unknown): data is BridgeRequestMessage {
  if (!data || typeof data !== "object") return false;
  const candidate = data as Record<string, unknown>;
  return candidate[BRIDGE_TAG] === 1 && candidate.type === "request" && typeof candidate.id === "number";
}

/**
 * 处理一次桥请求。
 * 来源校验由调用方完成（比对 event.source === iframe.contentWindow），
 * 比信任 origin 更可靠——沙箱 iframe 的 origin 是字符串 "null"，无法区分实例。
 */
export async function handleBridgeRequest(
  message: BridgeRequestMessage,
  ctx: BridgeContext,
): Promise<void> {
  const reply = (
    body: Pick<BridgeResponseMessage, "ok" | "result" | "error" | "code" | "permission">,
  ) => {
    ctx.reply({ [BRIDGE_TAG]: 1, type: "response", id: message.id, ...body });
  };

  const spec = methods.get(message.method);
  if (!spec) {
    reply({ ok: false, code: "unknown_method", error: `未知方法 ${message.method}` });
    return;
  }
  if (spec.permission && !ctx.granted.has(spec.permission)) {
    reply({
      ok: false,
      code: "permission_denied",
      error: `未授予权限 ${spec.permission}`,
      permission: spec.permission,
    });
    return;
  }

  try {
    reply({ ok: true, result: await spec.handler(message.params, ctx) });
  } catch (error) {
    if (error instanceof BridgeError) {
      reply({ ok: false, code: error.code, error: error.message });
    } else {
      reply({ ok: false, code: "internal", error: String(error) });
    }
  }
}

// ---------------------------------------------------------------------------
// 平台内置方法
// ---------------------------------------------------------------------------

const STORAGE_PREFIX = "lattice.widget.store.";

/**
 * 组件私有存储：一个包一个 JSON 文件，整块读整块写。
 *
 * 浏览器预览里退回 localStorage（按包存一份 map），桌面端走 Rust 落盘。
 * 加一层内存缓存，免得组件每次 set 都往返一次 IPC。
 */
const storeCache = new Map<string, Record<string, unknown>>();

function bridgeInTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

async function loadStore(widgetId: string): Promise<Record<string, unknown>> {
  const cached = storeCache.get(widgetId);
  if (cached) return cached;

  let raw: string | null = null;
  if (bridgeInTauri()) {
    raw = await invoke<string | null>("widget_store_read", { widgetId });
  } else {
    raw = localStorage.getItem(`${STORAGE_PREFIX}${widgetId}`);
  }

  let map: Record<string, unknown> = {};
  if (raw) {
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        map = parsed as Record<string, unknown>;
      }
    } catch {
      map = {};
    }
  }
  storeCache.set(widgetId, map);
  return map;
}

async function saveStore(widgetId: string, map: Record<string, unknown>): Promise<void> {
  storeCache.set(widgetId, map);
  const json = JSON.stringify(map);
  if (bridgeInTauri()) {
    await invoke("widget_store_write", { widgetId, json });
  } else {
    localStorage.setItem(`${STORAGE_PREFIX}${widgetId}`, json);
  }
}

defineMethod("clock.now", "clock", () => ({
  now: new Date().toISOString(),
  epochMs: Date.now(),
  timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  utcOffsetMinutes: -new Date().getTimezoneOffset(),
}));

defineMethod("storage.get", "storage", async (params, ctx) => {
  const key = readKey(params);
  const map = await loadStore(ctx.widgetId);
  return key in map ? map[key] : null;
});

defineMethod("storage.set", "storage", async (params, ctx) => {
  const key = readKey(params);
  const value = (params as { value?: unknown }).value ?? null;
  const map = await loadStore(ctx.widgetId);
  await saveStore(ctx.widgetId, { ...map, [key]: value });
  return { ok: true };
});

defineMethod("storage.remove", "storage", async (params, ctx) => {
  const key = readKey(params);
  const map = await loadStore(ctx.widgetId);
  if (!(key in map)) return { ok: true };
  const next = { ...map };
  delete next[key];
  await saveStore(ctx.widgetId, next);
  return { ok: true };
});

defineMethod("clipboard.write", "clipboard:write", async (params) => {
  const text = (params as { text?: unknown } | undefined)?.text;
  if (typeof text !== "string") {
    throw new BridgeError("bad_params", "clipboard.write 需要字符串参数 text");
  }
  await navigator.clipboard.writeText(text);
  return { ok: true };
});

defineMethod("theme.get", null, () => readThemeTokens());

defineMethod("window.close", null, (_params, ctx) => {
  ctx.close();
  return { ok: true };
});

function readKey(params: unknown): string {
  const key = (params as { key?: unknown } | undefined)?.key;
  if (typeof key !== "string" || !key) {
    throw new BridgeError("bad_params", "缺少字符串参数 key");
  }
  return key;
}

/** 把 CSS 变量读成普通对象，组件据此跟随平台主题，不必自己判断明暗 */
export function readThemeTokens(): Record<string, string> {
  const style = getComputedStyle(document.documentElement);
  const tokens: Record<string, string> = {};
  for (const name of [
    "--lattice-bg",
    "--lattice-surface",
    "--lattice-text",
    "--lattice-text-muted",
    "--lattice-border",
    "--lattice-accent",
    "--lattice-radius",
    "--lattice-font",
  ]) {
    tokens[name] = style.getPropertyValue(name).trim();
  }
  return tokens;
}
