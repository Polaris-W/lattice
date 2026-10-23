/**
 * 打包：一个组件目录 → 一个 `.lattice` 文件。
 *
 * `npm run pack:widget -- examples/counter`
 * `npm run pack:widget -- public/widgets/lattice.clock --out dist-packs`
 *
 * # 为什么是 ZIP，又不是 zip 库
 *
 * `.lattice` 就是个 ZIP：谁都能用现成的解压工具看一眼，出了事好查。写 ZIP
 * 容器这件事本身只有几十行（本地头 + 中央目录 + 结束记录），而 `zip` 那类库
 * 会带进来一串依赖 —— 和 `metrics.rs` 手搓 Win32 是同一条取舍。
 * deflate 用 Node 自带的 `zlib.deflateRawSync`，不自己实现压缩算法。
 *
 * # 为什么每次打出来的字节都一样
 *
 * 时间戳固定成 1980-01-01，文件按名字排序。同样的目录打两次必须得到**同一个
 * 哈希** —— 否则"这个包是不是我上次发的那个"永远说不清，将来要做签名和
 * 增量更新也得先有这个前提。
 */
import { deflateRawSync } from "node:zlib";
import { readFileSync, readdirSync, statSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** 包里的垃圾：系统缩略图、编辑器备份、以及嵌套的包自己 */
const IGNORED = new Set([".DS_Store", "Thumbs.db", "desktop.ini"]);
const IGNORED_EXT = [".lattice", ".swp", ".tmp"];

/** ZIP 的 DOS 时间戳固定成 1980-01-01 00:00:00（时间字段的最小合法值） */
const DOS_TIME = 0;
const DOS_DATE = 33; // (1980-1980)<<9 | 1<<5 | 1

// ---------------------------------------------------------------------------
// CRC32（ZIP 用的是标准多项式 0xEDB88320）
// ---------------------------------------------------------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

// ---------------------------------------------------------------------------
// 收集文件
// ---------------------------------------------------------------------------

/** 递归列出目录下所有该进包的文件，返回包内相对路径（`/` 分隔、已排序） */
export function collectFiles(dir, base = dir) {
  const out = [];
  for (const name of readdirSync(dir).sort()) {
    if (IGNORED.has(name)) continue;
    if (IGNORED_EXT.some((extension) => name.endsWith(extension))) continue;
    const path = join(dir, name);
    const stats = statSync(path);
    if (stats.isDirectory()) {
      out.push(...collectFiles(path, base));
    } else if (stats.isFile()) {
      out.push(relative(base, path).split(sep).join("/"));
    }
  }
  return out.sort();
}

// ---------------------------------------------------------------------------
// 写 ZIP
// ---------------------------------------------------------------------------

/**
 * 拼一个 ZIP。返回 Buffer。
 *
 * @param {Array<{name: string, body: Buffer}>} files 包内路径 + 内容
 */
export function buildZip(files) {
  const local = [];
  const central = [];
  let offset = 0;

  for (const file of files) {
    const nameBytes = Buffer.from(file.name, "utf8");
    const crc = crc32(file.body);
    // 小的不压：压完更大的情况很常见（图标、短 JSON），白占 CPU 还变大
    const deflated = deflateRawSync(file.body, { level: 9 });
    const useDeflate = deflated.length < file.body.length;
    const payload = useDeflate ? deflated : file.body;
    const method = useDeflate ? 8 : 0;
    // bit 11 = 名字是 UTF-8。没有这一位，中文文件名在别人的解压工具里就是乱码
    const flags = 0x0800;

    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4); // 需要的版本 2.0
    header.writeUInt16LE(flags, 6);
    header.writeUInt16LE(method, 8);
    header.writeUInt16LE(DOS_TIME, 10);
    header.writeUInt16LE(DOS_DATE, 12);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(payload.length, 18);
    header.writeUInt32LE(file.body.length, 22);
    header.writeUInt16LE(nameBytes.length, 26);
    header.writeUInt16LE(0, 28); // extra

    local.push(header, nameBytes, payload);

    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4); // 打包工具版本
    entry.writeUInt16LE(20, 6); // 需要的版本
    entry.writeUInt16LE(flags, 8);
    entry.writeUInt16LE(method, 10);
    entry.writeUInt16LE(DOS_TIME, 12);
    entry.writeUInt16LE(DOS_DATE, 14);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(payload.length, 20);
    entry.writeUInt32LE(file.body.length, 24);
    entry.writeUInt16LE(nameBytes.length, 28);
    entry.writeUInt16LE(0, 30); // extra
    entry.writeUInt16LE(0, 32); // comment
    entry.writeUInt16LE(0, 34); // 起始磁盘
    entry.writeUInt16LE(0, 36); // 内部属性
    entry.writeUInt32LE(0, 38); // 外部属性
    entry.writeUInt32LE(offset, 42);
    central.push(entry, nameBytes);

    offset += header.length + nameBytes.length + payload.length;
  }

  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...local, directory, end]);
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function usage(message) {
  if (message) console.error(`\n  ${message}\n`);
  console.error("  用法：npm run pack:widget -- <组件目录> [--out <文件或目录>]\n");
  console.error("  例子：npm run pack:widget -- examples/counter");
  console.error("        npm run pack:widget -- public/widgets/lattice.clock --out dist-packs\n");
  process.exit(1);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const outIndex = args.indexOf("--out");
  const outArg = outIndex >= 0 ? args[outIndex + 1] : null;
  const dirArg = args.find((token, index) => !token.startsWith("--") && index !== outIndex + 1);

  if (!dirArg) usage("缺少组件目录");
  const dir = resolve(process.cwd(), dirArg);
  if (!existsSync(dir) || !statSync(dir).isDirectory()) usage(`${dirArg} 不是一个目录`);

  const manifestPath = join(dir, "manifest.json");
  if (!existsSync(manifestPath)) usage(`${dirArg} 里没有 manifest.json —— 这不像一个组件目录`);

  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (error) {
    usage(`manifest.json 不是合法 JSON：${error.message}`);
  }
  if (!manifest.id) usage("manifest.json 里没有 id");

  const names = collectFiles(dir);
  const files = names.map((name) => ({ name, body: readFileSync(join(dir, name.split("/").join(sep))) }));
  const zip = buildZip(files);

  const fileName = `${manifest.id}-${manifest.version || "0.0.0"}.lattice`;
  let target;
  if (!outArg) {
    target = join(root, "dist-packs", fileName);
  } else {
    const resolved = resolve(process.cwd(), outArg);
    // 以 `.lattice` 结尾才当成文件名，其余一律当目录（不存在就建）——
    // 反过来判断的话，`--out dist-packs` 第一次会悄悄写出一个叫 dist-packs 的文件
    target = resolved.endsWith(".lattice") ? resolved : join(resolved, fileName);
  }
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, zip);

  const pretty = target.startsWith(root) ? relative(root, target) : target;
  console.log(`\n  ${manifest.id} ${manifest.version || ""} → ${pretty}`);
  console.log(`  ${names.length} 个文件，${(zip.length / 1024).toFixed(1)} KB（原始 ${(files.reduce((sum, file) => sum + file.body.length, 0) / 1024).toFixed(1)} KB）`);
  console.log(`\n  拖进 Lattice 窗口就能安装；或者交给别人，同样拖进去。\n`);
}
