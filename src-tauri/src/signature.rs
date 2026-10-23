//! 包签名校验：ed25519 + sha256。
//!
//! 两道关，顺序不能换：
//!
//! 1. **摘要**：`sha256(包字节)` 必须等于目录里写的那个 hash。挡的是传输损坏、
//!    被换掉的包、以及"目录说 A、实际下载到 B"这种错位。
//! 2. **签名**：`ed25519(包字节)` 必须能被发布者公钥验过。挡的是伪造 ——
//!    没有私钥的人改不了包，改了签名就过不去。
//!
//! 先摘要是因为便宜：一次 sha256 就能把 99% 的坏包挡在密码学运算之外。
//! 但**不能只有摘要**：目录本身可能被改（见 `catalogue.ts` 的说明），
//! 只有签名才把"这个包"绑到"这个人"上。
//!
//! # 为什么是 ed25519
//!
//! - 32 字节公钥、64 字节签名，塞进 JSON 目录不占地方
//! - 确定性签名，不需要随机数源（RNG 出问题不会变成"签出来的东西别人验不过"）
//! - Node 内置支持：`crypto.sign(null, bytes, privateKey)`，打包脚本不用装任何东西 ——
//!   **签名工具和校验方用同一套算法**，这件事比算法本身多快更重要
//!
//! # 为什么不用 Windows CNG
//!
//! CNG 不通用地支持 ed25519（Win11 才有一部分），走 ECDSA P-256 的话
//! 要自己拼 `BCRYPT_ECCKEY_BLOB`、自己拿 SHA-256 句柄，几百行 unsafe，
//! 而这块代码**没有单测能兜**（本机跑不了 `cargo test`，见 AGENTS §11）。
//! 纯 Rust 实现能被 CI 上的 `cargo test` 直接验，代价只是多编几个 crate。

use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use sha2::{Digest, Sha256};

use crate::signature_policy::{
    digests_equal, hex_decode, hex_encode, normalize_digest, normalize_key, normalize_signature,
};

pub(crate) fn sha256_hex(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hex_encode(&hasher.finalize())
}

/// 校验一个包：摘要 + 签名。
///
/// 返回的错误信息是给用户看的（会出现在界面的提示条上），所以要说清是
/// **哪一道**没过 —— "checksum mismatch" 和 "signature does not match"
/// 对用户意味着完全不同的两件事：前者多半是下载坏了，后者是有人在换包。
pub(crate) fn verify(
    bytes: &[u8],
    expected_digest: &str,
    signature: &str,
    public_key: &str,
) -> Result<(), String> {
    let digest = normalize_digest(expected_digest)
        .ok_or_else(|| "the catalogue entry has a malformed sha256".to_string())?;
    let signature = normalize_signature(signature)
        .ok_or_else(|| "the catalogue entry has a malformed signature".to_string())?;
    let public_key = normalize_key(public_key)
        .ok_or_else(|| "the catalogue entry has a malformed publisher key".to_string())?;

    let actual = sha256_hex(bytes);
    if !digests_equal(&digest, &actual) {
        return Err(format!(
            "package checksum mismatch (expected {digest}, got {actual}) — the download is corrupt or was replaced"
        ));
    }

    let key_bytes = hex_decode(&public_key)
        .and_then(|value| <[u8; 32]>::try_from(value.as_slice()).ok())
        .ok_or_else(|| "the publisher key is not 32 bytes".to_string())?;
    let signature_bytes = hex_decode(&signature)
        .and_then(|value| <[u8; 64]>::try_from(value.as_slice()).ok())
        .ok_or_else(|| "the signature is not 64 bytes".to_string())?;

    let key = VerifyingKey::from_bytes(&key_bytes)
        .map_err(|error| format!("the publisher key is not a valid ed25519 key: {error}"))?;
    let signature = Signature::from_bytes(&signature_bytes);

    key.verify(bytes, &signature)
        .map_err(|_| "package signature does not match the publisher key".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn digest_is_lowercase_hex() {
        let digest = sha256_hex(b"lattice");
        assert_eq!(digest.len(), 64);
        assert_eq!(digest, digest.to_ascii_lowercase());
        // 已知向量：sha256("abc")
        assert_eq!(
            sha256_hex(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    #[test]
    fn malformed_inputs_are_rejected_before_crypto() {
        let digest = sha256_hex(b"x");
        assert!(verify(b"x", "short", &"a".repeat(128), &"b".repeat(64)).is_err());
        assert!(verify(b"x", &digest, "short", &"b".repeat(64)).is_err());
        assert!(verify(b"x", &digest, &"a".repeat(128), "short").is_err());
    }

    #[test]
    fn checksum_mismatch_is_reported_as_such() {
        let error = verify(b"x", &sha256_hex(b"y"), &"a".repeat(128), &"b".repeat(64)).unwrap_err();
        assert!(error.contains("checksum mismatch"), "got {error}");
    }

    /// 一个固定的测试向量：私钥种子全 0 之外的值，签名是拿 Node 的
    /// `crypto.sign(null, ...)` 算出来的（打包脚本用的同一条路）。
    /// 这一条如果挂了，说明签名格式和脚本那边对不上了 —— 那是最贵的一种错。
    #[test]
    fn verifies_a_real_signature() {
        // 这组值由 Node 的 `crypto.sign(null, ...)` 算出来（打包脚本用的同一条路），
        // 种子是 `9d61b1…7f60`，所以内容固定、可以写死在这里
        let payload = b"lattice signature self test";
        let digest = sha256_hex(payload);
        let key = "d75a980182b10ab7d54bfed3c964073a0ee172f3daa62325af021a68f707511a";
        let signature = "9f9fcdb0cdc48c7acfd2e5a6da1db2337e2749ed8c0419e4fd5efe2ec15cddea43009a0326b7d839b66ca187544f9f7fb08a899c7132ab0a79d94ad41a46ac04";
        verify(payload, &digest, signature, key).expect("a known-good signature must verify");
        // 改一个字节就不行
        let mut tampered = payload.to_vec();
        tampered[0] ^= 1;
        assert!(verify(&tampered, &digest, signature, key).is_err());
    }
}
