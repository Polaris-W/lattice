//! 组件私有存储的落盘。
//!
//! 每个组件包一个 JSON 文件，放在配置目录的 widget-data/ 下：
//!
//!   %APPDATA%\com.iron-tom.lattice\widget-data\lattice.note.json
//!
//! 里面就是一个 `{ "键": 值 }` 的对象，前端负责解析。Rust 这层不关心里面
//! 装的是什么，只保证"按包隔离、写入不丢键"。
//!
//! # 为什么有 `widget_store_update`
//!
//! 早先只有"整块写"。组件要改一个键，就得先把整份 JSON 读上来、改完再写回去，
//! 也就是一次跨进程的读-改-写。这个动作一旦有两个发起方（桌面窗口里的便签、
//! 主窗口画布里的同一个便签），就会交错成「读 A / 读 B / 写 A / 写 B」，
//! 后写的把先写的那次改动整块抹掉。
//!
//! 所以键级修改收敛到这一层：进程内加锁、读、改一个键、原子替换。
//! 跨窗口的并发因此变成排队，而不是互相覆盖。
//!
//! 和平台状态一样，不用 localStorage：这里的 WebView2 把 localStorage 放在
//! 内存里，进程一退组件写的东西就全没了。

use std::path::PathBuf;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager};

/// 键级读-改-写必须串行。锁的是"整份文件的修改"，粒度粗但对一个组件包足够。
static STORE_LOCK: Mutex<()> = Mutex::new(());

/// 组件存储变了，广播给所有窗口。
///
/// 不广播的话，同一个组件的两个实例（画布上一个、桌面窗口一个）各持一份
/// 内存副本：A 加了两条，B 还停在旧列表，B 随便动一下就把那两条写没了 ——
/// 用户看到的是"加了几条，回头只剩一条"。
///
/// `key` 为空串表示整份文件被替换过（`widget_store_write`），监听方应全量刷新。
#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct StoreEvent {
    widget_id: String,
    key: String,
}

fn broadcast(app: &AppHandle, widget_id: &str, key: &str) {
    let _ = app.emit(
        "lattice:widget-store",
        StoreEvent {
            widget_id: widget_id.to_string(),
            key: key.to_string(),
        },
    );
}

/// 组件 id 来自清单文件，理论上可能被塞进 `../` 之类的路径片段，先洗一遍。
fn safe_id(id: &str) -> Result<String, String> {
    let cleaned: String = id
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch == '.' || ch == '_' || ch == '-' {
                ch
            } else {
                '_'
            }
        })
        .collect();
    if cleaned.is_empty() || cleaned.starts_with('.') {
        return Err(format!("invalid widget id: {id}"));
    }
    Ok(cleaned)
}

fn store_path(app: &AppHandle, widget_id: &str) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|error| format!("could not resolve the config directory: {error}"))?
        .join("widget-data");
    std::fs::create_dir_all(&dir).map_err(|error| format!("failed to create the widget data directory: {error}"))?;
    Ok(dir.join(format!("{}.json", safe_id(widget_id)?)))
}

#[tauri::command]
pub fn widget_store_read(app: AppHandle, widget_id: String) -> Result<Option<String>, String> {
    let path = store_path(&app, &widget_id)?;
    match std::fs::read_to_string(&path) {
        Ok(text) => Ok(Some(text)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!("failed to read widget data: {error}")),
    }
}

/// 原子替换：先写临时文件再 rename，断电时不会留下半截 JSON。
///
/// # 为什么先留一份 `.bak`
///
/// 这一层只保证"写进去的是完整 JSON"，不保证"写进去的是对的东西"。真实撞过：
/// 组件某次初始化里 `storage.get` 没读成功（拿到的和"没有数据"长得一样），
/// 走了"没数据就种一份默认值"的分支，把种子数据存了回来 —— 用户的便签和待办
/// 当场变成出厂示例，而盘上那份真数据已经没了，一点退路都没有。
///
/// 所以每次覆盖前把旧内容挪到 `<名>.json.bak`，只留一代。**只在内容真的变了时
/// 才留**：一样的内容没有可丢的东西，不为此多写一次盘（组件的保存可能很频繁）。
/// 备份失败不拦主写入 —— 用户这一次保存比备份要紧，记一行日志就走。
fn write_atomic(path: &std::path::Path, json: &str) -> Result<(), String> {
    keep_backup(path, json);
    let temp = path.with_extension("json.tmp");
    std::fs::write(&temp, json.as_bytes()).map_err(|error| format!("failed to write widget data: {error}"))?;
    std::fs::rename(&temp, path).map_err(|error| format!("failed to replace the widget data file: {error}"))?;
    Ok(())
}

/// 把盘上现有的内容留到 `<名>.json.bak`，覆盖之后就靠它兜底。
fn keep_backup(path: &std::path::Path, next: &str) {
    let previous = match std::fs::read_to_string(path) {
        Ok(text) => text,
        // 第一次写这个组件，没有旧内容可备份
        Err(_) => return,
    };
    if previous == next {
        return;
    }
    let backup = path.with_extension("json.bak");
    if let Err(error) = std::fs::write(&backup, previous.as_bytes()) {
        eprintln!("[lattice] could not keep a backup of {}: {error}", path.display());
    }
}

/// 整块替换。只有确实要重写全部键时才用它，改单个键走 `widget_store_update`。
#[tauri::command]
pub fn widget_store_write(app: AppHandle, widget_id: String, json: String) -> Result<(), String> {
    let path = store_path(&app, &widget_id)?;
    {
        let _guard = STORE_LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
        write_atomic(&path, &json)?;
    }
    // 出了锁再广播：监听方很可能立刻回头读存储，别让它等在锁上
    broadcast(&app, &widget_id, "");
    Ok(())
}

/// 改一个键：`value` 为 `Some` 是写入，`None` 是删除。
///
/// 读、改、写三步都在锁里完成，所以两个窗口同时保存不会互相抹掉对方的键。
#[tauri::command]
pub fn widget_store_update(
    app: AppHandle,
    widget_id: String,
    key: String,
    value: Option<serde_json::Value>,
) -> Result<(), String> {
    let path = store_path(&app, &widget_id)?;

    {
        let _guard = STORE_LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner());

        let mut map: serde_json::Map<String, serde_json::Value> = match std::fs::read_to_string(&path)
        {
            Ok(text) => serde_json::from_str(&text).unwrap_or_default(),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Default::default(),
            Err(error) => return Err(format!("failed to read widget data: {error}")),
        };

        match value {
            Some(next) => {
                map.insert(key.clone(), next);
            }
            None => {
                map.remove(&key);
            }
        }

        let json = serde_json::to_string(&serde_json::Value::Object(map))
            .map_err(|error| format!("failed to serialize widget data: {error}"))?;
        write_atomic(&path, &json)?;
    }

    broadcast(&app, &widget_id, &key);
    Ok(())
}

/// 卸载组件时连带清掉它的数据。
///
/// 连 `.bak` 一起删：卸载是用户明确说的"不要了"，留一份旧数据在那儿只会让
/// 以后的手工恢复分不清哪份才是当前。想保底的话，卸载前自己拷一份。
#[tauri::command]
pub fn widget_store_clear(app: AppHandle, widget_id: String) -> Result<(), String> {
    let path = store_path(&app, &widget_id)?;
    let _guard = STORE_LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
    for target in [path.clone(), path.with_extension("json.bak")] {
        match std::fs::remove_file(&target) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(format!("failed to delete widget data: {error}")),
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    /// 每个用例一个独立目录，别让 `cargo test` 的并发互相踩
    fn scratch(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("lattice-store-test-{name}"));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn backup_of(path: &Path) -> PathBuf {
        path.with_extension("json.bak")
    }

    #[test]
    fn first_write_leaves_no_backup() {
        let dir = scratch("first-write");
        let path = dir.join("a.json");
        write_atomic(&path, "{\"k\":1}").unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "{\"k\":1}");
        assert!(!backup_of(&path).exists(), "第一次写没有旧内容，不该产生 .bak");
    }

    #[test]
    fn overwrite_keeps_the_previous_content() {
        let dir = scratch("overwrite");
        let path = dir.join("b.json");
        write_atomic(&path, "{\"k\":1}").unwrap();
        write_atomic(&path, "{\"k\":2}").unwrap();
        // 盘上是新值，.bak 是上一步的值 —— 这就是"种子覆盖真数据"之后的退路
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "{\"k\":2}");
        assert_eq!(std::fs::read_to_string(backup_of(&path)).unwrap(), "{\"k\":1}");
    }

    #[test]
    fn identical_content_does_not_touch_the_backup() {
        let dir = scratch("identical");
        let path = dir.join("c.json");
        write_atomic(&path, "{\"k\":1}").unwrap();
        write_atomic(&path, "{\"k\":2}").unwrap();
        // 再写一次同样的内容：内容没变，可丢的东西就不存在，.bak 该停在上一步
        write_atomic(&path, "{\"k\":2}").unwrap();
        assert_eq!(std::fs::read_to_string(backup_of(&path)).unwrap(), "{\"k\":1}");
    }

    #[test]
    fn backup_keeps_only_one_generation() {
        let dir = scratch("one-generation");
        let path = dir.join("d.json");
        for value in ["1", "2", "3"] {
            write_atomic(&path, value).unwrap();
        }
        // 只留一代：最新的是"上一份"（2），不是最早那份（1）
        assert_eq!(std::fs::read_to_string(backup_of(&path)).unwrap(), "2");
    }

    #[test]
    fn temp_file_does_not_survive() {
        let dir = scratch("no-temp");
        let path = dir.join("e.json");
        write_atomic(&path, "{\"k\":1}").unwrap();
        write_atomic(&path, "{\"k\":2}").unwrap();
        assert!(!path.with_extension("json.tmp").exists(), "临时文件必须被 rename 掉");
    }
}
