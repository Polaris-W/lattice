/**
 * 把 SDK 同步到"自己带一份"的地方。
 *
 * SDK 的发布形态是**跟着组件一起分发**的单个 ES 模块 —— 组件目录里那份
 * `lattice.js` 就是它运行时真正加载的文件。所以每多一个示例 / 官方组件用它，
 * 就多一份拷贝，而拷贝会漂移：改了 `packages/sdk/lattice.js` 忘了同步，
 * 示例里跑的还是上一版，而它看起来完全正常。
 *
 * 这个脚本负责"同步"，`scripts/sdk.test.mjs` 负责"抓漂移"（`npm run test:sdk`，
 * 不依赖 dev server，CI 也跑）。两件事分开：改完 SDK 先 `npm run sdk:sync`，
 * 忘了跑的话测试会红。
 *
 * 用法：
 *   node scripts/sdk-sync.mjs          # 覆盖所有已存在的拷贝
 *   node scripts/sdk-sync.mjs --check  # 只报告差异，不写盘（测试用同一套逻辑）
 */
import { copyFileSync, existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = join(root, "packages", "sdk");

/** SDK 的组成文件：这两个必须一起拷，少一个编辑器就没提示 */
export const FILES = ["lattice.js", "lattice.d.ts"];

/**
 * 找所有"自己带了一份 SDK"的目录。
 *
 * 两条规则，各自有理由：
 *   - **`examples/` 下的每个组件都带**：它们是给第三方抄的样板，抄的时候
 *     得能直接跑，不能留一个"自己想办法装 SDK"的坑
 *   - **`public/widgets/` 下只有已经带了的才同步**：官方组件是"不用 SDK 也能
 *     写"的活证据（它们就是手写 postMessage 的），不该被一刀切改成依赖 SDK
 *
 * 判据是"目录里有没有 lattice.js"，不是写死一份名单 —— 名单会漏，而漏掉的
 * 那个恰好是作者新加的示例。
 */
export function vendoredDirs(base = root) {
  const found = [];
  const examples = join(base, "examples");
  if (existsSync(examples)) {
    for (const name of readdirSync(examples)) {
      const candidate = join(examples, name);
      if (statSync(candidate).isDirectory()) found.push(candidate);
    }
  }

  const widgets = join(base, "public", "widgets");
  if (existsSync(widgets)) {
    for (const name of readdirSync(widgets)) {
      const candidate = join(widgets, name);
      if (!statSync(candidate).isDirectory()) continue;
      if (existsSync(join(candidate, "lattice.js"))) found.push(candidate);
    }
  }

  return found;
}

function sameBytes(a, b) {
  return existsSync(a) && existsSync(b) && readFileSync(a).equals(readFileSync(b));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const check = process.argv.includes("--check");
  const dirs = vendoredDirs();

  if (dirs.length === 0) {
    console.log("[sdk] 没有找到任何自带 SDK 的组件目录");
  }

  let changed = 0;
  for (const dir of dirs) {
    for (const file of FILES) {
      const from = join(source, file);
      const to = join(dir, file);
      if (sameBytes(from, to)) continue;
      changed += 1;
      const label = to.slice(root.length + 1);
      if (check) {
        console.log(`[sdk] 与源不一致：${label}`);
      } else {
        copyFileSync(from, to);
        console.log(`[sdk] 已同步：${label}`);
      }
    }
  }

  if (check && changed > 0) process.exitCode = 1;
  if (changed === 0) console.log(`[sdk] ${dirs.length} 个目录都是最新的`);
}
