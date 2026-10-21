/**
 * 棂 / Lattice —— 小组件注册表
 *
 * 两个来源，合并成一个列表：
 *   - bundled：随应用分发的内置组件，文件在 public/widgets 里，
 *              构建时由 scripts/widget-index.mjs 生成 index.json
 *   - user   ：用户安装的组件，位于 %APPDATA%/<identifier>/widgets，由 Rust 扫描
 *
 * 已知限制（v0.1）：用户组件的文件在磁盘上、不在前端资源里，
 * 需要 lattice-widget:// 自定义协议才能加载。协议接好之前这类组件
 * 会以 entryUrl = null 返回，UI 会显示"待接入"，而不是白屏。
 */

import { invoke } from "@tauri-apps/api/core";
import { ManifestError, normalizeManifest, type WidgetManifest } from "./manifest";

export type WidgetSource = "bundled" | "user";

export interface WidgetRecord {
  manifest: WidgetManifest;
  source: WidgetSource;
  /** 磁盘目录，用于展示与排错 */
  dir: string;
  /** iframe 可直接加载的地址；null 表示当前还加载不了 */
  entryUrl: string | null;
}

export interface WidgetLoadError {
  dir: string;
  message: string;
}

export interface RegistrySnapshot {
  widgets: WidgetRecord[];
  errors: WidgetLoadError[];
}

/** Rust 侧 list_widgets 的返回结构 */
interface RawInstalledWidget {
  manifest: unknown;
  dir: string;
  source: WidgetSource;
}

export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

function assetBase(): string {
  const base = import.meta.env.BASE_URL || "/";
  return base.endsWith("/") ? base : `${base}/`;
}

export async function loadRegistry(): Promise<RegistrySnapshot> {
  const [bundled, user] = await Promise.all([loadBundled(), loadUser()]);

  const widgets: WidgetRecord[] = [];
  const errors: WidgetLoadError[] = [];

  for (const raw of [...bundled, ...user]) {
    try {
      const manifest = normalizeManifest(raw.manifest, dirName(raw.dir));
      widgets.push({
        manifest,
        source: raw.source,
        dir: raw.dir,
        entryUrl: raw.source === "bundled" ? resolveEntryUrl(manifest) : null,
      });
    } catch (error) {
      errors.push({
        dir: raw.dir,
        message: error instanceof ManifestError ? error.message : String(error),
      });
    }
  }

  widgets.sort((a, b) => a.manifest.name.localeCompare(b.manifest.name, "zh-CN"));
  return { widgets, errors };
}

/** 内置组件的入口地址 */
export function resolveEntryUrl(manifest: WidgetManifest): string {
  return `${assetBase()}widgets/${manifest.id}/${manifest.entry.replace(/^\/+/, "")}`;
}

async function loadBundled(): Promise<RawInstalledWidget[]> {
  let ids: string[];
  try {
    const response = await fetch(`${assetBase()}widgets/index.json`, { cache: "no-store" });
    if (!response.ok) return [];
    ids = (await response.json()) as string[];
  } catch {
    return [];
  }

  const out: RawInstalledWidget[] = [];
  for (const id of ids) {
    try {
      const response = await fetch(`${assetBase()}widgets/${id}/manifest.json`, { cache: "no-store" });
      if (!response.ok) continue;
      out.push({
        manifest: await response.json(),
        dir: `public/widgets/${id}`,
        source: "bundled",
      });
    } catch {
      // 单个内置组件清单坏掉不该拖垮整个注册表
    }
  }
  return out;
}

async function loadUser(): Promise<RawInstalledWidget[]> {
  if (!isTauri()) return [];
  try {
    return await invoke<RawInstalledWidget[]>("list_widgets");
  } catch {
    return [];
  }
}

function dirName(dir: string): string {
  const parts = dir.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? dir;
}
