/**
 * 棂 / Lattice —— 组件目录（catalogue）
 *
 * 目录是一份**静态 JSON**：`registry.json`。没有服务端，也就没有"目录 API"——
 * 一个文件，谁都能放在自己的服务器上、自己的网盘里，或者干脆跟着应用一起发。
 *
 * 这个文件只做纯逻辑：把未知 JSON 校验成 `Catalogue`、从多个版本里挑一个、
 * 算出"该装 / 该更新 / 已经最新 / 来源换了 / 没签名"这几种计划，以及
 * "新版本多要了哪几项权限"。真正的取文件、验签、解包在
 * `src/platform/catalogue.ts` 和 `src-tauri/src/store.rs` 里。
 *
 * # 为什么目录不签名，签的是包
 *
 * 目录里写着"这个包是谁发的、hash 是多少"，但目录本身可以被中间人改 ——
 * 所以目录不是信任的源头，**包上的签名**才是。信任链是：
 *
 *   1. 包字节 → sha256 必须等于目录里写的那一个（挡传输损坏、挡换包）
 *   2. 包字节 → ed25519 签名必须能被 `publisher.key` 验过（挡伪造）
 *   3. `publisher.key` 必须等于这个组件**第一次安装时记下的那把钥匙**（挡换人）
 *
 * 第 3 步是关键：前两步都能被"我另起一把钥匙、另签一个包、连目录一起换掉"绕过。
 * 只有把钥匙钉在本地状态里，换人才会变成一件**用户看得见、必须点一下**的事。
 * 第一次安装没有可钉的东西，只能是"信这次看到的"（TOFU）——所以界面上要
 * 把钥匙指纹露出来，让人有机会对一下。
 */

import { ID_RE, type Permission } from "./manifest";
import { compareVersions, isValidVersion, maxSatisfying, parseVersion } from "./semver";

/** 目录里一个可下载的版本 */
export interface CataloguePackage {
  version: string;
  /** 绝对地址（解析时已按目录地址补全） */
  url: string;
  /** 小写 hex，64 字符 */
  sha256: string;
  /** 字节数，用来在下载前提示"这个包多大" */
  size: number;
  /** 小写 hex，128 字符（ed25519） */
  signature: string;
  /** 这个版本申请了哪些权限。装上之后与本地已授予的做差，就是"新要的" */
  permissions: Permission[];
  /** 这个版本改了什么，可选 */
  notes: string;
}

export interface CataloguePublisher {
  name: string;
  /** ed25519 公钥，小写 hex，64 字符 */
  key: string;
}

export interface CatalogueEntry {
  id: string;
  name: string;
  description: string;
  author: string;
  /** 图标绝对地址；没有就是 null，界面退回"名字首字" */
  icon: string | null;
  homepage: string | null;
  publisher: CataloguePublisher | null;
  /** 按版本**降序**排好，[0] 就是最新 */
  versions: CataloguePackage[];
}

export interface Catalogue {
  schema: number;
  name: string;
  /** 目录的构建日期，ISO 字符串 */
  updated: string;
  /** 目录所在目录的地址，相对 url 按它补全；仅用于展示与解析 */
  base: string;
  entries: CatalogueEntry[];
}

export interface CatalogueParse {
  catalogue: Catalogue | null;
  warnings: string[];
}

export const CATALOGUE_SCHEMA = 1;

const SHA256_RE = /^[0-9a-f]{64}$/;
const SIGNATURE_RE = /^[0-9a-f]{128}$/;
const KEY_RE = /^[0-9a-f]{64}$/;

function text(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value.trim() : fallback;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * 把相对地址补全成绝对地址。
 * `base` 是**目录所在的目录**（以 `/` 结尾），不是 registry.json 自己的地址 ——
 * 少一个 `/` 就会把 `registry.json` 当成目录名拼上去，症状是包全部 404。
 */
export function resolveCatalogueUrl(base: string, relative: string): string {
  const trimmed = relative.trim();
  if (!trimmed) return "";
  if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) return trimmed; // http(s): / data: / file:
  if (trimmed.startsWith("/")) return trimmed;
  const dir = base.endsWith("/") ? base : `${base}/`;
  const cleaned = trimmed.replace(/^\.\//, "");
  try {
    // 用 URL 而不是手拼：`../widgets/x.svg` 这种要真的把上一段吃掉，
    // 否则发出去的地址里带着 `..`，看着就像哪里写错了
    return new URL(cleaned, dir).toString();
  } catch {
    return `${dir}${cleaned}`;
  }
}

/**
 * 校验并归一化一份目录。
 *
 * 坏条目**单独丢弃**，不整包失败 —— 和清单里 `config` / `icon` 的处理同一条原则：
 * 一个作者把某个版本的 hash 写错了，不该让整个商店打不开。
 * 但"整份不是目录"（不是 JSON 对象、schema 不认识）要明确拒绝，因为那时候
 * 屏幕上显示任何东西都是在骗人。
 */
export function parseCatalogue(raw: unknown, base: string): CatalogueParse {
  const warnings: string[] = [];
  const root = record(raw);
  if (!root) return { catalogue: null, warnings: ["the catalogue is not a JSON object"] };

  const schema = typeof root.schema === "number" ? root.schema : 0;
  if (schema !== CATALOGUE_SCHEMA) {
    return {
      catalogue: null,
      warnings: [`unsupported catalogue schema ${schema || "(missing)"} — this build understands ${CATALOGUE_SCHEMA}`],
    };
  }

  /*
   * 目录级的发布者。
   *
   * 一份目录通常就一个发布者（官方目录全是同一把钥匙），让每个条目各写一遍
   * 纯属重复；条目自己想换人时再覆盖。**不能**只认条目上的那一份 ——
   * 那样"目录级写了公钥、条目里没写"会变成"整个商店都没签名"，
   * 而界面上看起来只是每个包都缺了个字段。
   */
  const rootPublisherRaw = record(root.publisher);
  const rootKey = text(rootPublisherRaw?.key).toLowerCase();
  const rootPublisher: CataloguePublisher | null =
    rootPublisherRaw && KEY_RE.test(rootKey)
      ? { name: text(rootPublisherRaw.name) || "unknown publisher", key: rootKey }
      : null;

  const rawEntries = Array.isArray(root.widgets) ? root.widgets : [];
  const entries: CatalogueEntry[] = [];

  for (const item of rawEntries) {
    const entry = record(item);
    if (!entry) {
      warnings.push("dropped an entry that is not an object");
      continue;
    }

    const id = text(entry.id);
    if (!ID_RE.test(id)) {
      warnings.push(`dropped an entry with an illegal id: "${id}"`);
      continue;
    }
    // 同名 id 出现两次时以后者为准没有意义，直接丢掉并说出来
    if (entries.some((existing) => existing.id === id)) {
      warnings.push(`dropped a duplicate entry for ${id}`);
      continue;
    }

    const publisherRaw = record(entry.publisher);
    const key = text(publisherRaw?.key).toLowerCase();
    const publisher =
      publisherRaw && KEY_RE.test(key)
        ? { name: text(publisherRaw.name) || "unknown publisher", key }
        : rootPublisher;

    const rawVersions = Array.isArray(entry.versions) ? entry.versions : [];
    const versions: CataloguePackage[] = [];

    for (const versionItem of rawVersions) {
      const version = record(versionItem);
      if (!version) continue;
      const number = text(version.version);
      if (!isValidVersion(number)) {
        warnings.push(`${id}: dropped version "${number}" (not semver)`);
        continue;
      }
      const sha256 = text(version.sha256).toLowerCase();
      if (!SHA256_RE.test(sha256)) {
        warnings.push(`${id} ${number}: dropped (sha256 must be 64 hex characters)`);
        continue;
      }
      const signature = text(version.signature).toLowerCase();
      if (!SIGNATURE_RE.test(signature)) {
        warnings.push(`${id} ${number}: dropped (signature must be 128 hex characters)`);
        continue;
      }
      const url = resolveCatalogueUrl(base, text(version.url));
      if (!url) {
        warnings.push(`${id} ${number}: dropped (no download url)`);
        continue;
      }
      if (versions.some((existing) => existing.version === number)) {
        warnings.push(`${id}: dropped a duplicate of version ${number}`);
        continue;
      }

      versions.push({
        version: number,
        url,
        sha256,
        size: typeof version.size === "number" && version.size >= 0 ? version.size : 0,
        signature,
        permissions: normalizePermissionList(version.permissions, `${id} ${number}`, warnings),
        notes: text(version.notes),
      });
    }

    if (versions.length === 0) {
      warnings.push(`${id}: dropped (no usable version)`);
      continue;
    }

    versions.sort((a, b) => (compareVersions(b.version, a.version) ?? 0));

    entries.push({
      id,
      name: text(entry.name) || id,
      description: text(entry.description),
      author: text(entry.author) || publisher?.name || "unknown",
      icon: text(entry.icon) ? resolveCatalogueUrl(base, text(entry.icon)) : null,
      homepage: text(entry.homepage) || null,
      publisher,
      versions,
    });
  }

  entries.sort((a, b) => a.name.localeCompare(b.name, "zh-CN"));

  return {
    catalogue: {
      schema,
      name: text(root.name) || "Untitled catalogue",
      updated: text(root.updated),
      base,
      entries,
    },
    warnings,
  };
}

const KNOWN_PERMISSIONS: ReadonlySet<string> = new Set<string>([
  "clock",
  "storage",
  "clipboard:write",
  "network",
  "system:monitor",
  "media:control",
]);

function normalizePermissionList(value: unknown, where: string, warnings: string[]): Permission[] {
  if (!Array.isArray(value)) return [];
  const out: Permission[] = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    if (!KNOWN_PERMISSIONS.has(item)) {
      // 新版本可能申请了这版平台还不认识的权限：说出来，但不影响安装
      warnings.push(`${where}: unknown permission "${item}"`);
      continue;
    }
    if (!out.includes(item as Permission)) out.push(item as Permission);
  }
  return out;
}

/** 目录里最新的那个版本（`versions` 已降序） */
export function latestPackage(entry: CatalogueEntry): CataloguePackage | null {
  return entry.versions[0] ?? null;
}

/**
 * 按范围挑一个版本。没给范围就是最新版；给了范围但一个都不满足就返回 null。
 *
 * `range` 来自将来的"钉住某个大版本"设置，现在只有 UI 不传的情况，
 * 但比较逻辑已经在 `semver.ts` 里钉住了，别在别处再写一遍。
 */
export function pickPackage(entry: CatalogueEntry, range?: string): CataloguePackage | null {
  if (!range || !range.trim() || range.trim() === "*") return latestPackage(entry);
  const version = maxSatisfying(
    entry.versions.map((item) => item.version),
    range,
  );
  if (!version) return null;
  return entry.versions.find((item) => item.version === version) ?? null;
}

export type InstallPlan =
  | { kind: "install"; pkg: CataloguePackage }
  | { kind: "update"; pkg: CataloguePackage; from: string }
  | { kind: "current"; pkg: CataloguePackage }
  | { kind: "unsigned"; pkg: CataloguePackage }
  | { kind: "untrusted"; pkg: CataloguePackage; pinned: string; offered: string };

export interface PlanOptions {
  /** 本地已装的版本，没装就是 null */
  installedVersion?: string | null;
  /** 这个组件第一次安装时记下的公钥，没有就是 null（TOFU 阶段） */
  pinnedKey?: string | null;
  /** 可选：只在这个范围里挑版本 */
  range?: string;
}

/**
 * 决定点下"安装"该做什么。
 *
 * 顺序是有讲究的：**先看签名，再看版本**。反过来的话，一个被换掉的钥匙
 * 会先被报成"有新版本可以更新"，用户点了更新才看到警告 —— 那时候他已经在
 * 期待"更新"了，警告更容易被当成噪音划过去。
 */
export function planInstall(entry: CatalogueEntry, options: PlanOptions = {}): InstallPlan | null {
  const pkg = pickPackage(entry, options.range);
  if (!pkg) return null;

  const offered = entry.publisher?.key ?? "";
  if (!offered) return { kind: "unsigned", pkg };

  const pinned = options.pinnedKey ?? null;
  if (pinned && pinned !== offered) return { kind: "untrusted", pkg, pinned, offered };

  const installed = options.installedVersion ?? null;
  if (!installed) return { kind: "install", pkg };

  const order = compareVersions(pkg.version, installed);
  // 版本号写坏（不该发生，目录已经校验过）时按"没变化"处理，别怂恿用户降级
  if (order === null || order <= 0) return { kind: "current", pkg };
  return { kind: "update", pkg, from: installed };
}

/** 新版本比旧版本多要的权限（顺序跟着新清单走，方便界面上照原样列） */
export function addedPermissions(before: Permission[], after: Permission[]): Permission[] {
  return after.filter((permission) => !before.includes(permission));
}

/**
 * 公钥指纹：前 16 位，四段一组。
 * 只做"人对一眼"，不是校验 —— 校验永远比完整的 64 位 hex。
 */
export function keyFingerprint(key: string): string {
  const clean = key.toLowerCase().replace(/[^0-9a-f]/g, "");
  if (clean.length < 16) return key;
  return clean.slice(0, 16).replace(/(.{4})(?=.)/g, "$1 ");
}

/** 版本比较的薄包装，给界面用（避免各处 import 两个模块） */
export function isNewer(candidate: string, baseline: string): boolean {
  if (!parseVersion(candidate) || !parseVersion(baseline)) return false;
  return (compareVersions(candidate, baseline) ?? 0) > 0;
}
