//! `.lattice` 包的解析：一个 ZIP 的中央目录 + 一条路径安全规则。
//!
//! # 为什么要自己读 ZIP
//!
//! 只做一件事：把一个包里的文件取出来。`zip` crate 会带进来一整套依赖图
//! （还有它自己的 unsafe），而这里要的只是"读中央目录 + 认两种压缩方法"。
//! 和 `metrics.rs` 手搓 Win32 采样、`autostart.rs` 直调注册表是同一条理由。
//!
//! 真正解压那一步在 `package.rs`（要 `flate2`）；这个文件只处理**字节布局**，
//! 所以不依赖任何 crate，能用 `rustc --test` 单独跑单测。
//!
//! # 以中央目录为准，不信本地头
//!
//! 本地文件头里的 `compressed_size` / `crc` 在"边写边压"的包里是 0，真正的值
//! 在数据后面的 data descriptor 里，靠 `flags & 0x08` 标记。中央目录永远有
//! 完整值 —— 所以所有长度都从中央目录取，本地头只用来算数据起点。
//! 这样流式写出来的包（很多工具都是）也能读。
//!
//! # 路径安全
//!
//! 包是**第三方内容**。`../../AppData/Roaming/Microsoft/Windows/Start Menu/...`
//! 这种名字写进一个 ZIP 里完全合法，解压时不挡就会写到组件目录外面去 ——
//! 这是 ZIP 最老的一类漏洞（zip slip）。`safe_relative_path` 是唯一的入口，
//! 而且**只认 `/`**：反斜杠直接拒，不做"帮忙转一下"的善意，因为
//! `..\..\x` 和 `../..` 在 Windows 上是同一个意思，转来转去只会漏。

/// 一条中央目录记录里我们需要的字段。
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Entry {
    /// 包内相对路径，`/` 分隔，已通过 `safe_relative_path` 校验
    pub name: String,
    /// 0 = 存储（不压缩），8 = deflate
    pub method: u16,
    pub compressed_size: usize,
    pub uncompressed_size: usize,
    pub crc32: u32,
    /// 本地文件头在包里的偏移
    pub local_offset: usize,
}

/// 单个文件的解压上限。组件都是几十 KB 的 HTML/CSS/JS，8MB 已经很宽松了。
pub(crate) const MAX_ENTRY_BYTES: usize = 8 * 1024 * 1024;
/// 整个包解开之后的上限。挡住"1KB 的包解出 10GB"这类压缩炸弹。
pub(crate) const MAX_TOTAL_BYTES: usize = 64 * 1024 * 1024;
/// 文件数上限。正常的组件包是个位数。
pub(crate) const MAX_ENTRIES: usize = 500;

const EOCD_SIG: u32 = 0x0605_4b50;
const CENTRAL_SIG: u32 = 0x0201_4b50;
/// EOCD 后面最多跟 65535 字节注释，所以从尾部往回找这么多就够
const EOCD_SEARCH: usize = 66_000;

fn u16_at(bytes: &[u8], at: usize) -> Option<u16> {
    bytes.get(at..at + 2).map(|slice| u16::from_le_bytes([slice[0], slice[1]]))
}

fn u32_at(bytes: &[u8], at: usize) -> Option<u32> {
    bytes
        .get(at..at + 4)
        .map(|slice| u32::from_le_bytes([slice[0], slice[1], slice[2], slice[3]]))
}

/// 包内路径 → 安全的相对路径片段。
///
/// 返回 `None` 表示"这个条目不能写"。规则：
/// - 必须是相对路径：不许以 `/` 开头、不许带盘符、不许出现 `\`
/// - 不许出现 `..` 段（zip slip）
/// - 空名字、`.` 段、NUL 字符一律拒
///
/// 目录条目（结尾是 `/`）也会被拒 —— 调用方按"条目名"建目录，不需要单独的
/// 目录记录，而留一个空目录条目只会让上限算得莫名其妙。
pub(crate) fn safe_relative_path(name: &str) -> Option<Vec<String>> {
    if name.is_empty() || name.len() > 512 {
        return None;
    }
    if name.contains('\\') || name.contains('\0') {
        return None;
    }
    if name.starts_with('/') {
        return None;
    }
    // 盘符（`C:`）和任何带冒号的名字都拒：Windows 上 `a:b` 是 NTFS 流
    if name.contains(':') {
        return None;
    }
    if name.ends_with('/') {
        return None;
    }

    let mut parts = Vec::new();
    for part in name.split('/') {
        if part.is_empty() || part == "." {
            return None;
        }
        if part == ".." {
            return None;
        }
        parts.push(part.to_string());
    }
    Some(parts)
}

/// 把包内路径接到根目录上，返回最终落盘路径。
///
/// `safe_relative_path` 已经挡过 `..` / 绝对路径 / 盘符，这里再挡一次是
/// **故意的**：这个函数是真正决定"写到哪儿"的地方，多一层判断的成本是零，
/// 而漏一次就是写到组件目录外面去。
pub(crate) fn join_inside(root: &std::path::Path, name: &str) -> Result<std::path::PathBuf, String> {
    let mut path = root.to_path_buf();
    for part in name.split('/') {
        if part.is_empty() || part == "." || part == ".." || part.contains(':') || part.contains('\\') {
            return Err(format!("unsafe path in the package: \"{name}\""));
        }
        path.push(part);
    }
    Ok(path)
}

/// 读中央目录。`archive` 是整个包的字节。
pub(crate) fn read_entries(archive: &[u8]) -> Result<Vec<Entry>, String> {
    let eocd = find_eocd(archive).ok_or_else(|| "this file is not a .lattice package (no ZIP end record)".to_string())?;

    let count = u16_at(archive, eocd + 10).ok_or("truncated ZIP end record")? as usize;
    let directory_offset = u32_at(archive, eocd + 16).ok_or("truncated ZIP end record")? as usize;

    if count == 0 {
        return Err("the package is empty".to_string());
    }
    if count > MAX_ENTRIES {
        return Err(format!("the package has too many files ({count}, max {MAX_ENTRIES})"));
    }

    let mut entries = Vec::new();
    let mut cursor = directory_offset;
    let mut total = 0usize;

    for _ in 0..count {
        if u32_at(archive, cursor) != Some(CENTRAL_SIG) {
            return Err("the package directory is malformed".to_string());
        }
        let method = u16_at(archive, cursor + 10).ok_or("truncated directory entry")?;
        let crc32 = u32_at(archive, cursor + 16).ok_or("truncated directory entry")?;
        let compressed_size = u32_at(archive, cursor + 20).ok_or("truncated directory entry")? as usize;
        let uncompressed_size = u32_at(archive, cursor + 24).ok_or("truncated directory entry")? as usize;
        let name_len = u16_at(archive, cursor + 28).ok_or("truncated directory entry")? as usize;
        let extra_len = u16_at(archive, cursor + 30).ok_or("truncated directory entry")? as usize;
        let comment_len = u16_at(archive, cursor + 32).ok_or("truncated directory entry")? as usize;
        let local_offset = u32_at(archive, cursor + 42).ok_or("truncated directory entry")? as usize;

        let name_bytes = archive
            .get(cursor + 46..cursor + 46 + name_len)
            .ok_or("truncated directory entry")?;
        let name = String::from_utf8_lossy(name_bytes).to_string();

        if method != 0 && method != 8 {
            return Err(format!("unsupported compression method {method} in \"{name}\""));
        }
        if uncompressed_size > MAX_ENTRY_BYTES {
            return Err(format!("\"{name}\" is too large ({uncompressed_size} bytes, max {MAX_ENTRY_BYTES})"));
        }
        total += uncompressed_size;
        if total > MAX_TOTAL_BYTES {
            return Err(format!("the package expands to more than {MAX_TOTAL_BYTES} bytes"));
        }

        // 目录条目：跳过。包里不需要它，文件会按自己的路径建目录
        if !name.ends_with('/') {
            let safe = safe_relative_path(&name).ok_or_else(|| format!("unsafe path in the package: \"{name}\""))?;
            entries.push(Entry {
                name: safe.join("/"),
                method,
                compressed_size,
                uncompressed_size,
                crc32,
                local_offset,
            });
        }

        cursor += 46 + name_len + extra_len + comment_len;
    }

    if entries.is_empty() {
        return Err("the package contains no files".to_string());
    }
    if !entries.iter().any(|entry| entry.name == "manifest.json") {
        return Err("the package has no manifest.json at its root".to_string());
    }

    Ok(entries)
}

fn find_eocd(archive: &[u8]) -> Option<usize> {
    if archive.len() < 22 {
        return None;
    }
    let start = archive.len().saturating_sub(EOCD_SEARCH);
    let mut at = archive.len() - 22;
    loop {
        if u32_at(archive, at) == Some(EOCD_SIG) {
            return Some(at);
        }
        if at == start {
            return None;
        }
        at -= 1;
    }
}

/// 一条条目的数据在包里的切片。
pub(crate) fn data_range(archive: &[u8], entry: &Entry) -> Result<(usize, usize), String> {
    const LOCAL_SIG: u32 = 0x0403_4b50;
    if u32_at(archive, entry.local_offset) != Some(LOCAL_SIG) {
        return Err(format!("\"{}\" has a broken local header", entry.name));
    }
    let name_len = u16_at(archive, entry.local_offset + 26).ok_or("truncated local header")? as usize;
    let extra_len = u16_at(archive, entry.local_offset + 28).ok_or("truncated local header")? as usize;
    let start = entry.local_offset + 30 + name_len + extra_len;
    let end = start + entry.compressed_size;
    if end > archive.len() {
        return Err(format!("\"{}\" is truncated", entry.name));
    }
    Ok((start, end))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 拼一个最小可用的包：一条存储（不压缩）条目 + 中央目录 + EOCD。
    /// 解压那半边在 `package.rs`，这里只验字节布局的读法。
    fn build_zip(files: &[(&str, &[u8])]) -> Vec<u8> {
        let mut out = Vec::new();
        let mut directory = Vec::new();

        for (name, body) in files {
            let offset = out.len();
            out.extend_from_slice(&0x0403_4b50u32.to_le_bytes());
            out.extend_from_slice(&20u16.to_le_bytes());
            out.extend_from_slice(&0x0800u16.to_le_bytes()); // UTF-8 名字
            out.extend_from_slice(&0u16.to_le_bytes()); // method 0 = 存储
            out.extend_from_slice(&0u16.to_le_bytes()); // 时间
            out.extend_from_slice(&0u16.to_le_bytes()); // 日期
            out.extend_from_slice(&0u32.to_le_bytes()); // crc（这里不校验）
            out.extend_from_slice(&(body.len() as u32).to_le_bytes());
            out.extend_from_slice(&(body.len() as u32).to_le_bytes());
            out.extend_from_slice(&(name.len() as u16).to_le_bytes());
            out.extend_from_slice(&0u16.to_le_bytes());
            out.extend_from_slice(name.as_bytes());
            out.extend_from_slice(body);

            directory.extend_from_slice(&0x0201_4b50u32.to_le_bytes());
            directory.extend_from_slice(&20u16.to_le_bytes());
            directory.extend_from_slice(&20u16.to_le_bytes());
            directory.extend_from_slice(&0x0800u16.to_le_bytes());
            directory.extend_from_slice(&0u16.to_le_bytes());
            directory.extend_from_slice(&0u16.to_le_bytes());
            directory.extend_from_slice(&0u16.to_le_bytes());
            directory.extend_from_slice(&0u32.to_le_bytes());
            directory.extend_from_slice(&(body.len() as u32).to_le_bytes());
            directory.extend_from_slice(&(body.len() as u32).to_le_bytes());
            directory.extend_from_slice(&(name.len() as u16).to_le_bytes());
            directory.extend_from_slice(&0u16.to_le_bytes()); // extra
            directory.extend_from_slice(&0u16.to_le_bytes()); // comment
            directory.extend_from_slice(&0u16.to_le_bytes()); // disk
            directory.extend_from_slice(&0u16.to_le_bytes()); // internal
            directory.extend_from_slice(&0u32.to_le_bytes()); // external
            directory.extend_from_slice(&(offset as u32).to_le_bytes());
            directory.extend_from_slice(name.as_bytes());
        }

        let directory_offset = out.len();
        let directory_size = directory.len();
        out.extend_from_slice(&directory);

        out.extend_from_slice(&0x0605_4b50u32.to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes());
        out.extend_from_slice(&(files.len() as u16).to_le_bytes());
        out.extend_from_slice(&(files.len() as u16).to_le_bytes());
        out.extend_from_slice(&(directory_size as u32).to_le_bytes());
        out.extend_from_slice(&(directory_offset as u32).to_le_bytes());
        out.extend_from_slice(&0u16.to_le_bytes());
        out
    }

    #[test]
    fn reads_entries_and_their_data() {
        let archive = build_zip(&[("manifest.json", b"{}"), ("widget.js", b"console.log(1)")]);
        let entries = read_entries(&archive).unwrap();
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].name, "manifest.json");
        assert_eq!(entries[1].name, "widget.js");

        let (start, end) = data_range(&archive, &entries[1]).unwrap();
        assert_eq!(&archive[start..end], b"console.log(1)");
    }

    #[test]
    fn rejects_a_package_without_manifest() {
        let archive = build_zip(&[("widget.js", b"x")]);
        let error = read_entries(&archive).unwrap_err();
        assert!(error.contains("manifest.json"), "{error}");
    }

    #[test]
    fn rejects_something_that_is_not_a_zip() {
        assert!(read_entries(b"just text").is_err());
        assert!(read_entries(b"").is_err());
    }

    #[test]
    fn rejects_path_traversal() {
        let archive = build_zip(&[("manifest.json", b"{}"), ("../../evil.js", b"x")]);
        let error = read_entries(&archive).unwrap_err();
        assert!(error.contains("unsafe path"), "{error}");
    }

    #[test]
    fn accepts_nested_paths() {
        let archive = build_zip(&[("manifest.json", b"{}"), ("assets/icon.svg", b"<svg/>")]);
        let entries = read_entries(&archive).unwrap();
        assert_eq!(entries[1].name, "assets/icon.svg");
    }

    #[test]
    fn skips_directory_entries() {
        let archive = build_zip(&[("manifest.json", b"{}"), ("assets/", b"")]);
        let entries = read_entries(&archive).unwrap();
        assert_eq!(entries.len(), 1);
    }

    // ---- 路径规则本身 ----

    #[test]
    fn safe_paths_pass() {
        assert_eq!(safe_relative_path("index.html"), Some(vec!["index.html".to_string()]));
        assert_eq!(
            safe_relative_path("assets/icons/a.svg"),
            Some(vec!["assets".to_string(), "icons".to_string(), "a.svg".to_string()])
        );
    }

    #[test]
    fn traversal_and_absolute_paths_are_rejected() {
        for name in ["../x", "a/../../b", "/etc/passwd", "C:/Windows/x", "a\\b", "a//b", "./x", "", "a:b"] {
            assert_eq!(safe_relative_path(name), None, "应该拒绝 {name:?}");
        }
    }

    #[test]
    fn joins_nested_names_under_the_root() {
        let root = std::path::Path::new("C:/tmp/widget");
        assert_eq!(
            join_inside(root, "assets/icon.svg").unwrap(),
            root.join("assets").join("icon.svg")
        );
    }

    #[test]
    fn refuses_to_escape_the_root() {
        let root = std::path::Path::new("C:/tmp/widget");
        for name in ["../x", "a/../../b", "a:b", "a\\b", ""] {
            assert!(join_inside(root, name).is_err(), "应该拒绝 {name:?}");
        }
    }

    #[test]
    fn rejects_oversized_entries() {
        // 声称解开有 9MB，但实际没那么多 —— 只看中央目录里的数字就该挡住。
        // 中央目录里 uncompressed_size 在条目开头 +24（见文件头那张布局注释）
        let mut archive = build_zip(&[("manifest.json", b"{}")]);
        let eocd = find_eocd(&archive).unwrap();
        let directory_offset = u32_at(&archive, eocd + 16).unwrap() as usize;
        let at = directory_offset + 24;
        archive[at..at + 4].copy_from_slice(&(9u32 * 1024 * 1024).to_le_bytes());
        let error = read_entries(&archive).unwrap_err();
        assert!(error.contains("too large"), "{error}");
    }
}
