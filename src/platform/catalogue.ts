/**
 * 棂 / Lattice —— 组件目录的客户端
 *
 * `runtime/catalogue.ts` 只做纯逻辑（校验、选版本、算安装计划），这里负责
 * 真正跑起来的那一半：取目录、下载包、验签安装、回滚、写举报。
 *
 * # 两条路
 *
 * - **内置目录**：`<应用源>/store/registry.json`，包也在同一个目录下。
 *   走浏览器 `fetch`（同源，没有 CORS 问题），拿到字节后 base64 送进 Rust。
 * - **远端目录**：用户自己填的地址。**必须走 Rust**：主窗口 `fetch` 一个
 *   第三方域名会被 CORS 挡掉，而目录作者没理由为了 Lattice 去配响应头。
 *   `store_fetch_text` / `store_download` 用 WinHTTP 取，顺带把"只 http(s)、
 *   只 GET、有大小上限、不跟重定向"这套形状约束落在平台侧。
 *
 * 两条路最后都汇到 `store_install`：**校验只在 Rust 里做一次**。
 * 前端不做验签 —— 前端跑的是不可信代码的宿主页，让它"顺便校验一下"
 * 只会让人以为多了一道保险。
 */

import { invoke } from "@tauri-apps/api/core";
import {
  parseCatalogue,
  type Catalogue,
  type CatalogueEntry,
  type CataloguePackage,
} from "../runtime/catalogue";
import { appBaseUrl, isTauri } from "../runtime/registry";
import type { CatalogueSource } from "./store";

export interface CatalogueSnapshot {
  catalogue: Catalogue | null;
  /** 丢弃了哪些条目、为什么 —— 界面折叠显示，不刷屏 */
  warnings: string[];
  error: string | null;
  /** 目录地址，界面上显示"从哪儿读的" */
  origin: string;
  at: number;
}

export interface StoreInstallResult {
  id: string;
  version: string;
  previousVersion: string | null;
  backedUp: boolean;
}

export interface BackupInfo {
  version: string | null;
  at: number | null;
}

export interface RollbackResult {
  version: string | null;
  replaced: string | null;
}

export interface DownloadResult {
  path: string;
  sha256: string;
  size: number;
}

function dirOf(url: string): string {
  const cut = url.lastIndexOf("/");
  return cut >= 0 ? url.slice(0, cut + 1) : url;
}

/** 目录里每个条目当前该做什么，界面直接照这个画 */
export type EntryState =
  | { kind: "install"; pkg: CataloguePackage }
  | { kind: "update"; pkg: CataloguePackage; from: string }
  | { kind: "current"; pkg: CataloguePackage }
  | { kind: "unsigned"; pkg: CataloguePackage }
  | { kind: "untrusted"; pkg: CataloguePackage; pinned: string; offered: string };

export async function loadCatalogue(source: CatalogueSource): Promise<CatalogueSnapshot> {
  const at = Date.now();
  const bundled = source.kind === "bundled" || !source.url.trim();
  const url = bundled ? `${appBaseUrl()}store/registry.json` : source.url.trim();

  let text: string;
  try {
    if (bundled) {
      const response = await fetch(url, { cache: "no-store" });
      if (!response.ok) {
        return {
          catalogue: null,
          warnings: [],
          error: `the bundled catalogue is missing (HTTP ${response.status}) — run npm run store:index`,
          origin: url,
          at,
        };
      }
      text = await response.text();
    } else {
      if (!isTauri()) {
        return {
          catalogue: null,
          warnings: [],
          error: "a remote catalogue needs the desktop app — run npm run tauri:dev",
          origin: url,
          at,
        };
      }
      text = await invoke<string>("store_fetch_text", { url });
    }
  } catch (error) {
    return { catalogue: null, warnings: [], error: String(error), origin: url, at };
  }

  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    return {
      catalogue: null,
      warnings: [],
      error: `the catalogue is not valid JSON: ${String(error)}`,
      origin: url,
      at,
    };
  }

  const parsed = parseCatalogue(raw, dirOf(url));
  return {
    catalogue: parsed.catalogue,
    warnings: parsed.warnings,
    error: parsed.catalogue ? null : parsed.warnings[0] ?? "the catalogue could not be read",
    origin: url,
    at,
  };
}

function toBase64(bytes: Uint8Array): string {
  // 分块拼接：`String.fromCharCode(...bytes)` 在几十 KB 上就会爆调用栈
  const chunk = 0x8000;
  let binary = "";
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
  }
  return btoa(binary);
}

/**
 * 装一个来自目录的包。
 *
 * 内置目录要把字节自己取回来（同源 fetch），远端目录让 Rust 下到缓存再读 ——
 * 后者是为了不让几 MB 的字节在 IPC 上走两趟。
 *
 * `entry.publisher.key` 必须存在：`planInstall` 已经把"没签名"挡在界面外了，
 * 这里是第二道 —— 万一哪天有人绕过界面直接调，也不该装进一个没签名的包。
 */
export async function installCataloguePackage(
  source: CatalogueSource,
  entry: CatalogueEntry,
  pkg: CataloguePackage,
): Promise<StoreInstallResult> {
  const key = entry.publisher?.key;
  if (!key) throw new Error(`${entry.id} has no publisher key — refusing to install an unsigned package`);

  const common = {
    id: entry.id,
    version: pkg.version,
    sha256: pkg.sha256,
    signature: pkg.signature,
    publicKey: key,
  };

  if (source.kind === "bundled") {
    const response = await fetch(pkg.url, { cache: "no-store" });
    if (!response.ok) throw new Error(`could not download ${pkg.url} (HTTP ${response.status})`);
    const bytes = new Uint8Array(await response.arrayBuffer());
    return invoke<StoreInstallResult>("store_install", { ...common, bytes: toBase64(bytes) });
  }

  const download = await invoke<DownloadResult>("store_download", { url: pkg.url });
  return invoke<StoreInstallResult>("store_install", { ...common, path: download.path });
}

export async function backupInfo(id: string): Promise<BackupInfo | null> {
  if (!isTauri()) return null;
  try {
    return await invoke<BackupInfo | null>("widget_backup_info", { id });
  } catch {
    return null;
  }
}

export async function rollbackWidget(id: string): Promise<RollbackResult> {
  return invoke<RollbackResult>("widget_rollback", { id });
}

export interface ReportInput {
  id: string;
  version: string;
  reason: string;
  note: string;
  stars: number | null;
}

/** 写一份举报文件，返回它的路径（界面把它显示出来，让用户自己去发） */
export async function reportWidget(input: ReportInput): Promise<string> {
  return invoke<string>("store_report", {
    id: input.id,
    version: input.version,
    reason: input.reason,
    note: input.note,
    stars: input.stars,
  });
}
