//! 组件私有存储的落盘。
//!
//! 每个组件包一个 JSON 文件，放在配置目录的 widget-data/ 下：
//!
//!   %APPDATA%\com.iron-tom.lattice\widget-data\lattice.note.json
//!
//! 里面就是一个 `{ "键": 值 }` 的对象，前端负责解析。Rust 这层不关心里面
//! 装的是什么，只保证"整块读、整块写、按包隔离"。
//!
//! 和平台状态一样，不用 localStorage：这里的 WebView2 把 localStorage 放在
//! 内存里，进程一退组件写的东西就全没了。

use std::path::PathBuf;
use tauri::{AppHandle, Manager};

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
        return Err(format!("组件 id 不合法：{id}"));
    }
    Ok(cleaned)
}

fn store_path(app: &AppHandle, widget_id: &str) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|error| format!("拿不到配置目录：{error}"))?
        .join("widget-data");
    std::fs::create_dir_all(&dir).map_err(|error| format!("创建组件数据目录失败：{error}"))?;
    Ok(dir.join(format!("{}.json", safe_id(widget_id)?)))
}

#[tauri::command]
pub fn widget_store_read(app: AppHandle, widget_id: String) -> Result<Option<String>, String> {
    let path = store_path(&app, &widget_id)?;
    match std::fs::read_to_string(&path) {
        Ok(text) => Ok(Some(text)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!("读取组件数据失败：{error}")),
    }
}

#[tauri::command]
pub fn widget_store_write(app: AppHandle, widget_id: String, json: String) -> Result<(), String> {
    let path = store_path(&app, &widget_id)?;
    let temp = path.with_extension("json.tmp");
    std::fs::write(&temp, json.as_bytes()).map_err(|error| format!("写入组件数据失败：{error}"))?;
    std::fs::rename(&temp, &path).map_err(|error| format!("替换组件数据文件失败：{error}"))?;
    Ok(())
}

/// 卸载组件时连带清掉它的数据。
#[tauri::command]
pub fn widget_store_clear(app: AppHandle, widget_id: String) -> Result<(), String> {
    let path = store_path(&app, &widget_id)?;
    match std::fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("删除组件数据失败：{error}")),
    }
}
