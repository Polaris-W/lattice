/**
 * 棂 / Lattice —— 小组件清单（manifest）类型与校验
 *
 * 一个小组件就是一个目录：manifest.json + entry 指向的 HTML 入口。
 * 清单是平台与第三方之间唯一的契约，所有默认值都在这里收敛，
 * 避免各处的兜底逻辑互相漂移。
 */

/** 组件在桌面上的层级 */
export type WidgetLayer = "desktop" | "top";

/**
 * 组件可申请的权限。
 * 平台默认全拒，用户在组件详情里逐项授予；未授予时桥调用直接返回错误。
 */
export type Permission =
  | "clock" // 读取系统时间 / 时区
  | "storage" // 读写组件私有键值存储
  | "clipboard:write" // 写入剪贴板
  | "network" // 发起网络请求
  | "system:monitor" // 读取 CPU / 内存 / 磁盘等指标
  | "media:control"; // 控制正在播放的媒体

export interface WidgetSize {
  w: number;
  h: number;
  minW: number;
  minH: number;
}

export interface WidgetManifest {
  /** 反向域名风格，全局唯一，例如 lattice.clock */
  id: string;
  name: string;
  version: string;
  description: string;
  author: string;
  /** 相对组件目录的入口 HTML，默认 index.html */
  entry: string;
  size: WidgetSize;
  layer: WidgetLayer;
  /**
   * 组件要不要键盘焦点。
   *
   * 桌面窗口默认带 `WS_EX_NOACTIVATE`（点了不抢焦点），这对时钟、倒计时这类
   * 只看不摸的组件是对的。但便签、待办这种要打字的不行：窗口拿不到焦点，
   * 光标会闪，按键却全进了后面那个窗口。
   *
   * 所以默认 `true`（能输入），纯展示组件在清单里写 `"interactive": false`
   * 换回"点了不打扰你"的行为。
   */
  interactive: boolean;
  permissions: Permission[];
  /** 声明所依赖的 SDK 版本区间，便于将来做兼容性拦截 */
  sdk: string;
}

export const DEFAULT_SIZE: WidgetSize = { w: 240, h: 140, minW: 120, minH: 80 };
export const SUPPORTED_SDK = "^0.1";

const ID_RE = /^[a-z0-9]+(?:[.-][a-z0-9]+)+$/;
const VERSION_RE = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

export class ManifestError extends Error {}

/**
 * 把磁盘上的原始 JSON 归一化成可信的 WidgetManifest。
 * 任何不合法都抛 ManifestError，由注册表决定是跳过还是展示错误卡片。
 */
export function normalizeManifest(raw: unknown, dirName: string): WidgetManifest {
  if (!raw || typeof raw !== "object") {
    throw new ManifestError("manifest.json is not an object");
  }
  const input = raw as Record<string, unknown>;

  const id = requireString(input.id, "id");
  if (!ID_RE.test(id)) {
    throw new ManifestError(`id "${id}" is not a reverse-domain id, e.g. lattice.clock`);
  }

  const version = requireString(input.version, "version");
  if (!VERSION_RE.test(version)) {
    throw new ManifestError(`version "${version}" is not a valid semver string`);
  }

  const rawSize = (input.size ?? {}) as Partial<WidgetSize>;
  const size: WidgetSize = {
    w: positive(rawSize.w, DEFAULT_SIZE.w),
    h: positive(rawSize.h, DEFAULT_SIZE.h),
    minW: positive(rawSize.minW, DEFAULT_SIZE.minW),
    minH: positive(rawSize.minH, DEFAULT_SIZE.minH),
  };
  // 初始尺寸不得小于最小尺寸，否则拖拽逻辑会立刻反弹
  size.w = Math.max(size.w, size.minW);
  size.h = Math.max(size.h, size.minH);

  const layer: WidgetLayer = input.layer === "top" ? "top" : "desktop";
  // 只有显式写 false 才关掉：第三方组件忘了声明时，宁可抢一次焦点，
  // 也不要让人对着输入框敲半天没反应
  const interactive = input.interactive !== false;

  return {
    id,
    name: optionalString(input.name) || dirName,
    version,
    description: optionalString(input.description),
    author: optionalString(input.author) || "Unknown author",
    entry: optionalString(input.entry) || "index.html",
    size,
    layer,
    interactive,
    permissions: normalizePermissions(input.permissions),
    sdk: optionalString(input.sdk) || SUPPORTED_SDK,
  };
}

function normalizePermissions(raw: unknown): Permission[] {
  if (!Array.isArray(raw)) return [];
  const allowed = new Set<Permission>([
    "clock",
    "storage",
    "clipboard:write",
    "network",
    "system:monitor",
    "media:control",
  ]);
  const out: Permission[] = [];
  for (const item of raw) {
    if (typeof item === "string" && allowed.has(item as Permission) && !out.includes(item as Permission)) {
      out.push(item as Permission);
    }
  }
  return out;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new ManifestError(`missing required field "${field}"`);
  }
  return value.trim();
}

function optionalString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function positive(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.round(value) : fallback;
}

/** 权限的显示名，UI 与文档共用一份，避免文案漂移 */
export const PERMISSION_LABELS: Record<Permission, string> = {
  clock: "System time",
  storage: "Widget storage",
  "clipboard:write": "Write clipboard",
  network: "Network access",
  "system:monitor": "System metrics",
  "media:control": "Media control",
};
