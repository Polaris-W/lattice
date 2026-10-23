//! 十六进制、摘要比较、base64 —— 签名校验里"不碰密码学"的那一半。
//!
//! 这个文件**不依赖任何 crate**，所以能用 `rustc --test` 单独跑（见 AGENTS §11）。
//! 真正的 ed25519 校验在 `signature.rs` 里 —— 那里必须靠 `ed25519-dalek`，
//! 而"hex 解码有没有处理奇数长度""比较是不是短路的"这类边界，用不着等 CI 也能验。
//!
//! # 为什么比较要写成一个函数
//!
//! 摘要比较用 `==` 也没错（sha256 不是秘密，不存在"靠时间侧信道猜出原文"的现实
//! 威胁），但"长度不同直接返回 false、长度相同才逐字节比"这件事容易被写成
//! `a == b` 之后被下一个人改来改去。收在一个函数里，顺便把"大小写"也吃掉：
//! 目录里写大写 hex 是很容易发生的事，不该因此判成"包被改过"。

/// 解码十六进制。长度必须是偶数，字符必须是 0-9a-fA-F。
pub(crate) fn hex_decode(text: &str) -> Option<Vec<u8>> {
    let bytes = text.as_bytes();
    if bytes.len() % 2 != 0 {
        return None;
    }
    let mut out = Vec::with_capacity(bytes.len() / 2);
    for pair in bytes.chunks(2) {
        let high = hex_value(pair[0])?;
        let low = hex_value(pair[1])?;
        out.push((high << 4) | low);
    }
    Some(out)
}

fn hex_value(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

pub(crate) fn hex_encode(bytes: &[u8]) -> String {
    const DIGITS: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push(DIGITS[(byte >> 4) as usize] as char);
        out.push(DIGITS[(byte & 0x0f) as usize] as char);
    }
    out
}

/// 归一化成"小写 + 指定长度的 hex"。形状不对返回 None —— 调用方必须当成失败。
fn normalize(text: &str, length: usize) -> Option<String> {
    let trimmed = text.trim();
    if trimmed.len() != length || !trimmed.bytes().all(|byte| hex_value(byte).is_some()) {
        return None;
    }
    Some(trimmed.to_ascii_lowercase())
}

/// sha256 摘要：64 个 hex 字符
pub(crate) fn normalize_digest(text: &str) -> Option<String> {
    normalize(text, 64)
}

/// ed25519 签名：128 个 hex 字符（64 字节）
pub(crate) fn normalize_signature(text: &str) -> Option<String> {
    normalize(text, 128)
}

/// ed25519 公钥：64 个 hex 字符（32 字节）
pub(crate) fn normalize_key(text: &str) -> Option<String> {
    normalize(text, 64)
}

/// 摘要是否相同。大小写不敏感；长度不同立刻 false。
pub(crate) fn digests_equal(expected: &str, actual: &str) -> bool {
    let left = expected.trim().to_ascii_lowercase();
    let right = actual.trim().to_ascii_lowercase();
    if left.len() != right.len() || left.is_empty() {
        return false;
    }
    let mut diff = 0u8;
    for (a, b) in left.bytes().zip(right.bytes()) {
        diff |= a ^ b;
    }
    diff == 0
}

/// 公钥指纹，给日志和界面用：前 16 位、四段一组。
///
/// 只用于"人对一眼"，**不是**校验 —— 校验永远比完整的 64 位。
pub(crate) fn key_fingerprint(key: &str) -> String {
    let clean: String = key
        .chars()
        .filter(|c| c.is_ascii_hexdigit())
        .take(16)
        .collect::<String>()
        .to_ascii_lowercase();
    if clean.len() < 16 {
        return key.to_string();
    }
    let mut out = String::with_capacity(19);
    for (index, chunk) in clean.as_bytes().chunks(4).enumerate() {
        if index > 0 {
            out.push(' ');
        }
        out.push_str(std::str::from_utf8(chunk).unwrap_or(""));
    }
    out
}

/// base64 解码（标准字母表，容忍空白与缺失的 `=` 填充）。
///
/// 内置组件的 `.lattice` 包在前端资源里，前端取到的是 `Uint8Array`，
/// 走 IPC 传字节最省事的办法是 base64 —— 一个 10KB 的包变成 14KB 字符串，
/// 比 JSON 数组（每个字节 1-4 个字符）小得多。为这一个用途引一个 crate 不值得。
pub(crate) fn base64_decode(text: &str) -> Result<Vec<u8>, String> {
    let mut out = Vec::with_capacity(text.len() / 4 * 3);
    let mut buffer: u32 = 0;
    let mut bits = 0u32;

    for byte in text.bytes() {
        let value = match byte {
            b'A'..=b'Z' => byte - b'A',
            b'a'..=b'z' => byte - b'a' + 26,
            b'0'..=b'9' => byte - b'0' + 52,
            b'+' => 62,
            b'/' => 63,
            b'=' => break,
            b' ' | b'\n' | b'\r' | b'\t' => continue,
            other => return Err(format!("unexpected character in base64 payload: {}", other as char)),
        };
        buffer = (buffer << 6) | value as u32;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((buffer >> bits) as u8);
        }
    }
    Ok(out)
}

#[allow(dead_code)] // 只在单测里用来造 roundtrip 向量（运行时只需要解码）
pub(crate) fn base64_encode(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = *chunk.get(1).unwrap_or(&0) as u32;
        let b2 = *chunk.get(2).unwrap_or(&0) as u32;
        let triple = (b0 << 16) | (b1 << 8) | b2;
        out.push(ALPHABET[((triple >> 18) & 0x3f) as usize] as char);
        out.push(ALPHABET[((triple >> 12) & 0x3f) as usize] as char);
        out.push(if chunk.len() > 1 {
            ALPHABET[((triple >> 6) & 0x3f) as usize] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            ALPHABET[(triple & 0x3f) as usize] as char
        } else {
            '='
        });
    }
    out
}

/// 组件 id 能不能直接当文件名用（报告文件、备份目录）。
/// 和清单里的 id 规则一致，但这里**只**关心"不能有路径分隔符"。
pub(crate) fn safe_id(id: &str) -> Option<&str> {
    if id.is_empty() || id.len() > 128 {
        return None;
    }
    if id
        .chars()
        .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '.' || c == '-')
    {
        Some(id)
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hex_roundtrip() {
        let bytes = vec![0x00, 0x0f, 0xff, 0x5a];
        let text = hex_encode(&bytes);
        assert_eq!(text, "000fff5a");
        assert_eq!(hex_decode(&text).unwrap(), bytes);
    }

    #[test]
    fn hex_rejects_odd_and_garbage() {
        assert!(hex_decode("abc").is_none());
        assert!(hex_decode("zz").is_none());
        assert!(hex_decode("").is_some());
    }

    #[test]
    fn shapes_are_enforced() {
        assert!(normalize_digest(&"A".repeat(64)).is_some());
        assert_eq!(normalize_digest(&"A".repeat(64)).unwrap(), "a".repeat(64));
        assert!(normalize_digest(&"a".repeat(63)).is_none());
        assert!(normalize_signature(&"b".repeat(128)).is_some());
        assert!(normalize_signature(&"b".repeat(127)).is_none());
        assert!(normalize_key(&"c".repeat(64)).is_some());
        assert!(normalize_key("").is_none());
    }

    #[test]
    fn digests_compare_case_insensitively() {
        assert!(digests_equal(&"a".repeat(64), &"A".repeat(64)));
        assert!(!digests_equal(&"a".repeat(64), &"b".repeat(64)));
        assert!(!digests_equal(&"a".repeat(64), &"a".repeat(63)));
        assert!(!digests_equal("", ""));
    }

    #[test]
    fn fingerprint_is_readable() {
        assert_eq!(key_fingerprint(&"1".repeat(64)), "1111 1111 1111 1111");
        assert_eq!(key_fingerprint("abc"), "abc");
    }

    #[test]
    fn base64_roundtrip() {
        for payload in [b"".to_vec(), b"f".to_vec(), b"fo".to_vec(), b"foo".to_vec(), (0u8..=255).collect()] {
            let encoded = base64_encode(&payload);
            assert_eq!(base64_decode(&encoded).unwrap(), payload);
        }
    }

    #[test]
    fn base64_tolerates_padding_and_whitespace() {
        assert_eq!(base64_decode("Zm9v").unwrap(), b"foo".to_vec());
        assert_eq!(base64_decode("Zm9v\n").unwrap(), b"foo".to_vec());
        assert_eq!(base64_decode("Zm8=").unwrap(), b"fo".to_vec());
        // 少了填充也要能解
        assert_eq!(base64_decode("Zm8").unwrap(), b"fo".to_vec());
        assert!(base64_decode("Zm9v*").is_err());
    }

    #[test]
    fn ids_are_checked_before_becoming_file_names() {
        assert_eq!(safe_id("lattice.clock"), Some("lattice.clock"));
        assert!(safe_id("../evil").is_none());
        assert!(safe_id("Lattice.Clock").is_none());
        assert!(safe_id("").is_none());
    }
}
