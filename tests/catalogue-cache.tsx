/**
 * 目录缓存 / 断网兜底 / 默认源迁移。
 *
 * 这一页钉的是三件"平时看不见、坏了很难解释"的事：
 *
 *   1. **默认源是官方目录**，而旧盘上的状态（内置 + 空地址）会被迁移过去。
 *      不迁的话这个改动只对新装的机器生效 —— 用了一阵的人永远停在演示目录上。
 *   2. **旧的/兜底的目录要明说**。`notice` 有值时界面上必须出现那一条，
 *      而且**条目照常渲染**（不是整段变成错误块）—— 断网时还能装已经缓存的
 *      东西，这才是缓存的意义。
 *   3. **时间要写成人话**。"3 小时前"和 "3 小时 12 分前"对用户的判断没区别。
 *
 * 真正的网络与磁盘那一半在 `catalogue_policy.rs`（编解码、ETag、文件名）
 * 和 `store.rs::store_load_catalogue`（304 / 200 / 失败 + 缓存），
 * 那些只能在真机验，见 AGENTS 的验收清单。
 */

import { createRoot } from "react-dom/client";
import { act } from "react";
import "../src/styles.css";
import { CatalogueSection, type StoreBinding } from "../src/platform/CatalogueSection";
import { describeAge, type CatalogueSnapshot } from "../src/platform/catalogue";
import {
  isOfficialCatalogue,
  migrateState,
  OFFICIAL_CATALOGUE_URL,
  useLattice,
  type CatalogueSource,
} from "../src/platform/store";
import type { Catalogue, CatalogueEntry, CataloguePackage } from "../src/runtime/catalogue";

const lines: string[] = [];
const log = (pass: boolean, text: string) => lines.push((pass ? "PASS " : "FAIL ") + text);
const eq = (actual: unknown, expected: unknown, text: string) =>
  log(
    JSON.stringify(actual) === JSON.stringify(expected),
    `${text}（得到 ${JSON.stringify(actual)}）`,
  );
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const KEY = "11".repeat(32);
const SIG = "22".repeat(64);
const SHA = "33".repeat(32);

function pkg(version: string): CataloguePackage {
  return {
    version,
    url: `http://x/store/packages/a-${version}.lattice`,
    sha256: SHA,
    size: 2048,
    signature: SIG,
    permissions: ["clock"] as never,
    notes: "",
  };
}

function entry(id: string, name: string): CatalogueEntry {
  return {
    id,
    name,
    description: `${name} from the catalogue`,
    author: "Lattice",
    icon: null,
    homepage: null,
    publisher: { name: "Lattice", key: KEY },
    versions: [pkg("1.0.0")],
  };
}

const catalogue: Catalogue = {
  schema: 1,
  name: "Test catalogue",
  updated: "2026-10-24",
  base: "http://x/store/",
  entries: [entry("lattice.clock", "Clock"), entry("lattice.note", "Note")],
};

function snapshot(notice: CatalogueSnapshot["notice"]): CatalogueSnapshot {
  return {
    catalogue,
    warnings: [],
    error: null,
    origin: "http://x/store/registry.json",
    at: Date.now(),
    notice,
  };
}

function binding(notice: CatalogueSnapshot["notice"]): StoreBinding {
  return {
    snapshot: snapshot(notice),
    busy: false,
    busyId: null,
    installedVersions: new Map(),
    installedPermissions: new Map(),
    pinnedKeys: {},
    blockedKeys: [],
    reviews: {},
    onRefresh: () => {},
    onInstall: () => {},
    onBlockKey: () => {},
    onUnblockKey: () => {},
  };
}

// ---------------------------------------------------------------------------
// 1. 官方目录的判定
// ---------------------------------------------------------------------------

eq(isOfficialCatalogue(OFFICIAL_CATALOGUE_URL), true, "官方地址认成官方");
eq(isOfficialCatalogue(` ${OFFICIAL_CATALOGUE_URL}/ `), true, "前后空格和尾斜杠不影响判定");
eq(isOfficialCatalogue(`${OFFICIAL_CATALOGUE_URL}?x=1`), false, "带 query 的不是官方那一份");
eq(isOfficialCatalogue(""), false, "空地址不是官方");
eq(
  isOfficialCatalogue("https://example.com/registry.json"),
  false,
  "别人的目录不是官方",
);

// ---------------------------------------------------------------------------
// 2. 老状态迁移
// ---------------------------------------------------------------------------

const migrated = migrateState({ catalogueSource: { kind: "bundled", url: "" } }, 0);
eq(
  (migrated.catalogueSource as CatalogueSource).url,
  OFFICIAL_CATALOGUE_URL,
  "旧默认（内置 + 空地址）迁到官方目录",
);

const custom = migrateState({ catalogueSource: { kind: "url", url: "https://me.example/reg.json" } }, 0);
eq(
  (custom.catalogueSource as CatalogueSource).url,
  "https://me.example/reg.json",
  "用户自己填过的地址一个字都不动",
);

eq(
  migrateState({ placements: [] }, 0).catalogueSource,
  { kind: "url", url: OFFICIAL_CATALOGUE_URL },
  "连 catalogueSource 都没有的更早状态，也落到官方目录",
);

const kept = migrateState({ catalogueSource: { kind: "bundled", url: "" } }, 1);
eq(
  (kept.catalogueSource as CatalogueSource).kind,
  "bundled",
  "已经是 v1 的状态不再迁移（用户主动选了内置就要留住）",
);

// 新装：没有盘上状态时，store 的默认值本身就是官方目录
eq(
  useLattice.getState().catalogueSource.url,
  OFFICIAL_CATALOGUE_URL,
  "默认目录源就是官方那一份",
);

// ---------------------------------------------------------------------------
// 3. 时间写成人话
// ---------------------------------------------------------------------------

const now = Date.UTC(2026, 9, 24, 12, 0, 0);
const ago = (seconds: number) => describeAge(now / 1000 - seconds, now);
eq(ago(30), "just now", "半分钟前是 just now");
eq(ago(300), "5 minutes ago", "5 分钟");
eq(ago(3 * 3600), "3 hours ago", "3 小时");
eq(ago(3 * 86400), "3 days ago", "3 天");

// ---------------------------------------------------------------------------
// 4. 界面：旧的/兜底的目录要说出来，但条目照常渲染
// ---------------------------------------------------------------------------

const stage = document.getElementById("stage")!;
const root = createRoot(stage);

async function render(notice: CatalogueSnapshot["notice"]): Promise<void> {
  await act(async () => {
    root.render(
      <CatalogueSection store={binding(notice)} tokens={[]} installedIds={new Set()} />,
    );
  });
  await sleep(40);
  /*
   * 目录段默认收着。这一页验的是"旧目录的条目照常渲染"，
   * 所以渲染完像用户那样点开一下 —— 折叠本身在 `store-ui` 里钉着。
   */
  const toggle = document.querySelector<HTMLButtonElement>(".lattice-lib-section-toggle");
  if (toggle?.getAttribute("aria-expanded") === "false") {
    act(() => toggle.click());
    await sleep(30);
  }
}

const text = (selector: string) =>
  [...document.querySelectorAll(selector)].map((node) => node.textContent?.trim() ?? "");

async function main() {
  await render({
    kind: "stale",
    message: "https://x/registry.json could not be reached (timeout). Showing the copy from 3 hours ago.",
  });

  eq(text(".lattice-lib-note.is-stale .lattice-lib-note-title"), ["Showing an older copy"], "断网时标题写明是旧的一份");
  log(
    (document.querySelector(".lattice-lib-note.is-stale")?.textContent ?? "").includes("3 hours ago"),
    "提示里带上了这份目录有多旧",
  );
  eq(text(".lattice-card-id"), ["lattice.clock", "lattice.note"], "有旧目录时条目照常渲染（不是整段错误）");

  await render({
    kind: "fallback",
    message: "https://x/registry.json could not be reached. This is the catalogue that ships with the app.",
  });
  eq(text(".lattice-lib-note.is-stale .lattice-lib-note-title"), ["Offline"], "退回内置那份时标题写 Offline");

  await render(null);
  eq(document.querySelector(".lattice-lib-note.is-stale"), null, "正常读到目录时不显示这条提示");
  eq(text(".lattice-card-id"), ["lattice.clock", "lattice.note"], "正常状态下条目还在");

  document.getElementById("out")!.innerHTML = lines
    .map((line) => `<span class="${line.startsWith("PASS") ? "ok" : "bad"}">${line}</span>`)
    .join("\n");
  (window as unknown as { __done: boolean }).__done = true;
}

void main();
