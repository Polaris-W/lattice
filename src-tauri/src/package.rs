//! `.lattice` 包的解压与落盘。
//!
//! 打包工具（`scripts/pack-widget.mjs`）把组件目录写成一个 ZIP；这里把它拆回
//! 文件树。字节布局的读法和路径规则在 `package_policy.rs`（纯函数、能单测），
//! 这个文件只负责两件带依赖的事：**解压**（`flate2`）和**原子地换目录**。
//!
//! # 为什么先解到临时目录
//!
//! 用户装一个包，期待的是"要么是旧版本，要么是新版本"，不是"一半旧一半新"。
//! 直接往目标目录里铺，中途失败（磁盘满、包坏了、CRC 不对）就会留下一个
//! 半残的组件 —— 而它看起来是个装好的组件，只会报一些莫名其妙的错。
//! 所以：先解到 `<id>.incoming`，全部校验通过，再删旧目录、改名。
//!
//! # CRC 要校验
//!
//! 传输坏的包（半截下载、被编辑器改过的 zip）解出来是**看起来合法**的文本。
//! 那种组件的错误信息会指向业务代码，而不是"包坏了"。一次 CRC 比这便宜得多。

use std::fs;
use std::io::Read;
use std::path::Path;

use flate2::read::DeflateDecoder;
use flate2::Crc;

use crate::package_policy::{data_range, join_inside, read_entries, Entry, MAX_ENTRY_BYTES};

/// 解一个包到 `root/<id>`，返回清单里的 id。
///
/// `root` 是组件根目录（`%APPDATA%\...\widgets`），不是最终目录 —— id 在包里，
/// 得先读出来才知道该落到哪个名字上。
pub(crate) fn extract(archive: &[u8], root: &Path) -> Result<String, String> {
    let entries = read_entries(archive)?;

    // 先把 manifest 读出来校验 id —— 校验不过就一个文件都别写
    let manifest_entry = entries
        .iter()
        .find(|entry| entry.name == "manifest.json")
        .ok_or_else(|| "the package has no manifest.json at its root".to_string())?;
    let manifest_text = String::from_utf8(read_entry(archive, manifest_entry)?)
        .map_err(|_| "manifest.json is not valid UTF-8".to_string())?;
    let manifest: serde_json::Value = serde_json::from_str(&manifest_text)
        .map_err(|error| format!("manifest.json is not valid JSON: {error}"))?;
    let id = manifest
        .get("id")
        .and_then(|value| value.as_str())
        .ok_or_else(|| "manifest.json is missing the id field".to_string())?
        .to_string();

    if id.is_empty()
        || !id
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '.' || c == '-')
    {
        return Err(format!("widget id \"{id}\" contains illegal characters"));
    }

    let incoming = root.join(format!("{id}.incoming"));
    if incoming.exists() {
        fs::remove_dir_all(&incoming).map_err(|error| format!("could not clear the staging folder: {error}"))?;
    }
    fs::create_dir_all(&incoming).map_err(|error| format!("could not create the staging folder: {error}"))?;

    if let Err(error) = write_all(archive, &entries, &incoming) {
        // 半截的暂存目录不留给下一次：名字是固定的，留着只会越积越乱
        let _ = fs::remove_dir_all(&incoming);
        return Err(error);
    }

    let target = root.join(&id);
    if target.exists() {
        fs::remove_dir_all(&target).map_err(|error| format!("failed to replace the previous version: {error}"))?;
    }
    fs::rename(&incoming, &target).map_err(|error| format!("could not move the widget into place: {error}"))?;

    Ok(id)
}

fn write_all(archive: &[u8], entries: &[Entry], root: &Path) -> Result<(), String> {
    for entry in entries {
        let bytes = read_entry(archive, entry)?;
        let path = join_inside(root, &entry.name)?;
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(|error| format!("could not create a folder: {error}"))?;
        }
        fs::write(&path, &bytes).map_err(|error| format!("could not write {}: {error}", entry.name))?;
    }
    Ok(())
}

/// 解一条条目，顺便校验 CRC 和大小上限。
fn read_entry(archive: &[u8], entry: &Entry) -> Result<Vec<u8>, String> {
    let (start, end) = data_range(archive, entry)?;
    let raw = &archive[start..end];

    let bytes = match entry.method {
        0 => raw.to_vec(),
        // 8 = deflate。`take` 是第二道保险：中央目录声明的解压后大小可能是假的，
        // 真按炸弹解开之前先给自己留个上限
        8 => {
            let mut decoder = DeflateDecoder::new(raw).take((MAX_ENTRY_BYTES + 1) as u64);
            let mut out = Vec::new();
            decoder
                .read_to_end(&mut out)
                .map_err(|error| format!("could not decompress \"{}\": {error}", entry.name))?;
            if out.len() > MAX_ENTRY_BYTES {
                return Err(format!("\"{}\" expands beyond the size limit", entry.name));
            }
            out
        }
        other => return Err(format!("unsupported compression method {other}")),
    };

    if bytes.len() != entry.uncompressed_size {
        return Err(format!(
            "\"{}\" is corrupt (expected {} bytes, got {})",
            entry.name,
            entry.uncompressed_size,
            bytes.len()
        ));
    }

    let mut crc = Crc::new();
    crc.update(&bytes);
    if crc.sum() != entry.crc32 {
        return Err(format!("\"{}\" is corrupt (checksum mismatch)", entry.name));
    }

    Ok(bytes)
}
