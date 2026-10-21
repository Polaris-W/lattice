/**
 * 棂 / Lattice —— 平台外壳
 *
 * 布局：顶栏（产品 / 主题 / 网格 / 刷新） + 三栏（组件库 · 画布 · 属性）。
 * 这里只做编排，业务都在 platform/ 与 runtime/ 里。
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { Canvas } from "./platform/Canvas";
import { InspectorPanel } from "./platform/InspectorPanel";
import { LibraryPanel } from "./platform/LibraryPanel";
import { nextFreeSlot, useLattice, type ThemeMode } from "./platform/store";
import { loadRegistry, type WidgetLoadError, type WidgetRecord } from "./runtime/registry";

export default function App() {
  const [widgets, setWidgets] = useState<WidgetRecord[]>([]);
  const [errors, setErrors] = useState<WidgetLoadError[]>([]);
  const [loading, setLoading] = useState(true);

  const placements = useLattice((state) => state.placements);
  const addPlacement = useLattice((state) => state.addPlacement);
  const theme = useLattice((state) => state.theme);
  const setTheme = useLattice((state) => state.setTheme);
  const snapToGrid = useLattice((state) => state.snapToGrid);
  const toggleSnap = useLattice((state) => state.toggleSnap);

  const records = useMemo(() => new Map(widgets.map((item) => [item.manifest.id, item])), [widgets]);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const snapshot = await loadRegistry();
      setWidgets(snapshot.widgets);
      setErrors(snapshot.errors);
    } catch (error) {
      setErrors([{ dir: "(registry)", message: String(error) }]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // 主题落到 <html data-theme>，CSS 变量与组件都从这里取色
  useEffect(() => {
    const root = document.documentElement;
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      const resolved: "light" | "dark" =
        theme === "system" ? (media.matches ? "dark" : "light") : theme;
      root.dataset.theme = resolved;
    };
    apply();
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [theme]);

  const addWidget = useCallback(
    (record: WidgetRecord) => {
      const { w, h } = record.manifest.size;
      const slot = nextFreeSlot(useLattice.getState().placements, w, h);
      addPlacement({
        instanceId: `${record.manifest.id}#${crypto.randomUUID().slice(0, 8)}`,
        widgetId: record.manifest.id,
        x: slot.x,
        y: slot.y,
        w,
        h,
        layer: record.manifest.layer,
        clickThrough: false,
      });
    },
    [addPlacement],
  );

  const onDropWidget = useCallback(
    (event: React.DragEvent) => {
      const widgetId = event.dataTransfer.getData("application/x-lattice-widget");
      const record = records.get(widgetId);
      if (!record) return;
      event.preventDefault();

      const bounds = event.currentTarget.getBoundingClientRect();
      const { w, h } = record.manifest.size;
      const x = Math.max(0, Math.round(event.clientX - bounds.left - w / 2));
      const y = Math.max(0, Math.round(event.clientY - bounds.top - 12));

      addPlacement({
        instanceId: `${record.manifest.id}#${crypto.randomUUID().slice(0, 8)}`,
        widgetId: record.manifest.id,
        x,
        y,
        w,
        h,
        layer: record.manifest.layer,
        clickThrough: false,
      });
    },
    [addPlacement, records],
  );

  return (
    <div className="lattice-shell">
      <header className="lattice-topbar">
        <div className="lattice-brand">
          <span className="lattice-brand-mark" aria-hidden />
          <span className="lattice-brand-name">棂</span>
          <span className="lattice-brand-sub">Lattice</span>
        </div>

        <div className="lattice-topbar-actions">
          <span className="lattice-hint lattice-inline-hint">
            {placements.length} 个组件 · {widgets.length} 个可用
          </span>

          <button
            type="button"
            className={`lattice-btn${snapToGrid ? " is-active" : ""}`}
            onClick={toggleSnap}
            title="拖动时对齐到 8px 网格"
          >
            网格吸附
          </button>

          <div className="lattice-segmented">
            {(["light", "system", "dark"] as ThemeMode[]).map((mode) => (
              <button
                key={mode}
                type="button"
                className={`lattice-segment${theme === mode ? " is-active" : ""}`}
                onClick={() => setTheme(mode)}
              >
                {mode === "light" ? "浅色" : mode === "dark" ? "深色" : "跟随系统"}
              </button>
            ))}
          </div>

          <button type="button" className="lattice-btn" onClick={() => void refresh()}>
            刷新组件
          </button>
        </div>
      </header>

      <main className="lattice-main">
        <LibraryPanel widgets={widgets} errors={errors} loading={loading} onAdd={addWidget} />
        <Canvas records={records} onDropWidget={onDropWidget} />
        <InspectorPanel records={records} />
      </main>
    </div>
  );
}
