//! 组件包管理
//!
//! 磁盘布局：
//!   %APPDATA%\<identifier>\widgets\<组件 id>\manifest.json + 入口文件
//!
//! 内置组件不在这里——它们随前端资源打包，由前端从 /widgets/index.json 读取。
//! Rust 只负责"用户安装的组件"，这样生产环境不需要把组件目录再复制一份到 resources。

use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager, Runtime};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstalledWidget {
    /// 原始 manifest.json 内容，校验交给前端做（错误信息要能回显给用户）
    pub manifest: serde_json::Value,
    pub dir: String,
    pub source: &'static str,
}

/// 用户组件目录，不存在时按需创建。
///
/// `protocol.rs` 也从这里取根目录 —— 组件的静态文件由它负责发出去，
/// 两边必须是同一个路径，否则「装了但打不开」。
/// 泛型是为了让协议回调（拿到的是 `AppHandle<R>`）也能直接调。
pub(crate) fn user_widgets_dir<R: Runtime>(app: &AppHandle<R>) -> Result<PathBuf, String> {
    let base = app.path().app_data_dir().map_err(|error| error.to_string())?;
    let dir = base.join("widgets");
    if !dir.exists() {
        fs::create_dir_all(&dir).map_err(|error| format!("failed to create the widgets directory: {error}"))?;
    }
    Ok(dir)
}

fn scan_user_widgets(root: &Path) -> Vec<InstalledWidget> {
    let Ok(entries) = fs::read_dir(root) else {
        return Vec::new();
    };

    let mut out = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let manifest_path = path.join("manifest.json");
        let Ok(text) = fs::read_to_string(&manifest_path) else {
            continue;
        };
        let Ok(manifest) = serde_json::from_str::<serde_json::Value>(&text) else {
            // 清单不是合法 JSON：也返回出去，让前端展示"加载失败"而不是静默消失
            out.push(InstalledWidget {
                manifest: serde_json::Value::Null,
                dir: path.display().to_string(),
                source: "user",
            });
            continue;
        };
        out.push(InstalledWidget {
            manifest,
            dir: path.display().to_string(),
            source: "user",
        });
    }
    out
}

#[tauri::command]
pub fn list_widgets(app: AppHandle) -> Result<Vec<InstalledWidget>, String> {
    let dir = user_widgets_dir(&app)?;
    Ok(scan_user_widgets(&dir))
}

#[tauri::command]
pub fn widgets_dir(app: AppHandle) -> Result<String, String> {
    Ok(user_widgets_dir(&app)?.display().to_string())
}

/// 装一个组件。`source` 可以是**目录**（拖一个文件夹进来），也可以是
/// **`.lattice` 包**（`scripts/pack-widget.mjs` 打出来的 ZIP）。
///
/// 两条路的共同点：id 从清单里读、只允许小写字母数字点连字符、装到
/// `%APPDATA%\...\widgets\<id>`。区别只在"文件怎么搬过去"。
#[tauri::command]
pub fn install_widget(app: AppHandle, source: String) -> Result<String, String> {
    // 拷贝期间把文件监听压住：几十个文件会各报一次变化，
    // 而装完之后前端本来就会自己重扫一遍清单
    let _quiet = crate::watch::Suppress::new();

    let path = PathBuf::from(&source);
    if !path.exists() {
        return Err(format!("no such file or folder: {source}"));
    }

    if path.is_file() {
        return install_package(&app, &path);
    }
    if !path.is_dir() {
        return Err(format!("Not a widget folder: {source}"));
    }

    let manifest_text = fs::read_to_string(path.join("manifest.json"))
        // 「不是组件目录」这几个字前端会认：拖进来的可能只是随便一个文件夹，
        // 那种情况不该弹一屏红字
        .map_err(|error| format!("Not a widget folder: cannot read manifest.json ({error})"))?;
    let manifest: serde_json::Value =
        serde_json::from_str(&manifest_text).map_err(|error| format!("manifest.json is not valid JSON: {error}"))?;

    let id = manifest
        .get("id")
        .and_then(|value| value.as_str())
        .ok_or_else(|| "manifest.json is missing the id field".to_string())?;

    // 防目录穿越：id 只允许小写字母、数字、点、连字符
    if id.is_empty()
        || !id
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '.' || c == '-')
    {
        return Err(format!("widget id \"{id}\" contains illegal characters"));
    }

    let target = user_widgets_dir(&app)?.join(id);
    if target.exists() {
        fs::remove_dir_all(&target).map_err(|error| format!("failed to replace the previous version: {error}"))?;
    }
    copy_dir(&path, &target)?;

    Ok(id.to_string())
}

/// 从 `.lattice` 包装：读文件 → 交给 `package::extract`。
///
/// 拖进来的普通文件（一张图、一个别的 zip）不该弹红字，所以非 ZIP 一律回
/// "Not a widget folder" 那句哨兵 —— 前端认它，静默跳过。
fn install_package(app: &AppHandle, path: &Path) -> Result<String, String> {
    let archive = fs::read(path).map_err(|error| format!("could not read the package: {error}"))?;

    // 不靠扩展名判断：`.lattice` 只是个约定，真正决定能不能装的是 ZIP 的本地头
    if !archive.starts_with(b"PK\x03\x04") {
        return Err(format!(
            "Not a widget folder: {} is not a .lattice package",
            path.display()
        ));
    }

    // id 在包里的清单上，所以落哪个目录由 `extract` 自己决定
    crate::package::extract(&archive, &user_widgets_dir(app)?)
}

#[tauri::command]
pub fn uninstall_widget(app: AppHandle, id: String) -> Result<(), String> {
    let _quiet = crate::watch::Suppress::new();
    if id.is_empty() || id.contains(['/', '\\', ':']) || id.contains("..") {
        return Err("invalid widget id".to_string());
    }
    let target = user_widgets_dir(&app)?.join(&id);
    if target.exists() {
        fs::remove_dir_all(&target).map_err(|error| format!("delete failed: {error}"))?;
    }
    Ok(())
}

fn copy_dir(from: &Path, to: &Path) -> Result<(), String> {
    fs::create_dir_all(to).map_err(|error| format!("failed to create a directory: {error}"))?;
    for entry in fs::read_dir(from)
        .map_err(|error| format!("failed to read a directory: {error}"))?
        .flatten()
    {
        let path = entry.path();
        let name = entry.file_name();
        let target = to.join(&name);
        if path.is_dir() {
            copy_dir(&path, &target)?;
        } else {
            fs::copy(&path, &target).map_err(|error| format!("failed to copy {name:?}: {error}"))?;
        }
    }
    Ok(())
}
