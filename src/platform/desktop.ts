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
import type { Placement } from "./store";

export interface WidgetWindowSpec {
  instanceId: string;
  widgetId: string;
  entry: string;
  permissions: Permission[];
  x: number;
  y: number;
  w: number;
  h: number;
  layer: "desktop" | "top";
  clickThrough: boolean;
  /** 平台当前解析出的明暗，桌面窗口据此上色 */
  theme: "light" | "dark";
}

/** 画布左上角在屏幕坐标系里的位置 */
function canvasOrigin(): { x: number; y: number } {
  const element = document.querySelector(".lattice-canvas");
  const rect = element?.getBoundingClientRect();
  if (!rect) return { x: 0, y: 0 };
  return { x: window.screenX + rect.left, y: window.screenY + rect.top };
}

/** 直接读 <html data-theme>：App 的主题 effect 已经把它算好了，这里不用再猜一次 */
function currentTheme(): "light" | "dark" {
  return document.documentElement.dataset.theme === "dark" ? "dark" : "light";
}

export function buildSpecs(
  placements: Placement[],
  records: Map<string, WidgetRecord>,
  grants: Record<string, Permission[]>,
): WidgetWindowSpec[] {
  const origin = canvasOrigin();
  const theme = currentTheme();
  const specs: WidgetWindowSpec[] = [];

  for (const placement of placements) {
    const record = records.get(placement.widgetId);
    if (!record) continue;
    const entry = record.manifest.entry.replace(/^\/+/, "");
    specs.push({
      instanceId: placement.instanceId,
      widgetId: placement.widgetId,
      entry: `widgets/${placement.widgetId}/${entry}`,
      permissions: grants[placement.widgetId] ?? [],
      x: Math.round(origin.x + placement.x),
      y: Math.round(origin.y + placement.y),
      w: placement.w,
      h: placement.h,
      layer: placement.layer,
      clickThrough: placement.clickThrough,
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
