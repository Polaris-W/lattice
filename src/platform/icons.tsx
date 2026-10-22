/**
 * 图标
 *
 * 统一 16px 视窗、1.4 描边、round 端点 —— 顶栏、设置菜单里的图标都从这里取，
 * 免得每处各画一套，粗细对不上。
 *
 * 需要实心块（比如"跟随系统"那半圆）时用 children 传，不要为了一个图标
 * 另开一套 fill 规则。
 */

import type { ReactNode } from "react";

export function Glyph({
  d,
  children,
  size = 16,
}: {
  /** 单条路径的图标用这个 */
  d?: string;
  /** 多段 / 需要实心的图标用这个 */
  children?: ReactNode;
  size?: number;
}) {
  return (
    <svg
      className="lattice-glyph"
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {d ? <path d={d} /> : children}
    </svg>
  );
}

/**
 * 三态外观各自的图标：浅色 = 太阳、跟随系统 = 半明半暗、深色 = 月亮。
 * 顶栏那颗按钮和设置菜单里的分段控件共用它，保证同一状态在哪儿都长一样。
 */
export function ThemeGlyph({
  mode,
  size = 16,
}: {
  mode: "light" | "dark" | "system";
  size?: number;
}) {
  if (mode === "light") return <Glyph d={ICON.sun} size={size} />;
  if (mode === "dark") return <Glyph d={ICON.moon} size={size} />;
  return (
    <Glyph size={size}>
      <circle cx="8" cy="8" r="5.6" />
      <path d="M8 2.4a5.6 5.6 0 0 1 0 11.2Z" fill="currentColor" stroke="none" />
    </Glyph>
  );
}

/**
 * 面板开合图标：一个圆角方框，内侧贴一条竖杠。
 *
 * 竖杠在左 = 左侧面板，在右 = 右侧面板。两侧用**镜像**而不是旋转：
 * 旋转 180° 会连圆角一起转过去，看起来像另一个图标。
 */
export function PanelGlyph({ side, size = 16 }: { side: "left" | "right"; size?: number }) {
  return (
    <Glyph size={size}>
      <rect x="2.2" y="3" width="11.6" height="10" rx="2.4" />
      <rect
        x={side === "left" ? 4.6 : 10}
        y="5.2"
        width="1.4"
        height="5.6"
        rx="0.7"
        fill="currentColor"
        stroke="none"
      />
    </Glyph>
  );
}

export const ICON = {
  /** 太阳：浅色 */
  sun: "M8 10.4a2.4 2.4 0 1 0 0-4.8 2.4 2.4 0 0 0 0 4.8ZM8 1.8v1.3M8 12.9v1.3M1.8 8h1.3M12.9 8h1.3M3.6 3.6l.9.9M11.5 11.5l.9.9M12.4 3.6l-.9.9M4.5 11.5l-.9.9",
  /** 月亮：深色 */
  moon: "M13.2 9.5A5.6 5.6 0 0 1 6.5 2.8a5.6 5.6 0 1 0 6.7 6.7Z",
  /** 半明半暗的圆：跟随系统 */
  contrast: "M8 14A6 6 0 1 0 8 2a6 6 0 0 0 0 12Z",
  /** 刷新：一圈带箭头的弧 */
  refresh: "M13 8a5 5 0 1 1-1.7-3.8M13.2 2.4v3.1h-3.1",
  /** 滑杆：设置项里的"外观"。别用半明半暗的圆——那会和"跟随系统"那格撞脸 */
  appearance: "M2.8 5.4h10.4M2.8 10.6h10.4M5.9 3.5v3.8M10.1 8.7v3.8",
  user: "M13.2 14v-1.2A2.8 2.8 0 0 0 10.4 10H5.6a2.8 2.8 0 0 0-2.8 2.8V14M8 7.2a2.4 2.4 0 1 0 0-4.8 2.4 2.4 0 0 0 0 4.8Z",
  grid: "M3 6h10M3 10h10M6 3v10M10 3v10",
  info: "M8 14A6 6 0 1 0 8 2a6 6 0 0 0 0 12Zm0-8.6v.1M8 7.4V11",
  logout: "M6.4 13.4H4a1.4 1.4 0 0 1-1.4-1.4V4A1.4 1.4 0 0 1 4 2.6h2.4M10.2 10.8 12.8 8l-2.6-2.8M12.6 8H6.4",
  chevron: "m6.4 4.6 3.4 3.4-3.4 3.4",
  back: "M9.6 4.6 6.2 8l3.4 3.4",
  /** 文件夹：打开组件目录 */
  folder: "M13.4 12.4H2.6a1 1 0 0 1-1-1V4.6a1 1 0 0 1 1-1h3.2l1.5 1.7h5.1a1 1 0 0 1 1 1v5.1a1 1 0 0 1-1 1Z",
};
