/**
 * 棂 / Lattice —— 组件库
 *
 * 列出注册表里的所有组件。点击或拖拽即可放到画布上。
 * 清单解析失败的目录也会显示出来，不然用户装了个坏组件会完全没反馈。
 */

import type { WidgetLoadError, WidgetRecord } from "../runtime/registry";
import { PERMISSION_LABELS } from "../runtime/manifest";

interface LibraryPanelProps {
  widgets: WidgetRecord[];
  errors: WidgetLoadError[];
  loading: boolean;
  onAdd: (record: WidgetRecord) => void;
}

export function LibraryPanel({ widgets, errors, loading, onAdd }: LibraryPanelProps) {
  return (
    <aside className="lattice-panel lattice-panel-left">
      <header className="lattice-panel-head">
        <h2 className="lattice-panel-title">组件库</h2>
        <span className="lattice-panel-count">{widgets.length}</span>
      </header>

      <div className="lattice-panel-body">
        {loading && <p className="lattice-hint">正在扫描组件…</p>}

        {!loading && widgets.length === 0 && (
          <p className="lattice-hint">还没有可用组件。把组件目录放到 widgets/ 下再刷新。</p>
        )}

        {widgets.map((record) => (
          <button
            key={record.manifest.id}
            type="button"
            className="lattice-card"
            draggable
            onDragStart={(event) => {
              event.dataTransfer.setData("application/x-lattice-widget", record.manifest.id);
              event.dataTransfer.effectAllowed = "copy";
            }}
            onClick={() => onAdd(record)}
          >
            <div className="lattice-card-top">
              <span className="lattice-card-name">{record.manifest.name}</span>
              <span className={`lattice-chip${record.entryUrl ? "" : " is-warn"}`}>
                {record.source === "bundled" ? "内置" : record.entryUrl ? "已安装" : "待接入"}
              </span>
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
          </button>
        ))}

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
