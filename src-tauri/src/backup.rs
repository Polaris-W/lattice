//! 上一版组件的备份与回滚。
//!
//! 更新是**覆盖式**的：`widgets/<id>` 整个目录被换掉。没有备份的话，用户点了
//! "更新"之后就没有回头路 —— 新版本坏了、或者它多要了一项权限而他不想给，
//! 他能做的只有卸载再找旧包。对一个把组件摆在桌面上的平台来说，这等于
//! 让一次点击变成不可逆的操作。
//!
//! 所以每次覆盖之前，把旧目录整份复制到 `widget-backups/<id>`，只留**一代**。
//! 为什么不按版本留多份：组件目录小（几十 KB），但"留几代"是个没有正确答案的
//! 配置项，而用户真正需要的是"回到刚才那个"。
//!
//! # 回滚是**交换**，不是复制
//!
//! 回滚之后，被换下来的那个版本变成新的备份 —— 于是"回滚"点两次就等于
//! "回到更新后的版本"。用复制实现的话，第二次回滚还是回到同一个旧版本，
//! 用户会以为按钮坏了。
//!
//! 交换靠 `fs::rename`（同一个卷上是原子的），中间那一步失败会把已经挪走的
//! 当前版本搬回去 —— 不能留下一个"两个版本都不见了"的目录。

use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager, Runtime};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupInfo {
    pub version: Option<String>,
    /// 备份目录的最后修改时间，Unix 秒
    pub at: Option<u64>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SwapResult {
    /// 换回来之后的版本
    pub version: Option<String>,
    /// 换下去的那个版本（现在成了新的备份）
    pub replaced: Option<String>,
}

/// 备份根目录，不存在时按需创建。
pub(crate) fn backup_root<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    let base = app.path().app_data_dir().map_err(|error| error.to_string())?;
    let dir = base.join("widget-backups");
    if !dir.exists() {
        fs::create_dir_all(&dir)
            .map_err(|error| format!("could not create the backup directory: {error}"))?;
    }
    Ok(dir)
}

/// 覆盖之前留一份旧版本。
///
/// 返回 `true` 表示确实留了。旧目录不存在（第一次装）时返回 `false` ——
/// 那时候没有可备份的东西，凭空建一个空备份只会让"能回滚"变成谎话。
pub(crate) fn save_existing(root: &Path, backups: &Path, id: &str) -> Result<bool, String> {
    let target = root.join(id);
    if !target.is_dir() {
        return Ok(false);
    }

    let slot = backups.join(id);
    if slot.exists() {
        fs::remove_dir_all(&slot)
            .map_err(|error| format!("could not clear the previous backup: {error}"))?;
    }
    copy_tree(&target, &slot)?;
    Ok(true)
}

pub(crate) fn info<R: Runtime>(app: &AppHandle<R>, id: &str) -> Result<Option<BackupInfo>, String> {
    let slot = backup_root(app)?.join(id);
    if !slot.is_dir() {
        return Ok(None);
    }
    let at = fs::metadata(&slot)
        .and_then(|meta| meta.modified())
        .ok()
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|duration| duration.as_secs());

    Ok(Some(BackupInfo {
        version: read_version(&slot),
        at,
    }))
}

/// 把备份换回来。当前版本（如果有）变成新的备份。
pub(crate) fn swap<R: Runtime>(
    app: &AppHandle<R>,
    root: &Path,
    id: &str,
) -> Result<SwapResult, String> {
    let backups = backup_root(app)?;
    swap_dirs(root, &backups, id)
}

/// 交换本身。**不依赖 AppHandle**，所以单测直接调这一个 ——
/// 逻辑只写一份，测试里不许再抄一遍（抄的那份永远是"能过但没测到真代码"）。
pub(crate) fn swap_dirs(root: &Path, backups: &Path, id: &str) -> Result<SwapResult, String> {
    let current = root.join(id);
    let slot = backups.join(id);
    if !slot.is_dir() {
        return Err("there is no previous version to roll back to".to_string());
    }

    let staging = backups.join(format!("{id}.swap"));
    if staging.exists() {
        fs::remove_dir_all(&staging)
            .map_err(|error| format!("could not clear the staging folder: {error}"))?;
    }

    let replaced = read_version(&current);
    let had_current = current.is_dir();
    if had_current {
        fs::rename(&current, &staging)
            .map_err(|error| format!("could not move the current version aside: {error}"))?;
    }

    if let Err(error) = fs::rename(&slot, &current) {
        // 退回去：宁可"什么都没变"，也不能让用户的组件凭空消失
        if had_current {
            let _ = fs::rename(&staging, &current);
        }
        return Err(format!("could not restore the backup: {error}"));
    }

    if had_current {
        fs::rename(&staging, &slot)
            .map_err(|error| format!("could not keep the replaced version as a backup: {error}"))?;
    }

    Ok(SwapResult {
        version: read_version(&current),
        replaced,
    })
}

/// 清单里的 version。读不到就是 None —— 备份目录可能是手改过的，
/// 但"版本号读不出来"不该让回滚失败。
fn read_version(dir: &Path) -> Option<String> {
    let text = fs::read_to_string(dir.join("manifest.json")).ok()?;
    let value: serde_json::Value = serde_json::from_str(&text).ok()?;
    value
        .get("version")
        .and_then(|item| item.as_str())
        .map(|item| item.to_string())
}

pub(crate) fn copy_tree(from: &Path, to: &Path) -> Result<(), String> {
    fs::create_dir_all(to).map_err(|error| format!("could not create a directory: {error}"))?;
    for entry in fs::read_dir(from)
        .map_err(|error| format!("could not read a directory: {error}"))?
        .flatten()
    {
        let path = entry.path();
        let name = entry.file_name();
        let target = to.join(&name);
        if path.is_dir() {
            copy_tree(&path, &target)?;
        } else {
            fs::copy(&path, &target)
                .map_err(|error| format!("could not copy {name:?}: {error}"))?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn tempdir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("lattice-backup-test-{name}"));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn write_widget(dir: &Path, version: &str) {
        fs::create_dir_all(dir).unwrap();
        let mut file = fs::File::create(dir.join("manifest.json")).unwrap();
        write!(file, "{{\"id\":\"demo.one\",\"version\":\"{version}\"}}").unwrap();
    }

    #[test]
    fn first_install_has_nothing_to_back_up() {
        let root = tempdir("first-root");
        let backups = tempdir("first-backups");
        assert!(!save_existing(&root, &backups, "demo.one").unwrap());
        assert!(!backups.join("demo.one").exists());
    }

    #[test]
    fn overwrite_keeps_the_previous_copy() {
        let root = tempdir("overwrite-root");
        let backups = tempdir("overwrite-backups");
        write_widget(&root.join("demo.one"), "1.0.0");
        assert!(save_existing(&root, &backups, "demo.one").unwrap());
        assert_eq!(read_version(&backups.join("demo.one")).as_deref(), Some("1.0.0"));

        // 再覆盖一次，备份要被新的旧版本替换，而且只留一代
        write_widget(&root.join("demo.one"), "1.1.0");
        assert!(save_existing(&root, &backups, "demo.one").unwrap());
        assert_eq!(read_version(&backups.join("demo.one")).as_deref(), Some("1.1.0"));
        let slots: Vec<_> = fs::read_dir(&backups).unwrap().flatten().collect();
        assert_eq!(slots.len(), 1, "只留一代备份");
    }

    #[test]
    fn swap_moves_in_both_directions() {
        let root = tempdir("swap-root");
        let backups = tempdir("swap-backups");
        write_widget(&root.join("demo.one"), "2.0.0");
        write_widget(&backups.join("demo.one"), "1.0.0");

        let first = swap_dirs(&root, &backups, "demo.one").unwrap();
        assert_eq!(first.version.as_deref(), Some("1.0.0"));
        assert_eq!(first.replaced.as_deref(), Some("2.0.0"));
        assert_eq!(read_version(&root.join("demo.one")).as_deref(), Some("1.0.0"));
        assert_eq!(read_version(&backups.join("demo.one")).as_deref(), Some("2.0.0"));

        // 再点一次：回到 2.0.0 —— 这就是"回滚是交换"的意思
        let second = swap_dirs(&root, &backups, "demo.one").unwrap();
        assert_eq!(second.version.as_deref(), Some("2.0.0"));
        assert_eq!(second.replaced.as_deref(), Some("1.0.0"));
    }

    #[test]
    fn swap_without_a_backup_fails_loudly() {
        let root = tempdir("nobak-root");
        let backups = tempdir("nobak-backups");
        write_widget(&root.join("demo.one"), "1.0.0");
        let error = swap_dirs(&root, &backups, "demo.one").unwrap_err();
        assert!(error.contains("no previous version"), "got {error}");
        // 失败不该动到当前版本
        assert_eq!(read_version(&root.join("demo.one")).as_deref(), Some("1.0.0"));
    }
}
