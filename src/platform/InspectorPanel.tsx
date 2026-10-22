/**
 * 棂 / Lattice —— 属性检查器
 *
 * 选中一个组件实例后，这里管它的层级、穿透、尺寸和权限授予。
 * 权限是按 widgetId 记的（同一组件的多个实例共享授权），
 * 因为权限是"你信不信任这个组件的代码"，跟摆了几份无关。
 */

import { useEffect, useRef, useState } from "react";
import { PERMISSION_LABELS, type Permission } from "../runtime/manifest";
import type { WidgetRecord } from "../runtime/registry";
import { useLattice } from "./store";

interface InspectorPanelProps {
  records: Map<string, WidgetRecord>;
}

/** 输入框的尺寸上限。再大就不是"小组件"了，也没必要让它盖满屏 */
const MAX_SIZE = 2400;

/** 把输入框里的字符串夹成合法尺寸；非法值退回当前值，不要静默改成最小值 */
function clampSize(raw: string, min: number, fallback: number): number {
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.max(min, Math.min(MAX_SIZE, Math.round(value)));
}

export function InspectorPanel({ records }: InspectorPanelProps) {
  const selectedId = useLattice((state) => state.selectedInstanceId);
  const placements = useLattice((state) => state.placements);
  const grants = useLattice((state) => state.grants);
  const desktopRects = useLattice((state) => state.desktopRects);
  const setDesktopRect = useLattice((state) => state.setDesktopRect);
  const update = useLattice((state) => state.updatePlacement);
  const remove = useLattice((state) => state.removePlacement);
  const grant = useLattice((state) => state.grant);
  const revoke = useLattice((state) => state.revoke);

  const placement = placements.find((item) => item.instanceId === selectedId);
  const record = placement ? records.get(placement.widgetId) : undefined;

  /*
   * 尺寸输入是"草稿 + 提交"的：边打字边写 store 的话，输入 "2" 的那一瞬间
   * 组件就会被缩成 2px，画布跟着跳。所以只在失焦 / 回车时提交。
   */
  const [draft, setDraft] = useState({ w: "", h: "" });
  const editingRef = useRef(false);

  useEffect(() => {
    if (editingRef.current || !placement) return;
    setDraft({ w: String(placement.w), h: String(placement.h) });
  }, [placement?.instanceId, placement?.w, placement?.h]);

  /**
   * 改尺寸要同时写两处：画布上的 placement，和桌面窗口记下的矩形。
   *
   * 只写 placement 的话，已经投放到桌面的组件不会变 —— buildSpecs 优先用
   * desktopRects 里的尺寸（那是用户拖边缘改过的真实值）。反过来只写
   * desktopRects，画布上的框又不动。两边一起写，才是一份尺寸。
   */
  const applySize = (w: number, h: number) => {
    if (!placement) return;
    update(placement.instanceId, { w, h });
    const rect = desktopRects[placement.instanceId];
    if (rect) setDesktopRect(placement.instanceId, { ...rect, w, h });
    setDraft({ w: String(w), h: String(h) });
  };

  const commitSize = () => {
    editingRef.current = false;
    if (!placement || !record) return;
    const { minW, minH } = record.manifest.size;
    applySize(clampSize(draft.w, minW, placement.w), clampSize(draft.h, minH, placement.h));
  };

  if (!placement || !record) {
    return (
      <aside className="lattice-panel lattice-panel-right">
        <header className="lattice-panel-head">
          <h2 className="lattice-panel-title">Inspector</h2>
        </header>
        <div className="lattice-panel-body is-empty">
          <div className="lattice-panel-empty">
            <span className="lattice-panel-empty-art" aria-hidden />
            <p className="lattice-hint">Select a widget on the canvas to see its layer, size and permissions.</p>
          </div>
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
          Remove
        </button>
      </header>

      <div className="lattice-panel-body">
        <p className="lattice-card-desc">{manifest.description || "No description"}</p>

        <section className="lattice-field">
          <span className="lattice-label">Layer</span>
          <div className="lattice-segmented">
            {(["desktop", "top"] as const).map((layer) => (
              <button
                key={layer}
                type="button"
                className={`lattice-segment${placement.layer === layer ? " is-active" : ""}`}
                onClick={() => update(placement.instanceId, { layer })}
              >
                {layer === "desktop" ? "Desktop" : "On top"}
              </button>
            ))}
          </div>
          <p className="lattice-hint">
            {placement.layer === "desktop"
              ? "Sits above desktop icons and below normal windows, so switching apps never covers it."
              : "Floats above every window — good for monitors and readouts."}
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
            <span>Click-through</span>
          </label>
          <p className="lattice-hint">Mouse events pass straight through — useful for purely decorative widgets.</p>
        </section>

        <section className="lattice-field">
          <div className="lattice-field-head">
            <span className="lattice-label">Size</span>
            <button
              type="button"
              className="lattice-link-btn"
              onClick={() => applySize(manifest.size.w, manifest.size.h)}
            >
              Reset to {manifest.size.w} × {manifest.size.h}
            </button>
          </div>
          <div className="lattice-size-grid">
            <label className="lattice-size-input">
              <span>W</span>
              <input
                type="number"
                inputMode="numeric"
                min={manifest.size.minW}
                max={MAX_SIZE}
                value={draft.w}
                onChange={(event) => {
                  editingRef.current = true;
                  setDraft((prev) => ({ ...prev, w: event.target.value }));
                }}
                onBlur={commitSize}
                onKeyDown={(event) => {
                  if (event.key === "Enter") event.currentTarget.blur();
                  if (event.key === "Escape") {
                    editingRef.current = false;
                    setDraft({ w: String(placement.w), h: String(placement.h) });
                    event.currentTarget.blur();
                  }
                }}
                aria-label="Widget width"
              />
            </label>
            <label className="lattice-size-input">
              <span>H</span>
              <input
                type="number"
                inputMode="numeric"
                min={manifest.size.minH}
                max={MAX_SIZE}
                value={draft.h}
                onChange={(event) => {
                  editingRef.current = true;
                  setDraft((prev) => ({ ...prev, h: event.target.value }));
                }}
                onBlur={commitSize}
                onKeyDown={(event) => {
                  if (event.key === "Enter") event.currentTarget.blur();
                  if (event.key === "Escape") {
                    editingRef.current = false;
                    setDraft({ w: String(placement.w), h: String(placement.h) });
                    event.currentTarget.blur();
                  }
                }}
                aria-label="Widget height"
              />
            </label>
          </div>
          <p className="lattice-hint">
            Minimum {manifest.size.minW} × {manifest.size.minH}. Drag the edges on the canvas, or type an exact value here.
          </p>
        </section>

        <section className="lattice-field">
          <span className="lattice-label">Permissions</span>
          {manifest.permissions.length === 0 ? (
            <p className="lattice-hint">This widget needs no platform permissions.</p>
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
          <p className="lattice-hint">Calls without a granted permission are rejected by the bridge; widgets must degrade gracefully.</p>
        </section>

        <section className="lattice-field">
          <span className="lattice-label">Source</span>
          <code className="lattice-mono lattice-path">{record.dir}</code>
        </section>
      </div>
    </aside>
  );
}
