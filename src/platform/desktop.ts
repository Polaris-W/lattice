/**
 * 棂 / Lattice —— 运行态控制（前端侧）
 *
 * 把画布上的 Placement 翻译成桌面窗口描述，交给 Rust 建窗口。
 * 坐标是画布的 CSS 像素，需要加上画布元素在屏幕上的偏移，
 * 否则组件会全部堆到左上角。
 */

import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { Permission } from "../runtime/manifest";
import type { WidgetRecord } from "../runtime/registry";
import type { DesktopRect, Placement } from "./store";

export interface WidgetWindowSpec {
  instanceId: string;
  widgetId: string;
  entry: string;
  permissions: Permission[];
  x: number;
  y: number;
  w: number;
  h: number;
  minW: number;
  minH: number;
  layer: "desktop" | "top";
  clickThrough: boolean;
  pinned: boolean;
  /** 平台当前解析出的明暗，桌面窗口据此上色 */
  theme: "light" | "dark";
}

/** 上一次算出来的、可信的画布原点 */
let cachedOrigin: { x: number; y: number } | null = null;

/** 画布左上角在屏幕坐标系里的位置 */
function canvasOrigin(): { x: number; y: number } {
  const rect = document.querySelector(".lattice-canvas")?.getBoundingClientRect();
  if (!rect) return cachedOrigin ?? { x: 0, y: 0 };

  const x = window.screenX + rect.left;
  const y = window.screenY + rect.top;

  // 投放之后主窗口会被最小化，此时 screenX/screenY 是 -32000 这类哨兵值。
  // 拿它算出来的坐标会把所有组件推出屏幕外，所以遇到就退回上一次的可见位置。
  if (x < -10000 || y < -10000) return cachedOrigin ?? { x: 0, y: 0 };

  cachedOrigin = { x, y };
  return cachedOrigin;
}

/** 直接读 <html data-theme>：App 的主题 effect 已经把它算好了，这里不用再猜一次 */
function currentTheme(): "light" | "dark" {
  return document.documentElement.dataset.theme === "dark" ? "dark" : "light";
}

export function buildSpecs(
  placements: Placement[],
  records: Map<string, WidgetRecord>,
  grants: Record<string, Permission[]>,
  desktopRects: Record<string, DesktopRect>,
): WidgetWindowSpec[] {
  const origin = canvasOrigin();
  const theme = currentTheme();
  const specs: WidgetWindowSpec[] = [];

  for (const placement of placements) {
    const record = records.get(placement.widgetId);
    if (!record) continue;
    const entry = record.manifest.entry.replace(/^\/+/, "");
    // 桌面上摆过就以那次为准 —— 用户拖到哪儿就该待在哪儿，
    // 画布坐标只在第一次投放时用来给个初始位置
    const placed = desktopRects[placement.instanceId];
    specs.push({
      instanceId: placement.instanceId,
      widgetId: placement.widgetId,
      entry: `widgets/${placement.widgetId}/${entry}`,
      permissions: grants[placement.widgetId] ?? [],
      x: Math.round(placed ? placed.x : origin.x + placement.x),
      y: Math.round(placed ? placed.y : origin.y + placement.y),
      w: Math.round(placed ? placed.w : placement.w),
      h: Math.round(placed ? placed.h : placement.h),
      minW: record.manifest.size.minW,
      minH: record.manifest.size.minH,
      layer: placement.layer,
      clickThrough: placement.clickThrough,
      pinned: placement.pinned ?? false,
      theme,
    });
  }

  return specs;
}

export async function syncDesktop(specs: WidgetWindowSpec[]): Promise<void> {
  await invoke("sync_widget_windows", { specs });
}

export async function closeDesktop(): Promise<void> {
  await invoke("close_widget_windows");
}

export async function minimizeMain(): Promise<void> {
  await getCurrentWindow().minimize();
}
