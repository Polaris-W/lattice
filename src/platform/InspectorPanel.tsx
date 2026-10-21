/**
 * 棂 / Lattice —— 属性检查器
 *
 * 选中一个组件实例后，这里管它的层级、穿透、尺寸和权限授予。
 * 权限是按 widgetId 记的（同一组件的多个实例共享授权），
 * 因为权限是"你信不信任这个组件的代码"，跟摆了几份无关。
 */

import { PERMISSION_LABELS, type Permission } from "../runtime/manifest";
import type { WidgetRecord } from "../runtime/registry";
import { useLattice } from "./store";

interface InspectorPanelProps {
  records: Map<string, WidgetRecord>;
}

export function InspectorPanel({ records }: InspectorPanelProps) {
  const selectedId = useLattice((state) => state.selectedInstanceId);
  const placements = useLattice((state) => state.placements);
  const grants = useLattice((state) => state.grants);
  const update = useLattice((state) => state.updatePlacement);
  const remove = useLattice((state) => state.removePlacement);
  const grant = useLattice((state) => state.grant);
  const revoke = useLattice((state) => state.revoke);

  const placement = placements.find((item) => item.instanceId === selectedId);
  const record = placement ? records.get(placement.widgetId) : undefined;

  if (!placement || !record) {
    return (
      <aside className="lattice-panel lattice-panel-right">
        <header className="lattice-panel-head">
          <h2 className="lattice-panel-title">属性</h2>
        </header>
        <div className="lattice-panel-body">
          <p className="lattice-hint">在画布上选中一个组件，这里会显示它的设置。</p>
        </div>
      </aside>
    );
  }

  const manifest = record.manifest;
  const granted = grants[manifest.id] ?? [];

  return (
    <aside className="lattice-panel lattice-panel-right">
      <header className="lattice-panel-head">
        <h2 className="lattice-panel-title">{manifest.name}</h2>
        <button
          type="button"
          className="lattice-btn is-danger"
          onClick={() => remove(placement.instanceId)}
        >
          移除
        </button>
      </header>

      <div className="lattice-panel-body">
        <p className="lattice-card-desc">{manifest.description || "无描述"}</p>

        <section className="lattice-field">
          <span className="lattice-label">桌面层级</span>
          <div className="lattice-segmented">
            {(["desktop", "top"] as const).map((layer) => (
              <button
                key={layer}
                type="button"
                className={`lattice-segment${placement.layer === layer ? " is-active" : ""}`}
                onClick={() => update(placement.instanceId, { layer })}
              >
                {layer === "desktop" ? "贴桌面" : "置顶"}
              </button>
            ))}
          </div>
          <p className="lattice-hint">
            {placement.layer === "desktop"
              ? "沉到桌面图标之上、普通窗口之下，切窗口不会挡住内容。"
              : "浮在所有窗口之上，适合监控类组件。"}
          </p>
        </section>

        <section className="lattice-field">
          <label className="lattice-switch">
            <input
              type="checkbox"
              checked={placement.clickThrough}
              onChange={(event) =>
                update(placement.instanceId, { clickThrough: event.target.checked })
              }
            />
            <span>鼠标穿透</span>
          </label>
          <p className="lattice-hint">开启后鼠标事件穿过组件，适合纯展示的装饰类组件。</p>
        </section>

        <section className="lattice-field">
          <span className="lattice-label">尺寸</span>
          <div className="lattice-size-row">
            <span className="lattice-mono">
              {placement.w} × {placement.h}
            </span>
            <span className="lattice-hint">
              最小 {manifest.size.minW} × {manifest.size.minH}
            </span>
          </div>
        </section>

        <section className="lattice-field">
          <span className="lattice-label">权限</span>
          {manifest.permissions.length === 0 ? (
            <p className="lattice-hint">这个组件不需要任何平台权限。</p>
          ) : (
            manifest.permissions.map((permission: Permission) => {
              const enabled = granted.includes(permission);
              return (
                <label key={permission} className="lattice-switch is-row">
                  <input
                    type="checkbox"
                    checked={enabled}
                    onChange={(event) =>
                      event.target.checked
                        ? grant(manifest.id, permission)
                        : revoke(manifest.id, permission)
                    }
                  />
                  <span className="lattice-perm-name">{PERMISSION_LABELS[permission]}</span>
                  <code className="lattice-mono lattice-perm-code">{permission}</code>
                </label>
              );
            })
          )}
          <p className="lattice-hint">未授予的权限调用会被桥直接拒绝，组件需要自己降级处理。</p>
        </section>

        <section className="lattice-field">
          <span className="lattice-label">来源</span>
          <code className="lattice-mono lattice-path">{record.dir}</code>
        </section>
      </div>
    </aside>
  );
}
