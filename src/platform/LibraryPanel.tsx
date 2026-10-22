/**
 * 棂 / Lattice —— 组件库
 *
 * 平台开箱不带任何组件。这里分两段：
 *   - 已安装：能往画布上放的包
 *   - 可安装：发现到了但还没启用的包（官方包、用户目录里的包）
 *
 * 这个分界是产品定义的一部分，不是 UI 细节：没有安装这个动作，
 * 平台就退化成一个内置了几个组件的桌面工具，而不是扩展平台。
 */

import type { WidgetLoadError, WidgetRecord } from "../runtime/registry";
import { PERMISSION_LABELS } from "../runtime/manifest";
import { Glyph, ICON, PanelGlyph } from "./icons";

/** 安装结果提示。成功的会自己消失，失败的留着等用户处理 */
export interface InstallNotice {
  kind: "ok" | "error";
  text: string;
}

interface LibraryPanelProps {
  widgets: WidgetRecord[];
  /** 当前已启用的组件 id */
  installedIds: Set<string>;
  errors: WidgetLoadError[];
  loading: boolean;
  notice: InstallNotice | null;
  onDismissNotice: () => void;
  onOpenWidgetsDir: () => void;
  onAdd: (record: WidgetRecord) => void;
  onInstall: (record: WidgetRecord) => void;
  onInstallPack: (records: WidgetRecord[]) => void;
  onUninstall: (record: WidgetRecord) => void;
  /** 面板是否展开；收起后退成一条竖条，只留开合按钮 */
  open: boolean;
  onToggle: () => void;
}

export function LibraryPanel({
  widgets,
  installedIds,
  errors,
  loading,
  notice,
  onDismissNotice,
  onOpenWidgetsDir,
  onAdd,
  onInstall,
  onInstallPack,
  onUninstall,
  open,
  onToggle,
}: LibraryPanelProps) {
  const installed = widgets.filter((record) => installedIds.has(record.manifest.id));
  const available = widgets.filter((record) => !installedIds.has(record.manifest.id));
  const officialPack = available.filter((record) => record.source === "bundled");

  const activate = (record: WidgetRecord) => {
    if (!installedIds.has(record.manifest.id)) {
      onInstall(record);
      return;
    }
    onAdd(record);
  };

  const renderCard = (record: WidgetRecord) => {
    const isInstalled = installedIds.has(record.manifest.id);

    return (
      <div
        key={record.manifest.id}
        className={`lattice-card${isInstalled ? "" : " is-available"}`}
        role="button"
        tabIndex={0}
        draggable={isInstalled}
        onDragStart={(event) => {
          event.dataTransfer.setData("application/x-lattice-widget", record.manifest.id);
          event.dataTransfer.effectAllowed = "copy";
        }}
        onClick={() => activate(record)}
        onKeyDown={(event) => {
          if (event.key !== "Enter" && event.key !== " ") return;
          event.preventDefault();
          activate(record);
        }}
      >
        <div className="lattice-card-top">
          <span className="lattice-card-glyph" aria-hidden>
            {record.manifest.name.trim().slice(0, 1)}
          </span>
          <span className="lattice-card-heading">
            <span className="lattice-card-name">{record.manifest.name}</span>
            <code className="lattice-card-id">{record.manifest.id}</code>
          </span>
          {isInstalled ? (
            <span className="lattice-chip is-accent">Installed</span>
          ) : (
            <span className="lattice-chip">{record.source === "bundled" ? "Bundled" : "Local"}</span>
          )}
        </div>

        <p className="lattice-card-desc">
          {record.manifest.description || "No description yet"}
        </p>

        <div className="lattice-card-meta">
          <span className="lattice-mono">v{record.manifest.version}</span>
          <span className="lattice-mono">{record.manifest.author}</span>
        </div>

        {record.manifest.permissions.length > 0 && (
          <div className="lattice-perm-list">
            {record.manifest.permissions.map((permission) => (
              <span key={permission} className="lattice-perm">
                {PERMISSION_LABELS[permission]}
              </span>
            ))}
          </div>
        )}

        <div className="lattice-card-actions">
          {isInstalled ? (
            <button
              type="button"
              className="lattice-link-btn"
              onClick={(event) => {
                event.stopPropagation();
                onUninstall(record);
              }}
            >
              Uninstall
            </button>
          ) : (
            <button
              type="button"
              className="lattice-btn is-small"
              onClick={(event) => {
                event.stopPropagation();
                onInstall(record);
              }}
            >
              Install
            </button>
          )}
        </div>
      </div>
    );
  };

  if (!open) {
    return (
      <aside className="lattice-panel lattice-panel-left is-collapsed">
        <button
          type="button"
          className="lattice-icon-btn is-large"
          onClick={onToggle}
          title="Show the widget library"
          aria-label="Show the widget library"
          aria-expanded={false}
        >
          <PanelGlyph side="left" />
        </button>
        <span className="lattice-panel-rail-label">Widgets</span>
      </aside>
    );
  }

  return (
    <aside className="lattice-panel lattice-panel-left">
      <header className="lattice-panel-head">
        <h2 className="lattice-panel-title">Widgets</h2>
        <span className="lattice-panel-count">{installed.length}</span>
        <div className="lattice-panel-actions">
          <button
            type="button"
            className="lattice-icon-btn"
            onClick={onOpenWidgetsDir}
            title="Open the widgets folder in Explorer"
            aria-label="Open widgets folder"
          >
            <Glyph d={ICON.folder} />
          </button>
          <button
            type="button"
            className="lattice-icon-btn"
            onClick={onToggle}
            title="Collapse the widget library"
            aria-label="Collapse the widget library"
            aria-expanded
          >
            <PanelGlyph side="left" />
          </button>
        </div>
      </header>

      {notice && (
        <div className={`lattice-notice is-${notice.kind}`} role="status">
          <span className="lattice-notice-text">{notice.text}</span>
          <button
            type="button"
            className="lattice-notice-close"
            onClick={onDismissNotice}
            aria-label="Dismiss notice"
          >
            ×
          </button>
        </div>
      )}

      <div className="lattice-panel-body">
        {loading && <p className="lattice-hint">Scanning widgets…</p>}

        {!loading && widgets.length === 0 && (
          <div className="lattice-lib-note">
            <p className="lattice-lib-note-title">No widgets at all</p>
            <p className="lattice-hint">
              Drag a widget folder from Explorer into this window to install it.
            </p>
          </div>
        )}

        {!loading && widgets.length > 0 && installed.length === 0 && (
          <div className="lattice-lib-note">
            <p className="lattice-lib-note-title">The platform is empty</p>
            <p className="lattice-hint">
              Nothing below is installed yet. Install one and the desktop has something to show.
            </p>
            {officialPack.length > 0 && (
              <button
                type="button"
                className="lattice-btn is-small is-primary"
                onClick={() => onInstallPack(officialPack)}
              >
                Install the official pack ({officialPack.length})
              </button>
            )}
          </div>
        )}

        {installed.length > 0 && (
          <section className="lattice-lib-section">
            <h3 className="lattice-lib-section-title">
              Installed<span>{installed.length}</span>
            </h3>
            {installed.map(renderCard)}
          </section>
        )}

        {available.length > 0 && (
          <section className="lattice-lib-section">
            <h3 className="lattice-lib-section-title">
              Available<span>{available.length}</span>
            </h3>
            {available.map(renderCard)}
          </section>
        )}

        {errors.length > 0 && (
          <div className="lattice-errors">
            <h3 className="lattice-errors-title">Widgets that failed to load</h3>
            {errors.map((error) => (
              <div key={error.dir} className="lattice-error-row">
                <code className="lattice-mono">{error.dir}</code>
                <span>{error.message}</span>
              </div>
            ))}
          </div>
        )}

        <p className="lattice-lib-drop">
          Drop a widget folder anywhere in this window to install it.
        </p>
      </div>
    </aside>
  );
}
