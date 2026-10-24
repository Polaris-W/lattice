/**
 * 拖拽对齐参考线（纯函数）
 *
 * 拖一张卡片时，它的左/中/右三条竖线、上/中/下三条横线，会和其它卡片的同名
 * 线互相吸引：偏差在阈值内就吸过去，并把那条线亮出来。网格吸附解决的是
 * "摆得整齐"，对齐参考线解决的是"和旁边那个对齐" —— 后者是用户真的在做的事。
 *
 * 三处刻意的选择：
 *
 * 1. **吸附和网格是两件事**，不是二选一。网格把坐标量化到 8px，参考线把坐标
 *    拉到别人的边上；两者同时开着时，先网格后对齐 —— 网格给出一个近似的落点，
 *    对齐再把它精确地拉到线上。关掉网格之后对齐照样工作（那时候它更重要）。
 *
 * 2. **画布边界也参与吸附**（`bounds`）。vela 那份只处理了左/上零线，结果
 *    "把卡片拖到画布正中"这个最常见的动作反而没有参考线。这里把画布的
 *    0 / 中 / 满三条线也放进候选集。
 *
 * 3. **返回所有同偏差的线**。三条线同时对齐时（左边缘对齐一个、中线对齐另一个），
 *    只亮一条会让人以为只对上了一半。同一个坐标只出现一次。
 */

export interface AlignRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 吸附阈值（px）：拖拽中的边/中线与目标线距离小于等于它时吸过去 */
export const ALIGN_THRESHOLD_PX = 8;

export interface AlignOptions {
  threshold?: number;
  /** 画布尺寸。给了就把 0 / 中 / 满 三条线也当候选；不给就只和 `others` 对齐 */
  bounds?: { w: number; h: number } | null;
}

export interface AlignResult {
  x: number;
  y: number;
  /** 要画的竖线（画布坐标），空数组 = 这个轴没对上 */
  xs: number[];
  /** 要画的横线 */
  ys: number[];
}

/** 一个矩形在某轴上的三条线：起、中、止 */
function linesOf(start: number, size: number): number[] {
  return [start, start + size / 2, start + size];
}

/**
 * 某一轴上"赢"的那条线：偏差最小的那对，返回偏差和线坐标。
 *
 * 平手（三条线同时对上、偏差一样）时取先遇到的 —— 两个同尺寸的组件左对齐，
 * 左/中/右三对线的偏差完全相同，这时候随便取哪条都指向同一个动作。
 */
function pick(
  mine: number[],
  theirs: number[],
  threshold: number,
): { delta: number; line: number } | null {
  let best: { delta: number; line: number } | null = null;
  for (const line of theirs) {
    for (const self of mine) {
      const delta = line - self;
      if (Math.abs(delta) > threshold) continue;
      if (!best || Math.abs(delta) < Math.abs(best.delta)) best = { delta, line };
    }
  }
  return best;
}

/**
 * 算吸附后的位置。
 *
 * 两个轴**各自独立**求最近的一条线：横向能对上不代表纵向也能对上，混着算会
 * 出现"横向差 7px 纵向差 1px，结果按 1px 那条把两个轴都拽过去"。
 *
 * **每个轴最多画一条线。** 三条线同时对上（两个同尺寸的组件左对齐，左/中/右
 * 全对上）是**最常见**的情况，按"对上几条画几条"就会画出三条横跨整块画布的
 * 竖线 —— 它们说的是同一件事，但看起来像界面卡了。只画赢的那条。
 */
export function computeAlign(
  nx: number,
  ny: number,
  w: number,
  h: number,
  others: ReadonlyArray<AlignRect>,
  options: AlignOptions = {},
): AlignResult {
  const threshold = options.threshold ?? ALIGN_THRESHOLD_PX;
  if (!(threshold > 0)) return { x: nx, y: ny, xs: [], ys: [] };

  const candidateXs: number[] = [];
  const candidateYs: number[] = [];
  for (const other of others) {
    candidateXs.push(...linesOf(other.x, other.w));
    candidateYs.push(...linesOf(other.y, other.h));
  }
  if (options.bounds) {
    const { w: bw, h: bh } = options.bounds;
    candidateXs.push(0, bw / 2, bw);
    candidateYs.push(0, bh / 2, bh);
  }

  const pickX = pick(linesOf(nx, w), candidateXs, threshold);
  const pickY = pick(linesOf(ny, h), candidateYs, threshold);

  return {
    x: pickX ? nx + pickX.delta : nx,
    y: pickY ? ny + pickY.delta : ny,
    xs: pickX ? [pickX.line] : [],
    ys: pickY ? [pickY.line] : [],
  };
}
