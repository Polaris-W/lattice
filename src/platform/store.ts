/**
 * 棂 / Lattice —— 平台状态
 *
 * 只存"用户配置"这一层：组件摆放、层级、已授权权限、主题。
 * 组件自己的业务数据不在这里，走 storage 桥按 widgetId 隔离。
 */

import { invoke } from "@tauri-apps/api/core";
import { create } from "zustand";
import { createJSONStorage, persist, type StateStorage } from "zustand/middleware";
import type { Permission, WidgetLayer } from "../runtime/manifest";

/**
 * 状态存哪儿。
 *
 * 桌面端存文件（见 src-tauri/src/state.rs）：这台机器上 WebView2 的
 * localStorage 只活在内存里，进程一退布局就没了。浏览器里预览时退回
 * localStorage，至少刷新页面不丢。
 */
const STATE_FILE = "lattice.platform.v1";

function inTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/**
 * 水合完成前不许写盘。
 *
 * 读状态是异步的，这中间只要有一次 set，persist 就会把"默认空状态"盖到
 * 磁盘上，把用户上次的布局冲掉。所以先读后写。
 */
let hydrated = false;

const platformStorage: StateStorage = {
  getItem: async (name) => {
    if (!inTauri()) return localStorage.getItem(name);
    try {
      return await invoke<string | null>("state_read");
    } catch (error) {
      console.error("读取平台状态失败", error);
      return null;
    }
  },
  setItem: async (name, value) => {
    if (!hydrated) return;
    if (!inTauri()) {
      localStorage.setItem(name, value);
      return;
    }
    try {
      await invoke("state_write", { json: value });
    } catch (error) {
      console.error("保存平台状态失败", error);
    }
  },
  removeItem: async (name) => {
    if (!inTauri()) {
      localStorage.removeItem(name);
      return;
    }
    try {
      await invoke("state_clear");
    } catch (error) {
      console.error("清除平台状态失败", error);
    }
  },
};

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
  /**
   * 别针：锁住位置与大小。
   *
   * 桌面态下组件是可以随便拖、随便缩的，锁住之后宿主页会把拖拽与缩放手柄收掉。
   * 老版本存下来的 placement 没有这个字段，读的时候按 false 处理。
   */
  pinned: boolean;
}

/** 桌面态下某个实例的真实窗口矩形（屏幕坐标，逻辑像素） */
export interface DesktopRect {
  x: number;
  y: number;
  w: number;
  h: number;
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
  /** 是否已把组件投放到真实桌面（运行态）。不持久化，重启回到设计态 */
  desktopMode: boolean;
  /**
   * 桌面态下每个实例的窗口矩形，按 instanceId 索引。
   *
   * 为什么不复用 placement.x/y：画布坐标是相对画布的，窗口坐标是相对屏幕的，
   * 两者基准不同。用户在桌面上把组件拖到哪儿，只有这里知道；下次再投放时
   * 优先用它，否则才从画布坐标推。
   */
  desktopRects: Record<string, DesktopRect>;

  addPlacement: (placement: Placement) => void;
  removePlacement: (instanceId: string) => void;
  updatePlacement: (instanceId: string, patch: Partial<Omit<Placement, "instanceId" | "widgetId">>) => void;
  bringToFront: (instanceId: string) => void;
  select: (instanceId: string | null) => void;
  setTheme: (theme: ThemeMode) => void;
  toggleSnap: () => void;
  setDesktopMode: (enabled: boolean) => void;
  setDesktopRect: (instanceId: string, rect: DesktopRect) => void;
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
      desktopMode: false,
      desktopRects: {},

      addPlacement: (placement) =>
        set((state) => ({
          placements: [...state.placements, placement],
          selectedInstanceId: placement.instanceId,
        })),

      removePlacement: (instanceId) =>
        set((state) => {
          const nextRects = { ...state.desktopRects };
          delete nextRects[instanceId];
          return {
            placements: state.placements.filter((item) => item.instanceId !== instanceId),
            desktopRects: nextRects,
            selectedInstanceId:
              state.selectedInstanceId === instanceId ? null : state.selectedInstanceId,
          };
        }),

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

      setDesktopMode: (enabled) => set({ desktopMode: enabled }),

      setDesktopRect: (instanceId, rect) =>
        set((state) => {
          const current = state.desktopRects[instanceId];
          if (
            current &&
            current.x === rect.x &&
            current.y === rect.y &&
            current.w === rect.w &&
            current.h === rect.h
          ) {
            return state;
          }
          return { desktopRects: { ...state.desktopRects, [instanceId]: rect } };
        }),

      installWidget: (widgetId) =>
        set((state) =>
          state.installedIds.includes(widgetId)
            ? state
            : { installedIds: [...state.installedIds, widgetId] },
        ),

      uninstallWidget: (widgetId) =>
        set((state) => {
          const removed = state.placements.filter((item) => item.widgetId === widgetId);
          const nextPlacements = state.placements.filter((item) => item.widgetId !== widgetId);
          const nextGrants = { ...state.grants };
          delete nextGrants[widgetId];
          const nextRects = { ...state.desktopRects };
          for (const item of removed) delete nextRects[item.instanceId];
          const keepSelection = nextPlacements.some(
            (item) => item.instanceId === state.selectedInstanceId,
          );
          return {
            installedIds: state.installedIds.filter((id) => id !== widgetId),
            placements: nextPlacements,
            desktopRects: nextRects,
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
      name: STATE_FILE,
      storage: createJSONStorage(() => platformStorage),
      onRehydrateStorage: () => (_state, error) => {
        if (error) console.error("平台状态水合失败", error);
        hydrated = true;
      },
      partialize: (state) => ({
        placements: state.placements,
        installedIds: state.installedIds,
        grants: state.grants,
        theme: state.theme,
        snapToGrid: state.snapToGrid,
        desktopRects: state.desktopRects,
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
