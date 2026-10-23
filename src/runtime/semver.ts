/**
 * 棂 / Lattice —— 版本号与范围
 *
 * 组件商店要回答两个问题：**这个包比装着的那个新吗**、**它落在允许的范围里吗**。
 * 两个都只需要语义化版本的比较，不需要一个完整的 npm 实现 —— 所以这里只实现
 * 一份显式的、能一眼读完的规则表，而不是引入 semver 那个几千行的包。
 *
 * 支持：
 *   - 三段式 `1.2.3`，带预发布 `1.2.3-beta.1`，带构建元数据 `1.2.3+build.5`
 *   - 运算符 `=` `>` `>=` `<` `<=`，以及 `^` `~`
 *   - 部分版本与通配 `1`、`1.2`、`1.x`、`1.2.x`、`*`
 *   - 空格 = 与（`>=1.0.0 <2.0.0`），`||` = 或
 *
 * 刻意**不做**的：
 *   - 连字符区间（`1.2.3 - 2.0.0`）：`>=1.2.3 <=2.0.0` 写全了更清楚
 *   - npm 的"预发布只有在范围里也写了预发布时才匹配"那条例外。这里只按数值排序，
 *     预发布永远小于它的正式版。少一条隐式规则，就少一类"明明版本对得上却装不上"
 *   - 构建元数据不参与比较（`1.2.3+a` == `1.2.3+b`），这是语义化版本规范的要求
 *
 * 这套逻辑是纯函数，`tests/semver.html` 直接钉住边界。
 */

export interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
  /** 预发布的标识符，`1.2.3-beta.1` → `["beta", "1"]`；没有就是空数组 */
  prerelease: string[];
  /** 规范化后的原串（去掉构建元数据），用于展示 */
  text: string;
}

/** 版本号里允许出现的段：`1`、`1.2`、`1.2.x` 都算"部分版本" */
type Partial = { major?: number; minor?: number; patch?: number; prerelease: string[] };

const NUM = /^\d+$/;

/**
 * 解析。`allowPartial` 为真时接受 `1` / `1.2` / `1.x`（范围里用），
 * 为假时必须三段齐全（清单里的版本号用）。
 */
function parse(text: string, allowPartial: boolean): Partial | null {
  const trimmed = text.trim();
  if (!trimmed) return null;

  // 构建元数据整段丢掉：`+` 之后不参与比较
  const plus = trimmed.indexOf("+");
  const withoutBuild = plus >= 0 ? trimmed.slice(0, plus) : trimmed;
  const dash = withoutBuild.indexOf("-");
  const core = dash >= 0 ? withoutBuild.slice(0, dash) : withoutBuild;
  const preText = dash >= 0 ? withoutBuild.slice(dash + 1) : "";

  const parts = core.split(".");
  if (parts.length > 3) return null;

  const numbers: Array<number | undefined> = [undefined, undefined, undefined];
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    // 通配只能出现在末尾：`1.x.2` 没有意义，直接判非法
    if (part === "x" || part === "X" || part === "*") {
      if (index === 0 && parts.length === 1) return { prerelease: [] };
      for (let rest = index; rest < parts.length; rest += 1) {
        if (parts[rest] !== "x" && parts[rest] !== "X" && parts[rest] !== "*") return null;
      }
      break;
    }
    if (!NUM.test(part)) return null;
    numbers[index] = Number(part);
  }

  if (!allowPartial) {
    if (numbers.some((value) => value === undefined)) return null;
  }

  const prerelease = preText ? preText.split(".") : [];
  if (prerelease.some((item) => item === "" || !/^[0-9A-Za-z-]+$/.test(item))) return null;

  return { major: numbers[0], minor: numbers[1], patch: numbers[2], prerelease };
}

/** 严格解析（清单里的版本号）：三段齐全才算数 */
export function parseVersion(text: string): ParsedVersion | null {
  const parsed = parse(text, false);
  if (!parsed) return null;
  const major = parsed.major as number;
  const minor = parsed.minor as number;
  const patch = parsed.patch as number;
  return {
    major,
    minor,
    patch,
    prerelease: parsed.prerelease,
    text: `${major}.${minor}.${patch}${parsed.prerelease.length ? `-${parsed.prerelease.join(".")}` : ""}`,
  };
}

export function isValidVersion(text: string): boolean {
  return parseVersion(text) !== null;
}

function comparePrerelease(a: string[], b: string[]): number {
  // 没有预发布的一方更大：`1.0.0` > `1.0.0-beta`
  if (a.length === 0 && b.length === 0) return 0;
  if (a.length === 0) return 1;
  if (b.length === 0) return -1;

  for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
    const left = a[index];
    const right = b[index];
    const leftNumeric = NUM.test(left);
    const rightNumeric = NUM.test(right);
    if (leftNumeric && rightNumeric) {
      const diff = Number(left) - Number(right);
      if (diff !== 0) return diff > 0 ? 1 : -1;
      continue;
    }
    // 数字标识符永远小于字母标识符
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    if (left !== right) return left < right ? -1 : 1;
  }
  // 前缀相同：段数多的那个更大（`beta` < `beta.1`）
  return a.length === b.length ? 0 : a.length > b.length ? 1 : -1;
}

/** 比较两个版本。任一解析失败返回 null —— 调用方必须显式处理，别当 0 用 */
export function compareVersions(a: string, b: string): number | null {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (!left || !right) return null;

  for (const key of ["major", "minor", "patch"] as const) {
    if (left[key] !== right[key]) return left[key] > right[key] ? 1 : -1;
  }
  return comparePrerelease(left.prerelease, right.prerelease);
}

/** 列表里最大的那个版本（非法版本号跳过）；全非法返回 null */
export function maxVersion(list: string[]): string | null {
  let best: string | null = null;
  for (const item of list) {
    if (!isValidVersion(item)) continue;
    if (best === null || (compareVersions(item, best) ?? 0) > 0) best = item;
  }
  return best;
}

type Bound = { op: ">" | ">=" | "<" | "<=" | "="; version: ParsedVersion };

function makeVersion(major: number, minor: number, patch: number, prerelease: string[] = []): ParsedVersion {
  return {
    major,
    minor,
    patch,
    prerelease,
    text: `${major}.${minor}.${patch}${prerelease.length ? `-${prerelease.join(".")}` : ""}`,
  };
}

function bound(op: Bound["op"], version: ParsedVersion): Bound {
  return { op, version };
}

/**
 * 把一个比较器展开成若干个上下界。
 * 返回 null 表示这个 token 不是合法的比较器 —— 整条范围判非法（不猜）。
 */
function expand(token: string): Bound[] | null {
  const match = /^(>=|<=|>|<|=|\^|~)?\s*(.+)$/.exec(token);
  if (!match) return null;
  const operator = match[1] ?? "";
  const body = match[2].trim();
  const parsed = parse(body, true);
  if (!parsed) return null;

  // `*` / `x` 单独出现：任何版本都行，展开成空（不产生约束）
  if (parsed.major === undefined) return [];

  const major = parsed.major;
  const minor = parsed.minor;
  const patch = parsed.patch;
  const pre = parsed.prerelease;

  switch (operator) {
    case "^": {
      const low = makeVersion(major, minor ?? 0, patch ?? 0, pre);
      // `^0.2.3` 只放开 patch，`^0.0.3` 只放开 patch 到下一个 patch
      if (major > 0) return [bound(">=", low), bound("<", makeVersion(major + 1, 0, 0))];
      if (minor === undefined) return [bound(">=", low), bound("<", makeVersion(1, 0, 0))];
      if (minor > 0) return [bound(">=", low), bound("<", makeVersion(0, minor + 1, 0))];
      if (patch === undefined) return [bound(">=", low), bound("<", makeVersion(0, 1, 0))];
      return [bound(">=", low), bound("<", makeVersion(0, 0, patch + 1))];
    }
    case "~": {
      const low = makeVersion(major, minor ?? 0, patch ?? 0, pre);
      if (minor === undefined) return [bound(">=", low), bound("<", makeVersion(major + 1, 0, 0))];
      return [bound(">=", low), bound("<", makeVersion(major, minor + 1, 0))];
    }
    case ">":
    case ">=":
    case "<":
    case "<=":
      // 部分版本在大小比较里按补 0 处理：`>1.2` 就是 `>1.2.0`
      return [bound(operator, makeVersion(major, minor ?? 0, patch ?? 0, pre))];
    default:
      break;
  }

  // 没有运算符（含显式 `=`）：部分版本按通配处理，`1.2` → `>=1.2.0 <1.3.0`
  const low = makeVersion(major, minor ?? 0, patch ?? 0, pre);
  if (patch !== undefined) return [bound("=", low)];
  if (minor !== undefined) return [bound(">=", low), bound("<", makeVersion(major, minor + 1, 0))];
  return [bound(">=", low), bound("<", makeVersion(major + 1, 0, 0))];
}

function test(version: ParsedVersion, item: Bound): boolean {
  const order = compareVersions(version.text, item.version.text) ?? 0;

  switch (item.op) {
    case ">":
      return order > 0;
    case ">=":
      return order >= 0;
    case "<":
      return order < 0;
    case "<=":
      return order <= 0;
    case "=":
      return order === 0;
    default:
      return false;
  }
}

/** 解析一条范围（不含 `||`）。返回 null = 语法错 */
function parseRange(range: string): Bound[][] | null {
  const alternatives = range.split("||").map((item) => item.trim());
  const out: Bound[][] = [];

  for (const alternative of alternatives) {
    if (!alternative) continue; // `1.0.0 ||` 这类尾巴当没写
    const bounds: Bound[] = [];
    for (const token of alternative.split(/\s+/)) {
      const expanded = expand(token);
      if (expanded === null) return null;
      bounds.push(...expanded);
    }
    out.push(bounds);
  }

  // 空范围（`""` / `*`）→ 一组空约束，任何版本都满足
  return out.length > 0 ? out : [[]];
}

export function isValidRange(range: string): boolean {
  return parseRange(range) !== null;
}

/**
 * 版本是否落在范围里。
 * 版本或范围写错一律返回 **false** —— "不确定"在授权/安装这种场合必须当成"不行"。
 */
export function satisfies(version: string, range: string): boolean {
  const parsed = parseVersion(version);
  if (!parsed) return false;
  const alternatives = parseRange(range);
  if (!alternatives) return false;

  return alternatives.some((bounds) => bounds.every((item) => test(parsed, item)));
}

/** 从一堆版本里挑出满足范围的最高那个 */
export function maxSatisfying(versions: string[], range: string): string | null {
  let best: string | null = null;
  for (const item of versions) {
    if (!satisfies(item, range)) continue;
    if (best === null || (compareVersions(item, best) ?? 0) > 0) best = item;
  }
  return best;
}
