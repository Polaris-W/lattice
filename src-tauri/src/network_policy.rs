//! 网络策略：URL 解析 + 主机白名单
//!
//! 单独拆出来，不碰 WinHTTP、不碰 tauri —— 这一层是"允不允许"，`network.rs`
//! 是"怎么发出去"。混在一起的话，本机 `cargo test` 跑不起来（安全策略不让
//! 往 `target/debug/deps` 写新的 exe），白名单这几条断言就只能靠肉眼。
//! 拆开之后 `.scratch/net-test.rs` 用 `rustc --test` 就能把它们真跑一遍。
//!
//! 纯函数、无 IO、无全局状态：给一组白名单和一个 URL，答案确定。

/// 允许的 HTTP 方法。组件要的是"取数据 / 提交数据"，不需要 TRACE / CONNECT
pub(crate) const ALLOWED_METHODS: [&str; 6] = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"];

/// 解析出来的目标
#[derive(Debug, PartialEq)]
pub(crate) struct Target {
    pub secure: bool,
    pub host: String,
    pub port: u16,
    /// 交给 WinHTTP 的请求目标：path + query
    pub path: String,
}

/// 拆 URL。手写而不是引 `url` crate：只要 http/https、只要 host/port/path，
/// 其余（userinfo、fragment）一律丢弃。
pub(crate) fn parse_url(url: &str) -> Result<Target, String> {
    let lower = url.to_ascii_lowercase();
    let secure = if lower.starts_with("https://") {
        true
    } else if lower.starts_with("http://") {
        false
    } else {
        return Err("only http:// and https:// URLs are allowed".to_string());
    };

    // 去掉 fragment（不发给服务器），再切 path
    let without_fragment = url.split('#').next().unwrap_or(url);
    let after_scheme = if secure {
        &without_fragment[8..]
    } else {
        &without_fragment[7..]
    };

    let (authority, path) = match after_scheme.find('/') {
        Some(index) => (&after_scheme[..index], &after_scheme[index..]),
        None => (after_scheme, "/"),
    };

    // userinfo（`user:pass@host`）不认：组件没有理由带账号密码，
    // 认了反而会把密码写进日志
    let authority = match authority.rsplit_once('@') {
        Some((_, host)) => host,
        None => authority,
    };

    let (host, port) = match authority.rsplit_once(':') {
        Some((host, port)) if port.chars().all(|c| c.is_ascii_digit()) && !port.is_empty() => {
            let port: u16 = port.parse().map_err(|_| "invalid port".to_string())?;
            (host, port)
        }
        _ => (authority, if secure { 443 } else { 80 }),
    };

    if host.is_empty() {
        return Err("the URL has no host".to_string());
    }
    if host
        .chars()
        .any(|c| c.is_whitespace() || c.is_control() || c == '/' || c == '\\')
    {
        return Err("the host contains illegal characters".to_string());
    }

    Ok(Target {
        secure,
        host: host.to_ascii_lowercase(),
        port,
        path: path.to_string(),
    })
}

/// 白名单条目匹配。
///
/// 两种写法：
///   - `example.com` —— 只匹配标准端口（http 80 / https 443）
///   - `example.com:8080` —— 只匹配这个端口
///
/// 不支持通配符。通配符一写，`*.example.com` 的边界问题（`evil.example.com.attacker.net`
/// 这类）就得靠人一遍遍想，而"多列一行"的成本几乎为零。
pub(crate) fn host_allowed(entries: &[String], target: &Target) -> bool {
    entries.iter().any(|entry| {
        let entry = entry.trim().to_ascii_lowercase();
        if entry.is_empty() {
            return false;
        }
        match entry.rsplit_once(':') {
            Some((host, port)) if port.chars().all(|c| c.is_ascii_digit()) && !port.is_empty() => {
                host == target.host && port.parse::<u16>().ok() == Some(target.port)
            }
            _ => entry == target.host && (target.port == 80 || target.port == 443),
        }
    })
}

/// 这次请求该按哪份白名单放行 —— 返回 `(用来打日志的组件 id, 主机白名单)`。
///
/// 两个来源，优先级是硬的：
///
/// 1. **窗口在注册表里**（桌面窗口）：用窗口创建时写进去的那份。这份和窗口
///    一起存在 Rust 侧，宿主页改不了，是这条链路上最结实的一段。
/// 2. **窗口不在注册表里**（主窗口的画布）：用宿主页随请求带过来的那份。
///
/// 为什么必须有第 2 条：画布上的实例不是一个窗口，它跑在主窗口的 iframe 里，
/// 注册表里没有它的条目。没有这条兜底时，同一个组件"桌面上能联网、设计器里
/// 不能"，而设计器恰好是用户第一次配置它的地方 —— 症状是刚加进来的天气组件
/// 报"连不上服务"，看上去像组件坏了。
///
/// 安全性没有因此变弱：组件只能 `postMessage` 一个 `{url}` 出来，白名单是
/// **宿主页**按清单填的，组件碰不到。而桌面那条路的 `network.hosts` 本来
/// 也是前端在 `sync_widget_windows` 里传进来的 —— 信任边界是同一个。
///
/// 反过来说，**注册表优先**这条别放宽：窗口已经在册还去信请求里那份，
/// 等于让一个前端 bug 悄悄扩大出网范围。
pub(crate) fn egress_for(
    registered: Option<(String, Vec<String>)>,
    declared: Option<Vec<String>>,
) -> Option<(String, Vec<String>)> {
    if let Some(found) = registered {
        return Some(found);
    }
    declared.map(|hosts| ("canvas".to_string(), hosts))
}

#[cfg(test)]
mod tests {
    use super::*;
    fn target(url: &str) -> Target {
        parse_url(url).expect("should parse")
    }

    #[test]
    fn parses_https_with_default_port() {
        let t = target("https://api.example.com/v1/things?q=1");
        assert!(t.secure);
        assert_eq!(t.host, "api.example.com");
        assert_eq!(t.port, 443);
        assert_eq!(t.path, "/v1/things?q=1");
    }

    #[test]
    fn parses_http_with_explicit_port() {
        let t = target("http://localhost:1420/widgets/x.json");
        assert!(!t.secure);
        assert_eq!(t.host, "localhost");
        assert_eq!(t.port, 1420);
        assert_eq!(t.path, "/widgets/x.json");
    }

    #[test]
    fn missing_path_becomes_slash() {
        assert_eq!(target("https://example.com").path, "/");
    }

    #[test]
    fn fragment_is_dropped() {
        assert_eq!(target("https://example.com/a#frag").path, "/a");
    }

    #[test]
    fn userinfo_is_dropped() {
        let t = target("https://user:secret@example.com/a");
        assert_eq!(t.host, "example.com");
    }

    #[test]
    fn other_schemes_are_rejected() {
        assert!(parse_url("file:///c:/windows/win.ini").is_err());
        assert!(parse_url("ftp://example.com/").is_err());
        assert!(parse_url("javascript:alert(1)").is_err());
        assert!(parse_url("example.com").is_err());
    }

    #[test]
    fn host_whitelist_requires_exact_match() {
        let list = vec!["example.com".to_string()];
        assert!(host_allowed(&list, &target("https://example.com/")));
        assert!(host_allowed(&list, &target("http://example.com/")));
        // 后缀骗不过去
        assert!(!host_allowed(&list, &target("https://example.com.evil.com/")));
        assert!(!host_allowed(&list, &target("https://sub.example.com/")));
        // 非标准端口要显式写出来
        assert!(!host_allowed(&list, &target("http://example.com:8080/")));
    }

    #[test]
    fn host_whitelist_can_pin_a_port() {
        let list = vec!["localhost:1420".to_string()];
        assert!(host_allowed(&list, &target("http://localhost:1420/x")));
        assert!(!host_allowed(&list, &target("http://localhost:1421/x")));
    }

    #[test]
    fn empty_entries_are_ignored() {
        let list = vec!["".to_string(), "   ".to_string()];
        assert!(!host_allowed(&list, &target("https://example.com/")));
    }

    #[test]
    fn a_registered_window_uses_its_own_list() {
        let registered = Some(("lattice.weather".to_string(), vec!["api.example.com".to_string()]));
        let declared = Some(vec!["evil.example.com".to_string()]);
        let picked = egress_for(registered, declared).expect("should resolve");
        assert_eq!(picked.0, "lattice.weather");
        // 在册的窗口，请求里带什么都不算数
        assert_eq!(picked.1, vec!["api.example.com".to_string()]);
    }

    #[test]
    fn an_unregistered_window_falls_back_to_the_declared_list() {
        let declared = Some(vec!["api.open-meteo.com".to_string()]);
        let picked = egress_for(None, declared).expect("should resolve");
        assert_eq!(picked.1, vec!["api.open-meteo.com".to_string()]);
    }

    #[test]
    fn neither_source_means_no_egress() {
        assert!(egress_for(None, None).is_none());
        // 空名单也是一份名单：能出网，但哪儿都去不了
        let picked = egress_for(None, Some(vec![])).expect("an empty list still resolves");
        assert!(picked.1.is_empty());
    }
}
