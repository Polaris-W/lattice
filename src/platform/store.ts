/**
 * 棂 / Lattice —— 平台状态
 *
 * 只存"用户配置"这一层：组件摆放、层级、已授权权限、主题。
 * 组件自己的业务数据不在这里，走 storage 桥按 widgetId 隔离。
 */

import { create } from "zustand";
import { persist } from "zustand/middleware";
import type { Permission, WidgetLayer } from "../runtime/manifest";

export interface Placement {
  /** 实例 id，同一个组件可以摆多份 */
  instanceId: string;
  /** 清单 id */
  widgetId: string;
  x: number;
  y: number;
  w: number;
  h: number;
  layer: WidgetLayer;
  /** 是否穿透鼠标事件（只展示不交互的组件可以开） */
  clickThrough: boolean;
}

export type ThemeMode = "light" | "dark" | "system";

interface LatticeState {
  placements: Placement[];
  /**
   * 已启用的组件包 id。
   *
   * 平台开箱是空白的 —— 随应用分发的组件包只是"发现到了"，不等于"已安装"。
   * 只有这里列出的包才会出现在画布上。用户目录里的包由磁盘状态决定，
   * 不走这个列表（装上去就是装上了）。
   */
  installedIds: string[];
  /** 已授予的权限，按 widgetId 聚合 */
  grants: Record<string, Permission[]>;
  theme: ThemeMode;
  snapToGrid: boolean;
  selectedInstanceId: string | null;

  addPlacement: (placement: Placement) => void;
  removePlacement: (instanceId: string) => void;
  updatePlacement: (instanceId: string, patch: Partial<Omit<Placement, "instanceId" | "widgetId">>) => void;
  bringToFront: (instanceId: string) => void;
  select: (instanceId: string | null) => void;
  setTheme: (theme: ThemeMode) => void;
  toggleSnap: () => void;
  installWidget: (widgetId: string) => void;
  /** 卸载时连带清掉这个组件在画布上的所有实例，避免留下"组件缺失" */
  uninstallWidget: (widgetId: string) => void;
  grant: (widgetId: string, permission: Permission) => void;
  revoke: (widgetId: string, permission: Permission) => void;
}

export const GRID = 8;

export function snap(value: number, enabled: boolean): number {
  return enabled ? Math.round(value / GRID) * GRID : Math.round(value);
}

export const useLattice = create<LatticeState>()(
  persist(
    (set) => ({
      placements: [],
      installedIds: [],
      grants: {},
      theme: "system",
      snapToGrid: true,
      selectedInstanceId: null,

      addPlacement: (placement) =>
        set((state) => ({
          placements: [...state.placements, placement],
          selectedInstanceId: placement.instanceId,
        })),

      removePlacement: (instanceId) =>
        set((state) => ({
          placements: state.placements.filter((item) => item.instanceId !== instanceId),
          selectedInstanceId:
            state.selectedInstanceId === instanceId ? null : state.selectedInstanceId,
        })),

      updatePlacement: (instanceId, patch) =>
        set((state) => ({
          placements: state.placements.map((item) =>
            item.instanceId === instanceId ? { ...item, ...patch } : item,
          ),
        })),

      bringToFront: (instanceId) =>
        set((state) => {
          const target = state.placements.find((item) => item.instanceId === instanceId);
          if (!target) return state;
          return {
            placements: [...state.placements.filter((item) => item.instanceId !== instanceId), target],
          };
        }),

      select: (instanceId) => set({ selectedInstanceId: instanceId }),

      setTheme: (theme) => set({ theme }),

      toggleSnap: () => set((state) => ({ snapToGrid: !state.snapToGrid })),

      installWidget: (widgetId) =>
        set((state) =>
          state.installedIds.includes(widgetId)
            ? state
            : { installedIds: [...state.installedIds, widgetId] },
        ),

      uninstallWidget: (widgetId) =>
        set((state) => {
          const nextPlacements = state.placements.filter((item) => item.widgetId !== widgetId);
          const nextGrants = { ...state.grants };
          delete nextGrants[widgetId];
          const keepSelection = nextPlacements.some(
            (item) => item.instanceId === state.selectedInstanceId,
          );
          return {
            installedIds: state.installedIds.filter((id) => id !== widgetId),
            placements: nextPlacements,
            grants: nextGrants,
            selectedInstanceId: keepSelection ? state.selectedInstanceId : null,
          };
        }),

      grant: (widgetId, permission) =>
        set((state) => {
          const current = state.grants[widgetId] ?? [];
          if (current.includes(permission)) return state;
          return { grants: { ...state.grants, [widgetId]: [...current, permission] } };
        }),

      revoke: (widgetId, permission) =>
        set((state) => {
          const current = state.grants[widgetId] ?? [];
          return {
            grants: { ...state.grants, [widgetId]: current.filter((item) => item !== permission) },
          };
        }),
    }),
    {
      name: "lattice.platform.v1",
      partialize: (state) => ({
        placements: state.placements,
        installedIds: state.installedIds,
        grants: state.grants,
        theme: state.theme,
        snapToGrid: state.snapToGrid,
      }),
    },
  ),
);

/** 默认把新组件放在画布左上角附近的空位，避免叠在一起 */
export function nextFreeSlot(placements: Placement[], w: number, h: number): { x: number; y: number } {
  const gap = 16;
  let x = 24;
  let y = 24;
  for (let guard = 0; guard < 200; guard += 1) {
    const collides = placements.some(
      (item) =>
        x < item.x + item.w + gap &&
        x + w + gap > item.x &&
        y < item.y + item.h + gap &&
        y + h + gap > item.y,
    );
    if (!collides) return { x, y };
    x += w + gap;
    if (x + w > 1600) {
      x = 24;
      y += h + gap;
    }
  }
  return { x, y };
}
