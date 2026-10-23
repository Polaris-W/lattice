/**
 * 棂 / Lattice —— 窗口夹回屏幕的几何
 *
 * 桌面组件的窗口没有窗饰，用户唯一能抓的地方是右上角那颗拖动按钮。所以
 * "别让按钮出界"就等于"别让组件拖出去回不来"。
 *
 * 抽成纯函数有两个原因：
 *   1. 它要能被测。混在 `widgetHost.ts` 里就没法测 —— 那页一加载就要 IPC、
 *      要窗口句柄，测试跑不起来
 *   2. 它必须**单位无关**。同一套算法要用在物理像素上（见下面的注释），
 *      也要能拿逻辑像素写测试。只要传进来的数和 `screens` 是同一套坐标就行
 *
 * # 为什么算物理像素
 *
 * Windows 在 PerMonitorV2 下，`GetWindowRect` 和 `GetMonitorInfo` 报的都是
 * 真实物理像素，跨显示器连续。而"逻辑像素"在不同缩放的屏上根本不是同一套
 * 空间：150% 那块屏上的 100 逻辑像素和 100% 那块屏上的 100 逻辑像素，
 * 落到物理上是两个距离。
 *
 * 早先的写法是拿**当前窗口**的 `scaleFactor` 去折算**所有**显示器 ——
 * 一旦两块屏缩放不同，折算出来的矩形就不是任何一块屏的真实位置，
 * 夹紧会算到"幻影位置"上。改成全程物理像素之后，缩放只在两个地方出现：
 * 指针位移（CSS px → 物理 px）和最小尺寸（逻辑 → 物理），各乘各的当次值。
 */

/** 一块屏幕的工作区矩形（不含任务栏） */
export interface ScreenBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** 窗口矩形，和 `ScreenBox` 同一套坐标 */
export interface WindowBox {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface FitOptions {
  /** 锚点在窗口内的横向偏移：从**右边**往里算 */
  anchorX: number;
  /** 锚点在窗口内的纵向偏移：从**顶边**往下算 */
  anchorY: number;
  /** 锚点至少要留在屏幕内这么多，否则点不准 */
  margin: number;
}

/**
 * 离锚点最近的那块屏幕。
 *
 * 按锚点选屏，不按窗口矩形：跨屏拖动时窗口大部分还在出发屏上，
 * 按矩形算会在接缝处把窗口拽回来，手感像卡住。
 */
export function pickScreen(anchorX: number, anchorY: number, screens: ScreenBox[]): ScreenBox | null {
  let best: ScreenBox | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;

  for (const screen of screens) {
    // 锚点到这块矩形的最短距离（在里面就是 0）
    const dx = Math.max(screen.x - anchorX, 0, anchorX - (screen.x + screen.w));
    const dy = Math.max(screen.y - anchorY, 0, anchorY - (screen.y + screen.h));
    const distance = dx * dx + dy * dy;
    if (distance < bestDistance) {
      bestDistance = distance;
      best = screen;
    }
  }

  return best;
}

/**
 * 把窗口平移回"锚点还点得到"的位置。
 *
 * 只保证锚点在某块屏幕里，不要求窗口完整可见 —— 半截悬在边上是很常见的用法。
 * 返回的是**平移后**的窗口原点：位移量取"锚点该去哪儿"和"锚点在哪儿"之差，
 * 所以窗口和锚点一起动，尺寸不变。
 */
export function fitAnchor(rect: WindowBox, screens: ScreenBox[], options: FitOptions): { x: number; y: number } {
  // 拿不到显示器信息就别夹了：宁可能拖出去，也不要整个拖不动
  if (screens.length === 0) return { x: rect.x, y: rect.y };

  const anchorX = rect.x + rect.w - options.anchorX;
  const anchorY = rect.y + options.anchorY;

  const best = pickScreen(anchorX, anchorY, screens);
  if (!best) return { x: rect.x, y: rect.y };

  // 屏幕比两倍 margin 还窄时 hi < lo，这时以 hi 为准 —— 和 Math.min/max 的
  // 顺序一致，别改成"取中间"，那会让锚点贴到屏幕另一头
  const targetX = Math.min(Math.max(anchorX, best.x + options.margin), best.x + best.w - options.margin);
  const targetY = Math.min(Math.max(anchorY, best.y + options.margin), best.y + best.h - options.margin);

  return { x: rect.x + (targetX - anchorX), y: rect.y + (targetY - anchorY) };
}
