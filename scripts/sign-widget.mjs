/**
 * 给 `.lattice` 包签名（ed25519），以及生成发布者密钥。
 *
 *   npm run sign:widget -- --gen-key --out scripts/dev-publisher.key
 *   npm run sign:widget -- dist-packs/lattice.clock-1.0.0.lattice --key scripts/dev-publisher.key
 *   npm run sign:widget -- --selftest
 *
 * # 为什么用 Node 内置的 crypto
 *
 * ed25519 就在 Node 的标准库里（`crypto.sign(null, data, key)`），不用装任何东西。
 * 而 Rust 那边的校验用的是 `ed25519-dalek` —— **同一套算法**，这是这块最重要的
 * 一件事：签名工具和校验方用的算法必须能对上，否则"签了但验不过"会花掉一整天。
 * `--selftest` 和 `signature.rs` 里的单测用的是同一组固定向量，两边任何一边
 * 换了算法，这两条会同时红。
 *
 * # 私钥长什么样
 *
 * 32 字节的种子，写成 64 个 hex 字符、一行。够短，能放进环境变量；
 * 也够明确，不会被误当成 JSON 里的公钥。
 */
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** PKCS#8 里 ed25519 私钥的前缀：OID 1.3.101.112 + 32 字节种子的包装 */
const PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
/** SPKI 里 ed25519 公钥的前缀 */
const SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

export function sha256Hex(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

/** 32 字节种子 → 公钥（hex）。私钥对象只在内存里用，不落盘 */
export function publicKeyFromSeed(seedHex) {
  const seed = Buffer.from(seedHex.trim(), "hex");
  if (seed.length !== 32) {
    throw new Error(`publisher key must be 32 bytes (64 hex characters), got ${seed.length} bytes`);
  }
  const privateKey = createPrivateKey({
    key: Buffer.concat([PKCS8_PREFIX, seed]),
    format: "der",
    type: "pkcs8",
  });
  const spki = createPublicKey(privateKey).export({ type: "spki", format: "der" });
  return { publicKey: spki.subarray(SPKI_PREFIX.length).toString("hex"), privateKey };
}

export function signBytes(bytes, seedHex) {
  const { privateKey } = publicKeyFromSeed(seedHex);
  return sign(null, bytes, privateKey).toString("hex");
}

export function verifyBytes(bytes, signatureHex, publicKeyHex) {
  const spki = Buffer.concat([SPKI_PREFIX, Buffer.from(publicKeyHex, "hex")]);
  const key = createPublicKey({ key: spki, format: "der", type: "spki" });
  return verify(null, bytes, key, Buffer.from(signatureHex, "hex"));
}

/**
 * 自检向量。
 *
 * 种子 `9d61b1…7f60`、正文 `lattice signature self test`。同一组值写在
 * `src-tauri/src/signature.rs` 的单测里 —— 两边都过，才说明 Node 签出来的
 * 东西 Rust 验得过。
 */
export const SELFTEST = {
  seed: "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60",
  payload: "lattice signature self test",
  publicKey: "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a",
  signature:
    "9f9fcdb0cdc48c7acfd2e5a6da1db2337e2749ed8c0419e4fd5efe2ec15cddea43009a0326b7d839b66ca187544f9f7fb08a899c7132ab0a79d94ad41a46ac04",
};

export function selfTest() {
  const payload = Buffer.from(SELFTEST.payload);
  const { publicKey } = publicKeyFromSeed(SELFTEST.seed);
  if (publicKey !== SELFTEST.publicKey) {
    throw new Error(`public key drifted: ${publicKey}`);
  }
  const signature = signBytes(payload, SELFTEST.seed);
  if (signature !== SELFTEST.signature) {
    throw new Error(`signature drifted: ${signature}`);
  }
  if (!verifyBytes(payload, signature, publicKey)) {
    throw new Error("signature does not verify");
  }
  return true;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  const args = process.argv.slice(2);
  const flag = (name) => {
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] : null;
  };

  if (args.includes("--selftest")) {
    try {
      selfTest();
      console.log("\n  自检通过：Node 签出来的签名，和 Rust 单测里的那组值一致。\n");
    } catch (error) {
      console.error(`\n  自检失败：${error.message}\n`);
      process.exit(1);
    }
  } else if (args.includes("--gen-key")) {
    const { privateKey } = generateKeyPairSync("ed25519");
    const pkcs8 = privateKey.export({ type: "pkcs8", format: "der" });
    const seed = pkcs8.subarray(PKCS8_PREFIX.length).toString("hex");
    const { publicKey } = publicKeyFromSeed(seed);

    const out = flag("--out") ?? "publisher.key";
    writeFileSync(resolve(process.cwd(), out), `${seed}\n`);
    console.log(`\n  私钥 → ${out}（一行 hex；真在用的私钥不要提交到公开仓库）`);
    console.log(`  公钥 → ${publicKey}`);
    console.log(`\n  把公钥写进目录的 publisher.key，包用这把私钥签。\n`);
  } else {
    const file = args.find((token) => !token.startsWith("--") && token !== flag("--key"));
    const keyPath = flag("--key");
    if (!file || !keyPath) {
      console.error("\n  用法：npm run sign:widget -- <包文件> --key <私钥文件>\n");
      console.error("  例子：npm run sign:widget -- dist-packs/lattice.clock-1.0.0.lattice --key scripts/dev-publisher.key\n");
      process.exit(1);
    }

    const seed = readFileSync(resolve(process.cwd(), keyPath), "utf8");
    const bytes = readFileSync(resolve(process.cwd(), file));
    const { publicKey } = publicKeyFromSeed(seed);
    const signature = signBytes(bytes, seed);

    if (!verifyBytes(bytes, signature, publicKey)) {
      console.error("\n  签完自己验不过 —— 不该发生，先别用这个包\n");
      process.exit(1);
    }

    console.log(
      JSON.stringify(
        {
          file,
          size: bytes.length,
          sha256: sha256Hex(bytes),
          signature,
          publicKey,
        },
        null,
        2,
      ),
    );
  }
}
