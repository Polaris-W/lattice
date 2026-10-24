/**
 * ✕ 到底该不该认这一下
 *
 * # 背景
 *
 * "组件自己从画布上消失"这件事查了很久还没结案：日志里是 `reason: user`、
 * `isTrusted: true`、`detail: 1`、`pointer: mouse`，落点正好是那颗 22×22
 * 的 ✕ 中心 —— 是一段**真的指针序列**，但当时没人在碰鼠标。
 *
 * 查不出派发方，那就把门收窄：把"这一下够不够格算一次点击"从宿主页里
 * 抽成纯函数，一条条写清楚什么情况不认。抽出来的另一个好处是它能被测 ——
 * 宿主页本身没有自检页，以前这段判断只能靠人肉点。
 *
 * # 认一条关窗的依据
 *
 * 一次真正的点击有它自己的形状：**按在 ✕ 上、松在 ✕ 上、中途没怎么动、
 * 而且松手那一刻指针确实还在 ✕ 上**。少一条都不认。最后那条
 * （`hitAtRelease`）是专门冲着"迟到的输入"去的：窗口挪走之后才被处理的
 * 点击，坐标还停在老位置，`elementFromPoint` 一问就知道它已经不在按钮上了。
 *
 * # 它不能证明什么
 *
 * 这套判断**没有解决**那个幽灵点击 —— 如果它真的是一段完整的按下 / 松开，
 * 这里照样会认（只是日志里会多一个 `ok`，能和别的分支区分开）。它做的是：
 * 把"没有按下就关窗"这条彻底堵死，并给下一次复现留下判据。
 */

/** 窗饰淡到这个程度以上才认：按钮还半透明的时候，用户几乎没看见它 */
export const MIN_OPACITY = 0.9;

/** 按下到松开之间允许的位移。超过就是拖拽，不是点击 */
export const MAX_TRAVEL_PX = 8;

export interface CloseAttempt {
  /** 窗饰当前不透明度（0..1） */
  opacity: number;
  /** 键盘激活（Enter / 空格）：`click` 的 `detail` 是 0，没有指针序列 */
  keyboard: boolean;
  /** 按下时指针在 ✕ 上 */
  downOnButton: boolean;
  /** 松开时指针在 ✕ 上 */
  upOnButton: boolean;
  /** 松手那一刻，按坐标做命中测试，最上面那个元素还是 ✕ */
  hitAtRelease: boolean;
  /** 按下和松开是同一根指针 */
  samePointer: boolean;
  /** 按下到松开的位移（像素） */
  travel: number;
}

export interface CloseDecision {
  accept: boolean;
  /** 机器可读的原因，跟着 IPC 一起走，日志里能直接筛 */
  reason:
    | "ok"
    | "keyboard"
    | "fading"
    | "no-press"
    | "released-elsewhere"
    | "stale-position"
    | "pointer-mismatch"
    | "dragged";
  /** 给人看的一句话（英文，和其它日志一致） */
  detail: string;
}

function reject(reason: CloseDecision["reason"], detail: string): CloseDecision {
  return { accept: false, reason, detail };
}

export function decideClose(attempt: CloseAttempt): CloseDecision {
  /*
   * 键盘先放行：Enter / 空格触发的是没有指针序列的 click，
   * 拿指针那几条去卡它等于把键盘用户挡在门外。而键盘用户不可能被
   * "淡入中的按钮"误伤 —— 他得先把焦点移过去。
   */
  if (attempt.keyboard) {
    return { accept: true, reason: "keyboard", detail: "keyboard activation" };
  }

  if (!(attempt.opacity >= MIN_OPACITY)) {
    return reject("fading", `chrome still fading (opacity ${attempt.opacity.toFixed(2)})`);
  }

  // 没有按下的松开，就是幽灵点击。这条是整套判断里最要紧的一条
  if (!attempt.downOnButton) {
    return reject("no-press", "no pointerdown on the button");
  }

  if (!attempt.upOnButton) {
    return reject("released-elsewhere", "pointer released outside the button");
  }

  /*
   * 坐标已经不是按钮了 —— 多半是输入迟到：点击发生之后窗口挪过位置，
   * 现在才被处理，于是同一组坐标落在了别的东西上。
   */
  if (!attempt.hitAtRelease) {
    return reject("stale-position", "button is no longer under the pointer");
  }

  if (!attempt.samePointer) {
    return reject("pointer-mismatch", "pointerup came from a different pointer");
  }

  if (attempt.travel > MAX_TRAVEL_PX) {
    return reject("dragged", `pointer travelled ${Math.round(attempt.travel)}px`);
  }

  return { accept: true, reason: "ok", detail: "press and release on the button" };
}
