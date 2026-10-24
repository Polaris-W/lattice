//! 目录缓存的纯逻辑：文件名、编解码、ETag 挑拣、失败文案。
//!
//! # 为什么要有缓存
//!
//! 目录是一份放在公网上的 `registry.json`。断网、DNS 挂了、Pages 抽风的时候，
//! 商店会**整个变空白** —— 用户看到的是"应用坏了"，而不是"网断了"。
//! 这两件事在界面上必须能分开说，而分开说的前提是"手上还有一份旧的"。
//!
//! 所以每次成功取到目录都留一份到磁盘，取不到时拿它顶上，并在界面上写明
//! "这是 X 时间之前那份"。**缓存不是真相**：它只影响"显示什么"，
//! 安装时的摘要和签名照样现算（见 `store.rs`），缓存被改过一样拦得住。
//!
//! # 为什么单独一个模块
//!
//! `store.rs` 里每个函数都要 `AppHandle`，跑不了单测。这里只做"字节进、字节出"
//! 的判断，测试见文末 —— 和 `package_policy` / `network_policy` 同一个理由。

use std::collections::BTreeMap;

/// 缓存文件的 schema。改了编码方式就抬它：旧文件读不出来会当成"没有缓存"，
/// 比"读出来一半"好
pub(crate) const CACHE_SCHEMA: u32 = 1;

/// 缓存文件的上限。目录本体上限 2MB，缓存里还要装一份 JSON 转义后的副本，
/// 留 3MB 够用；超过就当这个文件坏了，不读
pub(crate) const MAX_CACHE_BYTES: usize = 3 * 1024 * 1024;

/// 一个缓存条目
#[derive(Debug, PartialEq)]
pub(crate) struct CachedCatalogue {
    /// 这份缓存对应的目录地址（解码时核对，防止换了地址还用旧缓存）
    pub url: String,
    /// 取到这份文本的时刻（unix 秒）。stale 时界面显示的就是它
    pub at: u64,
    /// 服务器给的 ETag，有就带回去做条件请求（304 省一次全量下载）
    pub etag: Option<String>,
    pub text: String,
}

/// 文件名取 URL 的 FNV-1a 64 位哈希。
///
/// 不直接用 URL 当文件名：`https://a.b/c?d=e` 里的 `:` `?` 在 Windows 上
/// 要么非法、要么会被当成分区/流。
///
/// **这里故意不用 sha256**：文件名不是安全边界（内容对不上就作废，见 `decode`），
/// 用密码学摘要反而会让人以为"这个文件名值得信任"。FNV 八行、无依赖，
/// 也让这个模块能单独用 `rustc --test` 跑起来（这台机器上 `cargo test`
/// 跑不了，见 AGENTS §11）。
fn fnv1a64(bytes: &[u8]) -> u64 {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in bytes {
        hash ^= *byte as u64;
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    hash
}

pub(crate) fn cache_file_name(url: &str) -> String {
    format!("{:016x}.json", fnv1a64(url.as_bytes()))
}

/// 编码成要落盘的一行 JSON。超上限就返回 `None` —— 宁可没有缓存，
/// 也不要写一个下次读不出来的文件
pub(crate) fn encode(cache: &CachedCatalogue) -> Option<String> {
    if cache.text.len() > MAX_CACHE_BYTES {
        return None;
    }
    let value = serde_json::json!({
        "schema": CACHE_SCHEMA,
        "url": cache.url,
        "at": cache.at,
        "etag": cache.etag,
        "text": cache.text,
    });
    serde_json::to_string(&value).ok()
}

/// 解码。
///
/// **任何一条不对都当"没有缓存"**：缓存是加速，不是真相。读坏一个字段的后果
/// 不该是界面上一堆奇怪的报错，而应该是"照常走网络"。
pub(crate) fn decode(raw: &str, expected_url: &str) -> Option<CachedCatalogue> {
    if raw.len() > MAX_CACHE_BYTES + 64 * 1024 {
        return None;
    }
    let value: serde_json::Value = serde_json::from_str(raw).ok()?;
    if value.get("schema")?.as_u64()? != CACHE_SCHEMA as u64 {
        return None;
    }
    let url = value.get("url")?.as_str()?.to_string();
    // 地址对不上就作废：用户把目录从 A 改成 B，A 的旧内容不能拿来顶 B
    if url != expected_url {
        return None;
    }
    let at = value.get("at")?.as_u64()?;
    let text = value.get("text")?.as_str()?.to_string();
    if text.is_empty() || text.len() > MAX_CACHE_BYTES {
        return None;
    }
    let etag = value
        .get("etag")
        .and_then(|item| item.as_str())
        .and_then(sanitize_etag);
    Some(CachedCatalogue { url, at, etag, text })
}

/// ETag 只接受"能安全放回请求头"的形状。
///
/// 这个值来自服务器的响应头，而我们下一轮会把它原样塞回请求头 —— 带 `\r\n`
/// 的值等于让服务器决定我们发什么请求。128 字符也足够任何真实 ETag 了
pub(crate) fn sanitize_etag(raw: &str) -> Option<String> {
    let value = raw.trim();
    if value.is_empty() || value.len() > 128 {
        return None;
    }
    if value.chars().any(|c| c == '\r' || c == '\n' || c == '\0') {
        return None;
    }
    Some(value.to_string())
}

/// 从响应头里挑 ETag。`network::read_headers` 已经把名字转小写了
pub(crate) fn etag_from(headers: &BTreeMap<String, String>) -> Option<String> {
    sanitize_etag(headers.get("etag")?)
}

/// 失败文案。区分 404 / 429 / 5xx 是因为这三种"用户下一步该做什么"完全不同：
/// 改地址、等一会儿、还是换个源
pub(crate) fn failure_message(status: u16) -> String {
    match status {
        401 | 403 => format!("the catalogue server refused the request ({status})"),
        404 => "the catalogue is not there (404) — check the address".to_string(),
        429 => "the catalogue server is rate limiting (429) — try again later".to_string(),
        500..=599 => format!("the catalogue server had a problem ({status})"),
        other => format!("the catalogue server answered {other}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> CachedCatalogue {
        CachedCatalogue {
            url: "https://example.com/registry.json".to_string(),
            at: 1_700_000_000,
            etag: Some("W/\"abc123\"".to_string()),
            text: "{\"schema\":1,\"widgets\":[]}".to_string(),
        }
    }

    #[test]
    fn roundtrip_keeps_every_field() {
        let cache = sample();
        let raw = encode(&cache).expect("should encode");
        assert_eq!(decode(&raw, &cache.url), Some(cache));
    }

    #[test]
    fn a_cache_from_another_address_is_ignored() {
        // 换了目录地址还拿旧内容顶上，等于把 A 的包当成 B 的目录
        let raw = encode(&sample()).expect("should encode");
        assert_eq!(decode(&raw, "https://other.example/registry.json"), None);
    }

    #[test]
    fn unknown_schema_is_ignored() {
        let raw = "{\"schema\":99,\"url\":\"https://example.com/registry.json\",\"at\":1,\"text\":\"{}\"}";
        assert_eq!(decode(raw, "https://example.com/registry.json"), None);
    }

    #[test]
    fn broken_json_is_ignored() {
        assert_eq!(decode("not json at all", "https://example.com/registry.json"), None);
        assert_eq!(decode("{\"schema\":1}", "https://example.com/registry.json"), None);
    }

    #[test]
    fn empty_text_is_not_a_cache_hit() {
        // 空文本会让界面显示"目录是空的"，比没有缓存更误导
        let raw = "{\"schema\":1,\"url\":\"https://example.com/registry.json\",\"at\":1,\"text\":\"\"}";
        assert_eq!(decode(raw, "https://example.com/registry.json"), None);
    }

    #[test]
    fn etag_with_newlines_is_dropped() {
        assert_eq!(sanitize_etag("W/\"a\"\r\nX-Evil: 1"), None);
        assert_eq!(sanitize_etag("  "), None);
        assert_eq!(sanitize_etag("W/\"a\""), Some("W/\"a\"".to_string()));
    }

    #[test]
    fn etag_is_read_case_insensitively() {
        let mut headers = BTreeMap::new();
        headers.insert("etag".to_string(), "\"v1\"".to_string());
        assert_eq!(etag_from(&headers), Some("\"v1\"".to_string()));
        assert_eq!(etag_from(&BTreeMap::new()), None);
    }

    #[test]
    fn file_names_are_ascii_and_stable() {
        let one = cache_file_name("https://example.com/a/registry.json?x=1");
        let two = cache_file_name("https://example.com/a/registry.json?x=1");
        let three = cache_file_name("https://example.com/a/registry.json?x=2");
        assert_eq!(one, two);
        assert_ne!(one, three);
        assert_eq!(one.len(), 21); // 16 hex + ".json"
        let stem = one.trim_end_matches(".json");
        assert_eq!(stem.len(), 16);
        assert!(stem.chars().all(|c| c.is_ascii_hexdigit()));
    }

    #[test]
    fn failure_messages_say_what_to_do() {
        assert!(failure_message(404).contains("check the address"));
        assert!(failure_message(429).contains("try again later"));
        assert!(failure_message(503).contains("503"));
        assert!(failure_message(403).contains("refused"));
    }
}
