/**
 * 组件库（含目录段）的组件级检查。
 *
 * `tests/catalogue.html` 钉的是纯逻辑（校验、选版本、安装计划）；这一页把
 * **真正的 LibraryPanel** 挂起来，验的是接线：
 *
 *   1. 目录条目该显示哪个按钮（Install / Update to x / Up to date / Unsigned / 换钥匙）
 *   2. 更新时"多要的权限"有没有被标出来
 *   3. 已安装卡片上的评分、回滚、举报真的接到了回调上
 *   4. 目录里有的条目不在"可安装"里重复出现（同一件事不能有两个说法）
 *   5. 搜索会同时过滤目录段
 *
 * 这些都属于"纯函数对了、界面还是不对"那一类：按钮没接上回调、文案用了
 * 未过滤的那份数据。纯函数测试一条都抓不到。
 */

import { createRoot } from "react-dom/client";
import { act } from "react";
import "../src/styles.css";
import { LibraryPanel } from "../src/platform/LibraryPanel";
import type { StoreBinding } from "../src/platform/CatalogueSection";
import type { Catalogue, CatalogueEntry, CataloguePackage } from "../src/runtime/catalogue";
import type { WidgetRecord } from "../src/runtime/registry";

const lines: string[] = [];
const log = (pass: boolean, text: string) => lines.push((pass ? "PASS " : "FAIL ") + text);
const eq = (actual: unknown, expected: unknown, text: string) =>
  log(
    JSON.stringify(actual) === JSON.stringify(expected),
    `${text}（得到 ${JSON.stringify(actual)}）`,
  );
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const KEY = "11".repeat(32);
const OTHER_KEY = "44".repeat(32);
const SIG = "22".repeat(64);
const SHA = "33".repeat(32);

function record(id: string, name: string, version: string, permissions: string[] = []): WidgetRecord {
  return {
    manifest: {
      id,
      name,
      version,
      description: `${name} description`,
      author: "Lattice",
      entry: "index.html",
      icon: "",
      size: { w: 240, h: 140, minW: 120, minH: 80 },
      layer: "desktop",
      interactive: true,
      permissions: permissions as never,
      config: [],
      appearance: undefined,
      network: undefined,
      sdk: undefined,
    } as never,
    source: "bundled",
    dir: `public/widgets/${id}`,
    entryUrl: `/widgets/${id}/index.html`,
    iconUrl: null,
  };
}

function pkg(version: string, permissions: string[] = ["clock"]): CataloguePackage {
  return {
    version,
    url: `http://x/store/packages/a-${version}.lattice`,
    sha256: SHA,
    size: 2048,
    signature: SIG,
    permissions: permissions as never,
    notes: "",
  };
}

function entry(
  id: string,
  name: string,
  versions: CataloguePackage[],
  publisherKey: string | null = KEY,
): CatalogueEntry {
  return {
    id,
    name,
    description: `${name} from the catalogue`,
    author: "Lattice",
    icon: null,
    homepage: null,
    publisher: publisherKey ? { name: "Lattice", key: publisherKey } : null,
    versions,
  };
}

const catalogue: Catalogue = {
  schema: 1,
  name: "Test catalogue",
  updated: "2026-10-24",
  base: "http://x/store/",
  entries: [
    // 已装 1.0.0 → 更新到 1.1.0，并且多要一项权限
    entry("lattice.clock", "Clock", [pkg("1.1.0", ["clock", "network"]), pkg("1.0.0", ["clock"])]),
    // 没装过 → Install
    entry("lattice.note", "Note", [pkg("0.1.0", ["storage"])]),
    // 已装且同版本 → Up to date
    entry("lattice.todo", "Todo", [pkg("0.2.0", ["storage"])]),
    // 没签名 → 不能装
    entry("lattice.media", "Media", [pkg("0.1.0", ["media:control"])], null),
    // 换过钥匙 → 必须点一次确认
    entry("lattice.sysmon", "System", [pkg("0.1.0", ["system:monitor"])], OTHER_KEY),
  ],
};

const widgets = [
  record("lattice.clock", "Clock", "1.0.0", ["clock"]),
  record("lattice.todo", "Todo", "0.2.0", ["storage"]),
  record("lattice.sysmon", "System", "0.1.0", ["system:monitor"]),
  record("lattice.note", "Note", "0.1.0", ["storage"]),
];

const calls: string[] = [];

const store: StoreBinding = {
  snapshot: {
    catalogue,
    warnings: ["lattice.media 0.1.0: dropped (signature must be 128 hex characters)"],
    error: null,
    origin: "http://x/store/registry.json",
    at: Date.now(),
  },
  busy: false,
  busyId: null,
  installedVersions: new Map([
    ["lattice.clock", "1.0.0"],
    ["lattice.todo", "0.2.0"],
    ["lattice.sysmon", "0.1.0"],
  ]),
  installedPermissions: new Map([
    ["lattice.clock", ["clock"]],
    ["lattice.todo", ["storage"]],
    ["lattice.sysmon", ["system:monitor"]],
  ]),
  pinnedKeys: { "lattice.sysmon": KEY },
  reviews: {},
  onRefresh: () => calls.push("refresh"),
  onInstall: (item, version, acceptNewKey) =>
    calls.push(`install:${item.id}:${version.version}:${acceptNewKey ? "trust" : "normal"}`),
};

const root = createRoot(document.getElementById("stage")!);

function render(overrides: Partial<Parameters<typeof LibraryPanel>[0]> = {}) {
  const props = {
    widgets,
    installedIds: new Set(["lattice.clock", "lattice.todo", "lattice.sysmon"]),
    errors: [],
    loading: false,
    notice: null,
    onDismissNotice: () => {},
    onOpenWidgetsDir: () => {},
    onAdd: () => {},
    onInstall: () => {},
    onInstallPack: () => {},
    onUninstall: (item: WidgetRecord) => calls.push(`uninstall:${item.manifest.id}`),
    store,
    backups: { "lattice.clock": { version: "0.9.0", at: 1 } },
    ratings: { "lattice.todo": { stars: 3, version: "0.2.0", at: "2026-10-24" } },
    onRollback: (item: WidgetRecord) => calls.push(`rollback:${item.manifest.id}`),
    onRate: (item: WidgetRecord, stars: number) => calls.push(`rate:${item.manifest.id}:${stars}`),
    onReport: (item: WidgetRecord) => calls.push(`report:${item.manifest.id}`),
    open: true,
    onToggle: () => {},
    ...overrides,
  };
  act(() => {
    root.render(<LibraryPanel {...props} />);
  });
}

const text = (selector: string) =>
  [...document.querySelectorAll(selector)].map((node) => node.textContent?.trim() ?? "");
const buttons = (label: string) =>
  [...document.querySelectorAll("button")].filter((node) =>
    (node.textContent ?? "").trim().toLowerCase().includes(label.toLowerCase()),
  ) as HTMLButtonElement[];

async function main() {
  render();
  await sleep(60);

  // ---- 1. 目录段 ----
  eq(text(".lattice-store .lattice-lib-section-title")[0], "Test catalogue5", "目录段用的是目录自己的名字");
  log(text(".lattice-store-warnings summary")[0]?.includes("1 entries were skipped") ?? false, "丢弃的条目折叠显示");

  const clockCard = [...document.querySelectorAll<HTMLElement>(".lattice-card.is-store")].find((node) =>
    node.textContent?.includes("lattice.clock"),
  );
  log(Boolean(clockCard), "时钟出现在目录段");
  log(clockCard?.textContent?.includes("Update to 1.1.0") ?? false, "已装旧版本 -> Update to 1.1.0");
  log(
    clockCard?.querySelector(".lattice-perm.is-new")?.textContent === "Network access",
    "多要的权限被单独标出来",
  );
  log(clockCard?.textContent?.includes("Adds Network access") ?? false, "更新按钮下面说清会多要什么");

  const noteCard = [...document.querySelectorAll<HTMLElement>(".lattice-card.is-store")].find((node) =>
    node.textContent?.includes("lattice.note"),
  );
  log(noteCard?.textContent?.includes("Install") ?? false, "没装过 -> Install");

  const todoCard = [...document.querySelectorAll<HTMLElement>(".lattice-card.is-store")].find((node) =>
    node.textContent?.includes("lattice.todo"),
  );
  log(todoCard?.textContent?.includes("Up to date") ?? false, "同版本 -> Up to date");

  const mediaCard = [...document.querySelectorAll<HTMLElement>(".lattice-card.is-store")].find((node) =>
    node.textContent?.includes("lattice.media"),
  );
  log(
    mediaCard?.textContent?.includes("No publisher signature") ?? false,
    "没签名的条目不能装（不是藏起来，而是说明为什么）",
  );

  const sysmonCard = [...document.querySelectorAll<HTMLElement>(".lattice-card.is-store")].find((node) =>
    node.textContent?.includes("lattice.sysmon"),
  );
  log(
    sysmonCard?.textContent?.includes("Publisher key changed") ?? false,
    "换钥匙要说出来",
  );

  // ---- 2. 目录条目不在"可安装"里重复 ----
  const allIds = text(".lattice-card-id");
  eq(
    allIds.filter((id) => id === "lattice.clock").length,
    2,
    "时钟只出现两次：已安装一份、目录一份（不在可安装里再来一份）",
  );

  // ---- 3. 点按钮 ----
  calls.length = 0;
  clockCard?.querySelector<HTMLButtonElement>(".lattice-btn.is-primary")?.click();
  noteCard?.querySelector<HTMLButtonElement>(".lattice-btn.is-primary")?.click();
  sysmonCard?.querySelector<HTMLButtonElement>(".lattice-btn.is-danger")?.click();
  await sleep(20);
  eq(
    calls,
    [
      "install:lattice.clock:1.1.0:normal",
      "install:lattice.note:0.1.0:normal",
      "install:lattice.sysmon:0.1.0:trust",
    ],
    "三个按钮各自带着正确的包与信任标记",
  );

  // ---- 4. 已安装卡片：评分 / 回滚 / 举报 ----
  const installedClock = [...document.querySelectorAll<HTMLElement>(".lattice-card")].find(
    (node) =>
      node.textContent?.includes("lattice.clock") && !node.classList.contains("is-store"),
  );
  log(Boolean(installedClock), "已安装段里也有时钟");

  calls.length = 0;
  installedClock?.querySelectorAll<HTMLButtonElement>(".lattice-star")[3]?.click();
  installedClock
    ?.querySelector<HTMLButtonElement>(".lattice-link-btn.is-tiny")
    ?.click();
  buttons("report")[0]?.click();
  await sleep(20);
  eq(
    calls,
    ["rate:lattice.clock:4", "rollback:lattice.clock", "report:lattice.clock"],
    "评分、回滚、举报都接上了",
  );

  // 已有 3 星的待办：再点第 3 颗应该是"取消"，不是"打 3 星"
  const installedTodo = [...document.querySelectorAll<HTMLElement>(".lattice-card")].find(
    (node) => node.textContent?.includes("lattice.todo") && !node.classList.contains("is-store"),
  );
  calls.length = 0;
  installedTodo?.querySelectorAll<HTMLButtonElement>(".lattice-star")[2]?.click();
  await sleep(20);
  eq(calls, ["rate:lattice.todo:0"], "点同一颗星是取消评分");

  // ---- 5. 待复核的组件带 Review 标记 ----
  render({ store: { ...store, reviews: { "lattice.clock": { version: "1.1.0", added: ["network"], at: "" } } } });
  await sleep(60);
  const reviewChip = [...document.querySelectorAll(".lattice-card")].find(
    (node) => node.textContent?.includes("lattice.clock") && node.textContent?.includes("Review"),
  );
  log(Boolean(reviewChip), "有待复核权限的组件在卡片上带 Review");

  // ---- 6. 搜索同时过滤目录段 ----
  render();
  await sleep(60);
  const search = document.querySelector<HTMLInputElement>(".lattice-lib-search-input");
  if (search) {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    act(() => {
      setter?.call(search, "media");
      search.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await sleep(80);
    eq(text(".lattice-card-id"), ["lattice.media"], "搜索后只剩命中的目录条目");
  } else {
    log(false, "找不到搜索框");
  }

  document.getElementById("out")!.innerHTML = lines
    .map((line) => `<span class="${line.startsWith("PASS") ? "ok" : "bad"}">${line}</span>`)
    .join("\n");
  (window as unknown as { __done: boolean }).__done = true;
}

void main();
