//! 目录监听的纯逻辑：把 `ReadDirectoryChangesW` 那一坨二进制记录读成路径列表。
//!
//! # 为什么单独拆一个文件
//!
//! `watch.rs` 里满是 `tauri::AppHandle`、`Sender`、Win32 句柄，`cargo test`
//! 在这台机器上又跑不起来（安全策略拦 `target/debug/deps` 下新写的 exe）。
//! 把"读缓冲区"这一步拆出来，它就不依赖任何东西了，可以用 `rustc --test`
//! 单独编一遍跑 —— 断言只有这一份，不复制。
//!
//! # 缓冲区的形状
//!
//! 每次通知是变长记录串起来的一串，每条前面 12 字节头：
//!
//! ```text
//! 0..4   NextEntryOffset   到下一条的字节偏移，0 表示这是最后一条
//! 4..8   Action            FILE_ACTION_ADDED / MODIFIED / REMOVED / RENAMED_*
//! 8..12  FileNameLength    文件名的**字节数**（不是字符数，名字是 UTF-16）
//! 12..   文件名本体，UTF-16LE，不带结尾的 0
//! ```
//!
//! 三个容易踩的地方都在下面钉着：偏移按字节算、名字按 UTF-16 解、
//! 截断的缓冲区不能 panic（系统给的缓冲区满的时候最后一条可能是半截）。

/// 记录头：NextEntryOffset(4) + Action(4) + FileNameLength(4)
const HEADER: usize = 12;

/// 把一次通知的原始缓冲区读成"变了哪些文件"，相对路径、分隔符统一成 `/`。
///
/// `Action` 有意忽略：对上层来说"新增 / 改名 / 删除 / 写入"都是同一件事 ——
/// 这份文件不一样了，重载。删掉文件之后重载只会让组件报一个可读的
/// `File not found`，比按 Action 分流再漏掉一种情况要好。
pub(crate) fn parse_notifications(buffer: &[u8]) -> Vec<String> {
    let mut out = Vec::new();
    let mut offset = 0usize;

    while offset + HEADER <= buffer.len() {
        let head = &buffer[offset..offset + HEADER];
        let next = u32::from_le_bytes([head[0], head[1], head[2], head[3]]) as usize;
        let name_bytes = u32::from_le_bytes([head[8], head[9], head[10], head[11]]) as usize;

        let name_start = offset + HEADER;
        if name_start + name_bytes > buffer.len() {
            break;
        }
        let units: Vec<u16> = buffer[name_start..name_start + name_bytes]
            .chunks_exact(2)
            .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
            .collect();
        let name = String::from_utf16_lossy(&units).replace('\\', "/");
        if !name.is_empty() {
            out.push(name);
        }

        if next == 0 {
            break;
        }
        offset += next;
    }

    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 手工拼一条记录：偏移是字节数，名字是 UTF-16
    fn record(name: &str, action: u32, next: u32) -> Vec<u8> {
        let units: Vec<u16> = name.encode_utf16().collect();
        let mut buffer = vec![0u8; HEADER + units.len() * 2];
        buffer[0..4].copy_from_slice(&next.to_le_bytes());
        buffer[4..8].copy_from_slice(&action.to_le_bytes());
        buffer[8..12].copy_from_slice(&((units.len() * 2) as u32).to_le_bytes());
        for (index, unit) in units.iter().enumerate() {
            let at = HEADER + index * 2;
            buffer[at..at + 2].copy_from_slice(&unit.to_le_bytes());
        }
        buffer
    }

    #[test]
    fn parses_a_single_record() {
        assert_eq!(
            parse_notifications(&record("lattice.clock/widget.js", 3, 0)),
            vec!["lattice.clock/widget.js"]
        );
    }

    #[test]
    fn backslashes_become_slashes() {
        assert_eq!(
            parse_notifications(&record(r"lattice.note\style.css", 1, 0)),
            vec!["lattice.note/style.css"]
        );
    }

    #[test]
    fn chains_multiple_records() {
        // 第一条的 NextEntryOffset 指向第二条的开头，第二条的为 0
        let first = record("a/one.js", 3, 0);
        let second = record("a/two.css", 3, 0);
        let mut buffer = first.clone();
        let next = first.len() as u32;
        buffer[0..4].copy_from_slice(&next.to_le_bytes());
        buffer.extend_from_slice(&second);

        assert_eq!(parse_notifications(&buffer), vec!["a/one.js", "a/two.css"]);
    }

    #[test]
    fn empty_buffer_is_not_a_panic() {
        assert!(parse_notifications(&[]).is_empty());
    }

    #[test]
    fn truncated_record_is_dropped_not_a_panic() {
        // 系统缓冲区满了会把最后一条截断：头说名字 40 字节，实际只剩 10 字节
        let mut buffer = record("lattice.note/a-very-long-file-name.txt", 3, 0);
        buffer.truncate(HEADER + 10);
        assert!(parse_notifications(&buffer).is_empty());
    }
}
