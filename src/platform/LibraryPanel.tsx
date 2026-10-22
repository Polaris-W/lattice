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

interface LibraryPanelProps {
  widgets: WidgetRecord[];
  /** 当前已启用的组件 id */
  installedIds: Set<string>;
  errors: WidgetLoadError[];
  loading: boolean;
  onAdd: (record: WidgetRecord) => void;
  onInstall: (record: WidgetRecord) => void;
  onInstallPack: (records: WidgetRecord[]) => void;
  onUninstall: (record: WidgetRecord) => void;
}

export function LibraryPanel({
  widgets,
  installedIds,
  errors,
  loading,
  onAdd,
  onInstall,
  onInstallPack,
  onUninstall,
}: LibraryPanelProps) {
  const installed = widgets.filter((record) => installedIds.has(record.manifest.id));
  const available = widgets.filter((record) => !installedIds.has(record.manifest.id));
  const officialPack = available.filter((record) => record.source === "bundled");

  const activate = (record: WidgetRecord) => {
    if (!installedIds.has(record.manifest.id)) {
      onInstall(record);
      return;
    }
    if (record.entryUrl) onAdd(record);
  };

  const renderCard = (record: WidgetRecord) => {
    const isInstalled = installedIds.has(record.manifest.id);
    const canRender = record.entryUrl !== null;

    return (
      <div
        key={record.manifest.id}
        className={`lattice-card${isInstalled ? "" : " is-available"}`}
        role="button"
        tabIndex={0}
        draggable={isInstalled && canRender}
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
          <span className="lattice-card-name">{record.manifest.name}</span>
          {isInstalled ? (
            <span className="lattice-chip is-accent">已安装</span>
          ) : (
            <span className="lattice-chip">{record.source === "bundled" ? "官方" : "本地"}</span>
          )}
        </div>

        <p className="lattice-card-desc">
          {record.manifest.description || "这个组件还没有写描述"}
        </p>

        <div className="lattice-card-meta">
          <code className="lattice-mono">{record.manifest.id}</code>
          <span className="lattice-mono">v{record.manifest.version}</span>
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
            <>
              {!canRender && <span className="lattice-chip is-warn">待接入</span>}
              <button
                type="button"
                className="lattice-link-btn"
                onClick={(event) => {
                  event.stopPropagation();
                  onUninstall(record);
                }}
              >
                卸载
              </button>
            </>
          ) : (
            <button
              type="button"
              className="lattice-btn is-small"
              onClick={(event) => {
                event.stopPropagation();
                onInstall(record);
              }}
            >
              安装
            </button>
          )}
        </div>
      </div>
    );
  };

  return (
    <aside className="lattice-panel lattice-panel-left">
      <header className="lattice-panel-head">
        <h2 className="lattice-panel-title">组件库</h2>
        <span className="lattice-panel-count">{installed.length}</span>
      </header>

      <div className="lattice-panel-body">
        {loading && <p className="lattice-hint">正在扫描组件…</p>}

        {!loading && widgets.length === 0 && (
          <div className="lattice-lib-note">
            <p className="lattice-lib-note-title">一个组件都没有</p>
            <p className="lattice-hint">
              把组件包目录放进 widgets/，或者从磁盘安装一个，然后刷新。
            </p>
          </div>
        )}

        {!loading && widgets.length > 0 && installed.length === 0 && (
          <div className="lattice-lib-note">
            <p className="lattice-lib-note-title">平台是空的</p>
            <p className="lattice-hint">
              下面这些包还没安装。装一个，桌面上才会有东西。
            </p>
            {officialPack.length > 0 && (
              <button
                type="button"
                className="lattice-btn is-small is-primary"
                onClick={() => onInstallPack(officialPack)}
              >
                安装官方组件包（{officialPack.length} 个）
              </button>
            )}
          </div>
        )}

        {installed.length > 0 && (
          <section className="lattice-lib-section">
            <h3 className="lattice-lib-section-title">
              已安装<span>{installed.length}</span>
            </h3>
            {installed.map(renderCard)}
          </section>
        )}

        {available.length > 0 && (
          <section className="lattice-lib-section">
            <h3 className="lattice-lib-section-title">
              可安装<span>{available.length}</span>
            </h3>
            {available.map(renderCard)}
          </section>
        )}

        {errors.length > 0 && (
          <div className="lattice-errors">
            <h3 className="lattice-errors-title">加载失败的组件</h3>
            {errors.map((error) => (
              <div key={error.dir} className="lattice-error-row">
                <code className="lattice-mono">{error.dir}</code>
                <span>{error.message}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </aside>
  );
}
