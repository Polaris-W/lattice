/**
 * 棂 / Lattice —— 组件库里的"目录"段
 *
 * 这一段回答的问题是"**还能装什么**"，和上面两段的区别是：这里的条目来自
 * 一份外部 JSON，不是磁盘上已经有的东西。所以每张卡片都要说清三件事：
 *
 *   1. 从哪儿来（Bundled / 远端目录的名字）
 *   2. 签名状态（谁签的、钥匙指纹；换过人要点一次确认；被拉黑的一律不能装）
 *   3. 点下去会发生什么（安装 / 更新到 x.y.z / 已经最新 / 目录落后了 / 不能装）
 *
 * 界面上的判断全部来自 `runtime/catalogue.ts::planInstall` —— 这里不再算一遍。
 * "拉黑"和"换人了"和"有新版本"谁优先这种顺序，只应该在一个地方决定（有单测钉着）。
 */

import { useMemo } from "react";
import {
  addedPermissions,
  isBlockedKey,
  keyFingerprint,
  planInstall,
  type CatalogueEntry,
  type CataloguePackage,
} from "../runtime/catalogue";
import { PERMISSION_LABELS, type Permission } from "../runtime/manifest";
import type { CatalogueSnapshot } from "./catalogue";
import type { PermissionReview } from "./store";
import { Glyph, ICON } from "./icons";

export interface StoreBinding {
  snapshot: CatalogueSnapshot | null;
  /** 正在读目录 */
  busy: boolean;
  /** 正在装的那一个（卡片上转圈，别的按钮禁用） */
  busyId: string | null;
  /** 已安装组件的版本与权限，按 widgetId */
  installedVersions: Map<string, string>;
  installedPermissions: Map<string, Permission[]>;
  /** 第一次安装时记下的发布者公钥 */
  pinnedKeys: Record<string, string>;
  /** 用户拉黑的发布者公钥（归一化后的 hex） */
  blockedKeys: string[];
  /** 待确认的"新版本多要了权限" */
  reviews: Record<string, PermissionReview>;
  onRefresh: () => void;
  onInstall: (entry: CatalogueEntry, pkg: CataloguePackage, acceptNewKey: boolean) => void;
  /** 拉黑一把钥匙（"这人的东西我不装"，以及换钥匙时"旧的那把可能泄露了"） */
  onBlockKey: (key: string) => void;
  onUnblockKey: (key: string) => void;
}

interface CatalogueSectionProps {
  store: StoreBinding;
  /** 搜索词（已切分）；空数组表示没在搜 */
  tokens: string[];
  installedIds: Set<string>;
}

function matches(entry: CatalogueEntry, tokens: string[]): boolean {
  if (tokens.length === 0) return true;
  const haystack = [
    entry.name,
    entry.id,
    entry.description,
    entry.author,
    ...entry.versions.flatMap((item) => item.permissions.map((p) => PERMISSION_LABELS[p])),
  ]
    .join(" ")
    .toLowerCase();
  return tokens.every((token) => haystack.includes(token));
}

export function CatalogueSection({ store, tokens, installedIds }: CatalogueSectionProps) {
  const { snapshot } = store;

  const entries = useMemo(() => {
    const list = snapshot?.catalogue?.entries ?? [];
    return list.filter((entry) => matches(entry, tokens));
  }, [snapshot, tokens]);

  if (!snapshot) return null;

  // 目录坏了要说出来，但不能占满整个面板 —— 上面两段还能正常工作
  if (snapshot.error) {
    return (
      <section className="lattice-lib-section lattice-store">
        <h3 className="lattice-lib-section-title">
          Catalogue
          <span>{snapshot.catalogue ? "" : "offline"}</span>
        </h3>
        <div className="lattice-lib-note">
          <p className="lattice-lib-note-title">The catalogue could not be read</p>
          <p className="lattice-hint">{snapshot.error}</p>
          <button type="button" className="lattice-btn is-small" onClick={store.onRefresh}>
            Try again
          </button>
        </div>
      </section>
    );
  }

  if (!snapshot.catalogue) return null;

  const name = snapshot.catalogue.name;
  const updated = snapshot.catalogue.updated;

  return (
    <section className="lattice-lib-section lattice-store">
      <h3 className="lattice-lib-section-title">
        {name}
        <span>{store.busy ? "loading…" : entries.length}</span>
        <button
          type="button"
          className={`lattice-icon-btn is-tiny${store.busy ? " is-spinning" : ""}`}
          onClick={store.onRefresh}
          title={updated ? `Catalogue updated ${updated} — click to reload` : "Reload the catalogue"}
          aria-label="Reload the catalogue"
        >
          <Glyph d={ICON.refresh} size={12} />
        </button>
      </h3>

      {snapshot.notice && (
        <div className="lattice-lib-note is-stale">
          <p className="lattice-lib-note-title">
            {snapshot.notice.kind === "stale" ? "Showing an older copy" : "Offline"}
          </p>
          <p className="lattice-hint">{snapshot.notice.message}</p>
          <button type="button" className="lattice-btn is-small" onClick={store.onRefresh}>
            Try again
          </button>
        </div>
      )}

      {snapshot.warnings.length > 0 && (
        <details className="lattice-store-warnings">
          <summary>{snapshot.warnings.length} entries were skipped</summary>
          <ul>
            {snapshot.warnings.slice(0, 8).map((line, index) => (
              <li key={`${line}-${index}`}>{line}</li>
            ))}
          </ul>
        </details>
      )}

      {entries.length === 0 && (
        <p className="lattice-hint">
          {tokens.length > 0 ? "Nothing in the catalogue matches your search." : "This catalogue is empty."}
        </p>
      )}

      {entries.map((entry) => (
        <CatalogueCard key={entry.id} entry={entry} store={store} installed={installedIds.has(entry.id)} />
      ))}
    </section>
  );
}

function CatalogueCard({
  entry,
  store,
  installed,
}: {
  entry: CatalogueEntry;
  store: StoreBinding;
  installed: boolean;
}) {
  const pinned = store.pinnedKeys[entry.id] ?? null;
  const currentVersion = store.installedVersions.get(entry.id) ?? null;
  const plan = planInstall(entry, {
    installedVersion: currentVersion,
    pinnedKey: pinned,
    blockedKeys: store.blockedKeys,
  });
  const review = store.reviews[entry.id];
  const busy = store.busyId === entry.id;

  if (!plan) return null;

  const before = store.installedPermissions.get(entry.id) ?? [];
  const added = addedPermissions(before, plan.pkg.permissions);
  const key = entry.publisher?.key ?? "";
  /** 换钥匙那一支里，"旧的那把"是不是已经被拉黑了 —— 拉过就别再给一次按钮 */
  const pinnedBlocked =
    plan.kind === "untrusted" && isBlockedKey(plan.pinned, store.blockedKeys);

  return (
    <div className={`lattice-card is-store${installed ? " is-installed" : ""}`}>
      <div className="lattice-card-top">
        <span className="lattice-card-glyph" aria-hidden>
          {entry.icon ? (
            <img className="lattice-card-glyph-img" src={entry.icon} alt="" width={17} height={17} />
          ) : (
            entry.name.trim().slice(0, 1)
          )}
        </span>
        <span className="lattice-card-heading">
          <span className="lattice-card-name">{entry.name}</span>
          <code className="lattice-card-id">{entry.id}</code>
        </span>
        {plan.kind === "blocked" ? (
          <span className="lattice-chip is-warn">Blocked</span>
        ) : review ? (
          <span className="lattice-chip is-warn">Review</span>
        ) : installed ? (
          <span className="lattice-chip is-accent">Installed</span>
        ) : (
          <span className="lattice-chip">{entry.publisher ? "Signed" : "Unsigned"}</span>
        )}
      </div>

      <p className="lattice-card-desc">{entry.description || "No description yet"}</p>

      <div className="lattice-card-meta">
        <span className="lattice-mono">v{plan.pkg.version}</span>
        <span className="lattice-mono">{entry.author}</span>
        {plan.pkg.size > 0 && (
          <span className="lattice-mono">{Math.max(1, Math.round(plan.pkg.size / 1024))} KB</span>
        )}
      </div>

      {plan.pkg.permissions.length > 0 && (
        <div className="lattice-perm-list">
          {plan.pkg.permissions.map((permission) => (
            <span
              key={permission}
              className={`lattice-perm${added.includes(permission) ? " is-new" : ""}`}
              title={added.includes(permission) ? "This version asks for a permission you have not granted" : undefined}
            >
              {PERMISSION_LABELS[permission]}
            </span>
          ))}
        </div>
      )}

      {key && (
        <p className="lattice-store-key" title={`ed25519 ${key}`}>
          Signed by {entry.publisher?.name} · {keyFingerprint(key)}
        </p>
      )}

      <div className="lattice-card-actions">
        {plan.kind === "install" && (
          <button
            type="button"
            className="lattice-btn is-small is-primary"
            disabled={busy}
            onClick={() => store.onInstall(entry, plan.pkg, false)}
          >
            {busy ? "Installing…" : "Install"}
          </button>
        )}

        {plan.kind === "update" && (
          <button
            type="button"
            className="lattice-btn is-small is-primary"
            disabled={busy}
            onClick={() => store.onInstall(entry, plan.pkg, false)}
            title={
              added.length > 0
                ? `This update asks for ${added.map((item) => PERMISSION_LABELS[item]).join(", ")}`
                : undefined
            }
          >
            {busy ? "Updating…" : `Update to ${plan.pkg.version}`}
          </button>
        )}

        {plan.kind === "current" && (
          <span className="lattice-store-note">
            {installed ? "Up to date" : `Already installed (${plan.pkg.version})`}
          </span>
        )}

        {/*
          目录比本地旧。以前这一支混在 `Up to date` 里 —— 那句话在
          "我有 1.0.0、目录只到 0.9.0" 的时候是假的。这里不提供任何按钮：
          降级是个需要人明确说"我知道"的动作，不该长成一颗随手能点的按钮。
        */}
        {plan.kind === "older" && (
          <span className="lattice-store-note">
            The catalogue only has {plan.pkg.version} — you have {plan.installed}. Nothing to do.
          </span>
        )}

        {plan.kind === "blocked" && (
          <div className="lattice-store-trust">
            <span className="lattice-store-note is-warn">
              You blocked this publisher key ({keyFingerprint(plan.key)}). Nothing signed with it
              will be installed.
            </span>
            <button
              type="button"
              className="lattice-btn is-small"
              onClick={() => store.onUnblockKey(plan.key)}
            >
              Unblock this key
            </button>
          </div>
        )}

        {plan.kind === "unsigned" && (
          <span className="lattice-store-note is-warn">
            No publisher signature — this catalogue entry cannot be installed
          </span>
        )}

        {plan.kind === "untrusted" && (
          <div className="lattice-store-trust">
            <span className="lattice-store-note is-warn">
              Publisher key changed: was {keyFingerprint(plan.pinned)}, now {keyFingerprint(plan.offered)}.
            </span>
            <button
              type="button"
              className="lattice-btn is-small is-danger"
              disabled={busy}
              onClick={() => store.onInstall(entry, plan.pkg, true)}
            >
              Trust the new key and install
            </button>
            {/*
              换钥匙是"私钥泄露"最像的样子：旧钥匙还在本地被钉着，而它可能已经
              在别人手上。所以这个对话框里要有一条"旧的那把别再用了"的路 ——
              点完之后这把钥匙进拉黑名单，将来哪怕它又签了什么，也装不进来。
            */}
            {pinnedBlocked ? (
              <span className="lattice-store-note">The old key is blocked — it can no longer ship to you.</span>
            ) : (
              <button
                type="button"
                className="lattice-btn is-small"
                onClick={() => store.onBlockKey(plan.pinned)}
                title="Stop trusting the previous key entirely — use this if it may have leaked"
              >
                Block the old key instead
              </button>
            )}
          </div>
        )}
      </div>

      {plan.kind === "update" && added.length > 0 && (
        <p className="lattice-store-note is-warn">
          Adds {added.map((item) => PERMISSION_LABELS[item]).join(", ")} — you will be asked to allow it.
        </p>
      )}
    </div>
  );
}
