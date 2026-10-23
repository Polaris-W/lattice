/**
 * 底板外观：颜色、浓度、磨砂。
 *
 * 这三个值决定卡片"长什么样"，属于**平台**，不属于组件 —— 组件只管内容，
 * 底板由宿主页画（跟窗饰、圆角一样是平台的事）。所以它既能在清单里给默认值，
 * 也能在属性面板里按实例覆盖，组件代码一行都不用动。
 *
 * # 为什么没有"透明度"
 *
 * 桌面窗口始终是不透明的（逐像素透明要 DirectComposition，这台机器建不出来，
 * 见 `src-tauri/src/desktop.rs`）。所以 `alpha` 调的其实是"底色盖住磨砂层的
 * 比例"：
 *
 *   alpha = 1  → 纯色实心，跟原来一模一样
 *   alpha = 0  → 只剩磨砂层，看到的是**糊掉的桌面壁纸**
 *
 * 它看不到"压在后面的浏览器窗口"，那是系统 acrylic 才能给的东西，而系统的
 * 模糊半径写死、做不成滑杆。二者只能选一个，这里选了滑杆。
 */
export interface Appearance {
  /** `"auto"` = 跟随明暗主题；否则 `#rrggbb` */
  tint: string;
  /** 底色浓度 0..1。0 = 只剩磨砂，1 = 纯色实心 */
  alpha: number;
  /** 磨砂半径，逻辑像素 0..MAX_BLUR */
  blur: number;
}

/** 模糊上限。宿主页会按 `2 × 半径` 外扩壁纸，再大就该换方案了 */
export const MAX_BLUR = 40;

export const DEFAULT_APPEARANCE: Appearance = { tint: "auto", alpha: 1, blur: 0 };

const HEX_RE = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i;

export function normalizeTint(value: unknown, fallback = "auto"): string {
  if (typeof value !== "string") return fallback;
  const raw = value.trim().toLowerCase();
  if (raw === "auto") return "auto";
  if (!HEX_RE.test(raw)) return fallback;
  // #abc 摊成 #aabbcc，后面拼 rgba() 时不用再判断长度
  if (raw.length === 4) {
    return "#" + raw.slice(1).split("").map((c) => c + c).join("");
  }
  return raw;
}

export function normalizeAppearance(
  raw: unknown,
  fallback: Appearance = DEFAULT_APPEARANCE,
): Appearance {
  if (!raw || typeof raw !== "object") return { ...fallback };
  const input = raw as Record<string, unknown>;
  const alpha = typeof input.alpha === "number" && Number.isFinite(input.alpha)
    ? input.alpha
    : fallback.alpha;
  const blur = typeof input.blur === "number" && Number.isFinite(input.blur)
    ? input.blur
    : fallback.blur;
  return {
    tint: normalizeTint(input.tint, fallback.tint),
    alpha: Math.round(Math.min(1, Math.max(0, alpha)) * 100) / 100,
    blur: Math.round(Math.min(MAX_BLUR, Math.max(0, blur)) * 10) / 10,
  };
}

/** 跟"出厂"没区别：跟随主题、实心、不磨砂 */
export function isPlainAppearance(appearance: Appearance): boolean {
  return appearance.tint === "auto" && appearance.alpha === 1 && appearance.blur === 0;
}

export function tintRgb(tint: string): [number, number, number] | null {
  if (!HEX_RE.test(tint) || tint.length !== 7) return null;
  return [
    parseInt(tint.slice(1, 3), 16),
    parseInt(tint.slice(3, 5), 16),
    parseInt(tint.slice(5, 7), 16),
  ];
}

export function hexFromRgb(r: number, g: number, b: number): string {
  const part = (value: number) =>
    Math.round(Math.min(255, Math.max(0, value))).toString(16).padStart(2, "0");
  return `#${part(r)}${part(g)}${part(b)}`;
}

/**
 * 底色盖在某个背景色上之后，看起来是什么颜色。
 *
 * 画布预览没有壁纸可采样，只能拿应用底色当背景算一遍；桌面窗口里这个值是
 * 宿主页用壁纸的平均色算的（见 widgetHost.ts）。两边都只是"大概像"。
 */
export function compositeHex(
  tint: string,
  alpha: number,
  backdrop: [number, number, number],
): string {
  const rgb = tintRgb(tint) ?? backdrop;
  return hexFromRgb(
    rgb[0] * alpha + backdrop[0] * (1 - alpha),
    rgb[1] * alpha + backdrop[1] * (1 - alpha),
    rgb[2] * alpha + backdrop[2] * (1 - alpha),
  );
}

/** 感知亮度，用来决定字色翻不翻 */
export function luminance([r, g, b]: [number, number, number]): number {
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

/**
 * 平台自己的 `--lattice-surface`，也就是"没有底板覆盖时卡片是什么颜色"。
 *
 * 画布上的预览和属性面板的滑杆都拿它当"背后那一层"：画布没有壁纸可采样，
 * 用主题底色代替壁纸平均色，算出来的颜色只是**大致**等于桌面上的样子
 * （模糊和壁纸纹理都欠奉）。要看得准还是得投放出去。
 */
export function themeSurfaceRgb(): [number, number, number] {
  const raw = getComputedStyle(document.documentElement).getPropertyValue("--lattice-surface");
  const hex = tintRgb(raw.trim());
  if (hex) return hex;
  const match = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(raw.trim());
  if (match) return [Number(match[1]), Number(match[2]), Number(match[3])];
  return [255, 255, 255];
}
