/**
 * 发布：一个组件目录 → 目录仓库里的一个可安装条目。一条命令走完。
 *
 *   npm run publish:widget -- public/widgets/lattice.note --key .keys/publisher.key
 *   npm run publish:widget -- examples/counter --registry ../lattice-registry --name Tom
 *   npm run publish:widget -- public/widgets/lattice.note --key .keys/publisher.key --dry-run
 *
 * # 以前是几步
 *
 * 1. 在这里 `npm run pack:widget` 打包
 * 2. 把 `.lattice` 拷进 `lattice-registry/packages/`
 * 3. 在 registry 里跑 `sign.mjs` 生成 sidecar
 * 4. 跑 `build.mjs` 重建 `registry.json`
 * 5. 两个仓库各提交一次
 *
 * 五步里漏掉任何一步，症状都不在本地报错：可能是"目录里没有这个组件"，
 * 可能是"签名验不过"，也可能是"装上了但版本号还是旧的"。这条命令把它们
 * 串成一次执行，最后只说一件事：**该提交哪几个文件**。
 *
 * # 为什么 sidecar 在这里写，而不是去调 registry 的 sign.mjs
 *
 * registry 是**公开的目录仓库**，别人可以完全不装 Lattice 就往里发（用 registry
 * 自带的 `sign.mjs`）。但 Lattice 本体这边已经有一套和 `signature.rs` 单测对齐的
 * ed25519（`scripts/sign-widget.mjs`），再从 registry 里 import 一次，等于把两个
 * 仓库编成一个 —— 目录仓库是别人会 fork 的东西，不该成为构建本体的依赖。
 *
 * 所以这里只复用**自己的**打包和签名代码，把 registry 当成"校验器 + 渲染器"，
 * 用子进程调它的 `build.mjs`。四条校验（文件名、签名、id/版本格式、版本唯一）
 * 依然只有 `build.mjs` 里那一份，不在两边各写一遍。
 *
 * 顺带一个免费的好处：`build.mjs` 用的验签实现是 `registry/scripts/ed25519.mjs`，
 * 和这边 `sign-widget.mjs` 是两份独立代码。每次发布都让它们对撞一次，
 * 谁悄悄漂了，这条命令当场就会红。
 *
 * # 和 `store:index` 的区别
 *
 * `npm run store:index` 生成的是 `public/store/` —— 跟着应用一起发的**内置演示
 * 目录**，用仓库里那把公开的 `dev-publisher.key` 签，目的是"npm run dev 之后
 * 开箱就有东西可看"。
 *
 * 这条命令发的是**远端目录**（lattice-registry，公网可见），用真私钥签。两者
 * 是两套东西：前者是随包发行的样例，后者才是别人真正会去装的来源。不要把
 * 真私钥用在 `store:index` 上，也不要把演示钥匙的包混进 registry —— 同一个
 * 组件 id 只能由一个发布者维护，`build.mjs` 会拒。
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { buildZip, collectFiles } from "./pack-widget.mjs";
import { publicKeyFromSeed, sha256Hex, signBytes, verifyBytes } from "./sign-widget.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** 和 registry 的 build.mjs 同一套规则；在这里先挡一道，是为了别等到写完文件才失败 */
const ID_RE = /^[a-z0-9]+(?:[.-][a-z0-9]+)+$/;
const VERSION_RE = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// ---------------------------------------------------------------------------
// 参数
// ---------------------------------------------------------------------------

const VALUE_FLAGS = new Set(["--key", "--registry", "--name", "--published", "--homepage"]);
const options = {};
const positional = [];

for (let index = 0; index < process.argv.length - 2; index += 1) {
  const token = process.argv[index + 2];
  if (token.startsWith("--")) {
    if (VALUE_FLAGS.has(token)) {
      options[token.slice(2)] = process.argv[index + 3] ?? null;
      index += 1;
    } else {
      options[token.slice(2)] = true;
    }
  } else {
    positional.push(token);
  }
}

function usage(message) {
  if (message) console.error(`\n  ${message}\n`);
  console.error("  用法：npm run publish:widget -- <组件目录> [选项]\n");
  console.error("    --key <文件>        签名私钥（一行 hex）；不给就读 LATTICE_PUBLISHER_KEY");
  console.error("    --registry <目录>   目录仓库的位置，默认 ../lattice-registry");
  console.error("    --name <名字>       发布者名字（安装时会显示）；默认沿用目录里同一把钥匙的名字");
  console.error("    --published <日期>  YYYY-MM-DD，默认今天");
  console.error("    --homepage <地址>   可选，写进目录条目");
  console.error("    --force             版本号没变但内容变了时，覆盖已发布的包");
  console.error("    --dry-run           只打包和签名，不写文件、不重建目录\n");
  console.error("  例子：npm run publish:widget -- public/widgets/lattice.note --key .keys/publisher.key\n");
  process.exit(1);
}

function fail(message) {
  console.error(`\n  ${message}\n`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// 组件目录
// ---------------------------------------------------------------------------

const dirArg = positional[0];
if (!dirArg) usage("缺少组件目录");

const dir = resolve(process.cwd(), dirArg);
const manifestPath = join(dir, "manifest.json");
if (!existsSync(manifestPath)) usage(`${dirArg} 里没有 manifest.json —— 这不像一个组件目录`);

let manifest;
try {
  manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
} catch (error) {
  fail(`${dirArg}/manifest.json 不是合法 JSON：${error.message}`);
}

const id = String(manifest.id ?? "");
const version = String(manifest.version ?? "");

if (!ID_RE.test(id)) {
  fail(`manifest.id 不合法（${id || "缺失"}）—— 要像 lattice.note 这样带点，全小写`);
}
if (!VERSION_RE.test(version)) {
  fail(`manifest.version 不合法（${version || "缺失"}）—— 发布必须有像 1.0.0 的版本号`);
}

// ---------------------------------------------------------------------------
// 目录仓库
// ---------------------------------------------------------------------------

const registryArg = options.registry ?? process.env.LATTICE_REGISTRY ?? "../lattice-registry";
const registry = resolve(process.cwd(), registryArg);
const buildScript = join(registry, "scripts", "build.mjs");

if (!existsSync(buildScript)) {
  fail(
    `${registryArg} 不像目录仓库（找不到 scripts/build.mjs）。\n` +
      "  用 --registry <目录> 指过去，或者先把 lattice-registry clone 到隔壁。",
  );
}

const packagesDir = join(registry, "packages");

// ---------------------------------------------------------------------------
// 私钥
// ---------------------------------------------------------------------------

const keyFile = options.key ?? null;
const seed = keyFile
  ? readFileSync(resolve(process.cwd(), keyFile), "utf8")
  : (process.env.LATTICE_PUBLISHER_KEY ?? "");

if (!seed.trim()) {
  fail("没有私钥：给 --key <文件>，或者设 LATTICE_PUBLISHER_KEY\n  生成一把：npm run sign:widget -- --gen-key --out .keys/publisher.key");
}

let publicKey;
try {
  ({ publicKey } = publicKeyFromSeed(seed));
} catch (error) {
  fail(`私钥读不出来：${error.message}`);
}

// ---------------------------------------------------------------------------
// 发布者名字
// ---------------------------------------------------------------------------

/**
 * 同一把钥匙发过的包，名字沿用上一次的。
 *
 * 名字只是给人看的，钥匙才是身份 —— 同一把钥匙换显示名不会影响任何校验，
 * 但每次都要手打 `--name` 是没必要的重复劳动。找不到就报错，不瞎猜一个默认值。
 */
function inheritedName() {
  if (!existsSync(packagesDir)) return null;
  for (const file of readdirSync(packagesDir)) {
    if (!file.endsWith(".json")) continue;
    try {
      const sidecar = JSON.parse(readFileSync(join(packagesDir, file), "utf8"));
      if (String(sidecar?.publisher?.key ?? "").toLowerCase() === publicKey) {
        const name = String(sidecar.publisher.name ?? "").trim();
        if (name) return name;
      }
    } catch {
      // 读不出来的 sidecar 交给 build.mjs 去抱怨，这里跳过
    }
  }
  return null;
}

let publisherName = String(options.name ?? process.env.LATTICE_PUBLISHER_NAME ?? "").trim();
let nameSource = "参数";
if (!publisherName) {
  const inherited = inheritedName();
  if (inherited) {
    publisherName = inherited;
    nameSource = "沿用目录里同一把钥匙的名字";
  }
}
if (!publisherName) {
  fail("没有发布者名字：给 --name <名字>（安装时用户看到的就是它）");
}

// ---------------------------------------------------------------------------
// 日期 / 主页
// ---------------------------------------------------------------------------

let published = String(options.published ?? new Date().toISOString().slice(0, 10));
if (!DATE_RE.test(published)) fail(`--published 要写成 YYYY-MM-DD，收到 ${published}`);

let homepage = options.homepage ?? manifest.homepage ?? null;

// ---------------------------------------------------------------------------
// 打包 + 签名
// ---------------------------------------------------------------------------

const names = collectFiles(dir);
const files = names.map((name) => ({ name, body: readFileSync(join(dir, name.split("/").join(sep))) }));
const zip = buildZip(files);
const sha256 = sha256Hex(zip);

const signature = signBytes(zip, seed);
if (!verifyBytes(zip, signature, publicKey)) {
  fail("签完自己验不过 —— 不该发生，先别发这个包");
}

const fileName = `${id}-${version}.lattice`;
const target = join(packagesDir, fileName);
const sidecarPath = join(packagesDir, `${id}-${version}.json`);

// ---------------------------------------------------------------------------
// 版本号的两道闸
// ---------------------------------------------------------------------------

/** 目录里已经有同一个版本号了？ */
let replacing = false;
if (existsSync(target)) {
  const existingSha = sha256Hex(readFileSync(target));
  if (existingSha === sha256) {
    // 一模一样：重发一次应该是幂等的 —— 不报错，也别把 sidecar 的发布日期改成今天，
    // 那会让 registry.json 的 updated 动一下，diff 里出现一个"什么都没变"的提交
    console.log(`\n  ${fileName} 已经发过，内容和这次打出来的完全一样 —— 继续往下走（不会产生新改动）。`);
    if (existsSync(sidecarPath)) {
      try {
        const previous = JSON.parse(readFileSync(sidecarPath, "utf8"));
        if (!options.published && DATE_RE.test(String(previous.published ?? ""))) published = previous.published;
        if (!options.homepage && previous.homepage) homepage = String(previous.homepage);
      } catch {
        // 旧 sidecar 坏了就按这次的写，build.mjs 会兜底校验
      }
    }
  } else if (options.force) {
    replacing = true;
  } else {
    fail(
      `${fileName} 已经存在，但内容和这次打出来的不一样。\n` +
        "  版本号没变就换内容，已经装了旧包的人不会收到更新 —— 他们看到的版本号是同一个。\n" +
        "  改 manifest.version 再发；确实要覆盖就加 --force。",
    );
  }
}

/** 目录里已经有更新的版本了？只提醒，不拦 */
function newerVersionExists() {
  const cataloguePath = join(registry, "registry.json");
  if (!existsSync(cataloguePath)) return null;
  let catalogue;
  try {
    catalogue = JSON.parse(readFileSync(cataloguePath, "utf8"));
  } catch {
    return null;
  }
  const entry = (catalogue.widgets ?? []).find((item) => item.id === id);
  if (!entry) return null;

  const compare = (a, b) => {
    const split = (value) => value.split(/[.+-]/).map((part) => (/^\d+$/.test(part) ? Number(part) : part));
    const left = split(a);
    const right = split(b);
    for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
      const one = left[index] ?? 0;
      const two = right[index] ?? 0;
      if (one === two) continue;
      if (typeof one === "number" && typeof two === "number") return one - two;
      return String(one).localeCompare(String(two));
    }
    return 0;
  };

  const newest = (entry.versions ?? []).reduce((best, item) => (compare(item.version, best) > 0 ? item.version : best), "");
  return newest && compare(newest, version) > 0 ? newest : null;
}

const newer = newerVersionExists();

// ---------------------------------------------------------------------------
// 写文件
// ---------------------------------------------------------------------------

const prettyTarget = target.startsWith(root) ? relative(root, target) : target;

console.log(`\n  ${id} ${version}`);
console.log(`  ${names.length} 个文件，${(zip.length / 1024).toFixed(1)} KB`);
console.log(`  sha256     ${sha256}`);
console.log(`  published  ${published}`);
console.log(`  publisher  ${publisherName}（${nameSource}）${publicKey}`);
console.log(`  → ${prettyTarget}`);

if (newer) {
  console.log(`\n  注意：目录里已经有 ${id} ${newer}。这次发的 ${version} 会被收录，但用户装到的是最新版 —— 发旧版本号通常不是本意。`);
}

if (options["dry-run"]) {
  console.log("\n  --dry-run：没有写文件，也没有重建 registry.json。\n");
  process.exit(0);
}

mkdirSync(packagesDir, { recursive: true });
writeFileSync(target, zip);

const sidecar = {
  schema: 1,
  published,
  publisher: { name: publisherName, key: publicKey },
  ...(homepage ? { homepage } : {}),
  signature,
};
writeFileSync(sidecarPath, `${JSON.stringify(sidecar, null, 2)}\n`);

if (replacing) console.log(`\n  --force：覆盖了已发布的 ${fileName}（装过旧包的人不会收到更新）。`);

// ---------------------------------------------------------------------------
// 重建目录（registry 自己的四条校验在这里跑）
// ---------------------------------------------------------------------------

const built = spawnSync(process.execPath, [buildScript], { cwd: registry, stdio: "inherit" });
if (built.status !== 0) {
  fail(
    "目录构建失败 —— 上面每条问题都指到了具体文件。\n" +
      "  已写进 packages/ 的两个文件留着没删（重跑一次是幂等的），改完再跑这条命令。",
  );
}

if (!existsSync(join(registry, "icons", `${id}.svg`))) {
  console.log(`  （目录里没有 icons/${id}.svg —— 这条记录会没有图标，不影响安装）`);
}

// ---------------------------------------------------------------------------
// 该提交什么
// ---------------------------------------------------------------------------

const status = spawnSync("git", ["status", "--porcelain"], { cwd: registry, encoding: "utf8" });
const changed = (status.stdout ?? "")
  .split("\n")
  .map((line) => line.trimEnd())
  .filter(Boolean);

const where = relative(process.cwd(), registry) || ".";
const command = `cd ${where === "." ? "." : where.replaceAll("\\", "/")} && git add -A && git commit -m "publish ${id} ${version}" && git push`;

console.log("  改动：");
if (changed.length > 0) {
  for (const line of changed) console.log(`    ${line}`);
} else {
  console.log("    （无 —— 目录已经是最新的）");
}

if (changed.length > 0) {
  console.log(`\n  提交并推送：\n    ${command}\n`);
  console.log("  push 到 main 之后，GitHub Actions 会重新部署目录，几分钟后 Lattice 里就能看到。");
  console.log("  （前提是这个目录已经配成了 Lattice 的目录源：设置里填 https://<Pages 域名>/registry.json）\n");
} else {
  console.log("");
}
