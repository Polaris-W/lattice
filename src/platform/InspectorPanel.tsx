/**
 * 棂 / Lattice —— 属性检查器
 *
 * 选中一个组件实例后，这里管它的层级、穿透、尺寸和权限授予。
 * 权限是按 widgetId 记的（同一组件的多个实例共享授权），
 * 因为权限是"你信不信任这个组件的代码"，跟摆了几份无关。
 */

import { invoke } from "@tauri-apps/api/core";
import { useEffect, useRef, useState } from "react";
import {
  MAX_BLUR,
  hexFromRgb,
  isPlainAppearance,
  normalizeAppearance,
  themeSurfaceRgb,
  tintRgb,
  type Appearance,
} from "../runtime/appearance";
import { PERMISSION_LABELS, type Permission } from "../runtime/manifest";
import { isTauri, type WidgetRecord } from "../runtime/registry";
import { PanelGlyph, WidgetIconMark } from "./icons";
import { useLattice } from "./store";

interface InspectorPanelProps {
  records: Map<string, WidgetRecord>;
  /** 面板是否展开；收起后退成一条竖条，只留开合按钮 */
  open: boolean;
  onToggle: () => void;
}

/** 输入框的尺寸上限。再大就不是"小组件"了，也没必要让它盖满屏 */
const MAX_SIZE = 2400;

/** 把输入框里的字符串夹成合法尺寸；非法值退回当前值，不要静默改成最小值 */
function clampSize(raw: string, min: number, fallback: number): number {
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) return fallback;
  return Math.max(min, Math.min(MAX_SIZE, Math.round(value)));
}

interface SliderRowProps {
  /** 左侧那一列，越短越好，面板只有两百多像素宽 */
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  /** 数值框显示几位小数，0 表示取整 */
  decimals?: number;
  onChange: (value: number) => void;
  ariaLabel: string;
}

/**
 * 一条滑杆 + 一个数字框。
 *
 * 数字框跟尺寸框一样是"草稿 + 提交"：拖滑杆求手感，输数字求准确，
 * 但边打字边提交的话，输入 "0." 的那一瞬间值就被夹成 0 了。
 */
function SliderRow({
  label,
  value,
  min,
  max,
  step,
  decimals = 0,
  onChange,
  ariaLabel,
}: SliderRowProps) {
  const [draft, setDraft] = useState<string | null>(null);
  const shown = decimals > 0 ? value.toFixed(decimals) : String(Math.round(value));

  const commit = () => {
    if (draft === null) return;
    const parsed = Number(draft);
    setDraft(null);
    if (!Number.isFinite(parsed)) return;
    onChange(Math.min(max, Math.max(min, parsed)));
  };

  return (
    <div className="lattice-slider-row">
      <span className="lattice-slider-key">{label}</span>
      <input
        type="range"
        className="lattice-slider"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
        aria-label={ariaLabel}
      />
      <input
        type="number"
        className="lattice-slider-num"
        inputMode="decimal"
        min={min}
        max={max}
        step={step}
        value={draft ?? shown}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur();
          if (event.key === "Escape") {
            setDraft(null);
            event.currentTarget.blur();
          }
        }}
        aria-label={`${ariaLabel} value`}
      />
    </div>
  );
}

export function InspectorPanel({ records, open, onToggle }: InspectorPanelProps) {
  const selectedId = useLattice((state) => state.selectedInstanceId);
  const placements = useLattice((state) => state.placements);
  const grants = useLattice((state) => state.grants);
  const desktopRects = useLattice((state) => state.desktopRects);
  const setDesktopRect = useLattice((state) => state.setDesktopRect);
  const update = useLattice((state) => state.updatePlacement);
  const remove = useLattice((state) => state.removePlacement);
  const grant = useLattice((state) => state.grant);
  const revoke = useLattice((state) => state.revoke);
  const theme = useLattice((state) => state.theme);

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

  /*
   * "跟随主题"时滑杆也要有个数字，所以要读一次主题底色。等一帧再读，
   * 见 themeSurfaceRgb 的注释。
   */
  const [surfaceRgb, setSurfaceRgb] = useState<[number, number, number]>([255, 255, 255]);
  useEffect(() => {
    const raf = requestAnimationFrame(() => setSurfaceRgb(themeSurfaceRgb()));
    return () => cancelAnimationFrame(raf);
  }, [theme]);

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

  if (!open) {
    return (
      <aside className="lattice-panel lattice-panel-right is-collapsed">
        <button
          type="button"
          className="lattice-icon-btn is-large"
          onClick={onToggle}
          title="Show the inspector"
          aria-label="Show the inspector"
          aria-expanded={false}
        >
          <PanelGlyph side="right" />
        </button>
        <span className="lattice-panel-rail-label">Inspector</span>
      </aside>
    );
  }

  if (!placement || !record) {
    return (
      <aside className="lattice-panel lattice-panel-right">
        <header className="lattice-panel-head">
          <h2 className="lattice-panel-title">Inspector</h2>
          <div className="lattice-panel-actions">
            <button
              type="button"
              className="lattice-icon-btn"
              onClick={onToggle}
              title="Collapse the inspector"
              aria-label="Collapse the inspector"
              aria-expanded
            >
              <PanelGlyph side="right" />
            </button>
          </div>
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

  // 实例覆盖优先，没有就退回清单的出厂值 —— 跟 buildSpecs 用的是同一套规则
  const appearance = normalizeAppearance(placement.appearance ?? manifest.appearance);
  const tintHex = appearance.tint === "auto" ? hexFromRgb(...surfaceRgb) : appearance.tint;
  const tint = tintRgb(tintHex) ?? surfaceRgb;
  const isAuto = appearance.tint === "auto";

  /** 只改底板，别动 placement 上的其它字段 */
  const patchAppearance = (patch: Partial<Appearance>) => {
    const next = { ...appearance, ...patch };
    update(placement.instanceId, { appearance: next });
    /*
     * 滑杆要跟手，所以这里直接推一份给桌面窗口。
     *
     * 光靠 store 不够：App 那条同步是 120ms 防抖的，而且每次改动都会把计时器
     * 重新起算 —— 一路拖下去，桌面窗口要等到松手才动，滑杆看起来就是死的。
     *
     * 推失败不要紧（组件还在画布上、没有桌面窗口），下次同步照样会带上它。
     */
    if (isTauri()) {
      void invoke("widget_set_appearance", {
        instanceId: placement.instanceId,
        appearance: next,
      }).catch(() => {});
    }
  };

  /** 拖动任一 R/G/B 滑杆 = 从"跟随主题"变成"就用这个颜色"，起点是当前看起来的颜色 */
  const setChannel = (index: 0 | 1 | 2, raw: number) => {
    const next: [number, number, number] = [...tint];
    next[index] = Math.round(Math.min(255, Math.max(0, raw)));
    patchAppearance({ tint: hexFromRgb(...next) });
  };

  return (
    <aside className="lattice-panel lattice-panel-right">
      <header className="lattice-panel-head">
        <h2 className="lattice-panel-title">
          {record.iconUrl && <WidgetIconMark url={record.iconUrl} size={13} />}
          <span className="lattice-panel-title-text">{manifest.name}</span>
        </h2>
        <div className="lattice-panel-actions">
          <button
            type="button"
            className="lattice-btn is-danger"
            onClick={() => remove(placement.instanceId)}
          >
            Remove
          </button>
          <button
            type="button"
            className="lattice-icon-btn"
            onClick={onToggle}
            title="Collapse the inspector"
            aria-label="Collapse the inspector"
            aria-expanded
          >
            <PanelGlyph side="right" />
          </button>
        </div>
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
            <span className="lattice-label">Backplate</span>
            <button
              type="button"
              className="lattice-link-btn"
              onClick={() => update(placement.instanceId, { appearance: undefined })}
              disabled={isPlainAppearance(appearance)}
            >
              Reset to theme
            </button>
          </div>

          <div className="lattice-tint-row">
            <label
              className="lattice-swatch"
              style={{ background: tintHex }}
              title="Pick a colour"
            >
              <input
                type="color"
                value={tintHex}
                onChange={(event) => patchAppearance({ tint: event.target.value })}
                aria-label="Backplate colour"
              />
            </label>
            <code className="lattice-mono lattice-tint-code">{isAuto ? "auto" : tintHex}</code>
            <button
              type="button"
              className="lattice-chip"
              onClick={() => patchAppearance({ tint: "auto" })}
              aria-pressed={isAuto}
              title="Follow the light / dark theme"
            >
              Auto
            </button>
          </div>

          {(["R", "G", "B"] as const).map((channel, index) => (
            <SliderRow
              key={channel}
              label={channel}
              value={tint[index]}
              min={0}
              max={255}
              step={1}
              onChange={(value) => setChannel(index as 0 | 1 | 2, value)}
              ariaLabel={`Backplate ${channel === "R" ? "red" : channel === "G" ? "green" : "blue"}`}
            />
          ))}

          <SliderRow
            label="Fill"
            value={appearance.alpha}
            min={0}
            max={1}
            step={0.01}
            decimals={2}
            onChange={(value) => patchAppearance({ alpha: value })}
            ariaLabel="Backplate fill"
          />
          <SliderRow
            label="Blur"
            value={appearance.blur}
            min={0}
            max={MAX_BLUR}
            step={0.5}
            decimals={1}
            onChange={(value) => patchAppearance({ blur: value })}
            ariaLabel="Backplate blur"
          />

          <p className="lattice-hint">
            {appearance.alpha === 1 && appearance.blur > 0
              ? "Fill is at 100%, so nothing shows through — lower Fill to see the frosted wallpaper."
              : appearance.blur === 0 && appearance.alpha < 1
                ? "The wallpaper shows through but is still sharp — raise Blur to frost it."
                : "Fill is how much of the colour covers the backplate, not window transparency. At 0 you get only the frosted wallpaper."}
          </p>
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
