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
use tauri::{AppHandle, Manager};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InstalledWidget {
    /// 原始 manifest.json 内容，校验交给前端做（错误信息要能回显给用户）
    pub manifest: serde_json::Value,
    pub dir: String,
    pub source: &'static str,
}

/// 用户组件目录，不存在时按需创建
fn user_widgets_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let base = app.path().app_data_dir().map_err(|error| error.to_string())?;
    let dir = base.join("widgets");
    if !dir.exists() {
        fs::create_dir_all(&dir).map_err(|error| format!("创建组件目录失败：{error}"))?;
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

/// 从任意目录安装一个组件：校验 id 合法 → 递归复制到用户组件目录
#[tauri::command]
pub fn install_widget(app: AppHandle, source_dir: String) -> Result<String, String> {
    let source = PathBuf::from(&source_dir);
    if !source.is_dir() {
        return Err(format!("目录不存在：{source_dir}"));
    }

    let manifest_text = fs::read_to_string(source.join("manifest.json"))
        .map_err(|error| format!("读不到 manifest.json：{error}"))?;
    let manifest: serde_json::Value =
        serde_json::from_str(&manifest_text).map_err(|error| format!("manifest.json 不是合法 JSON：{error}"))?;

    let id = manifest
        .get("id")
        .and_then(|value| value.as_str())
        .ok_or_else(|| "manifest.json 缺少 id 字段".to_string())?;

    // 防目录穿越：id 只允许小写字母、数字、点、连字符
    if id.is_empty()
        || !id
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '.' || c == '-')
    {
        return Err(format!("组件 id \"{id}\" 含非法字符"));
    }

    let target = user_widgets_dir(&app)?.join(id);
    if target.exists() {
        fs::remove_dir_all(&target).map_err(|error| format!("覆盖旧版本失败：{error}"))?;
    }
    copy_dir(&source, &target)?;

    Ok(id.to_string())
}

#[tauri::command]
pub fn uninstall_widget(app: AppHandle, id: String) -> Result<(), String> {
    if id.is_empty() || id.contains(['/', '\\', ':']) || id.contains("..") {
        return Err("组件 id 非法".to_string());
    }
    let target = user_widgets_dir(&app)?.join(&id);
    if target.exists() {
        fs::remove_dir_all(&target).map_err(|error| format!("删除失败：{error}"))?;
    }
    Ok(())
}

fn copy_dir(from: &Path, to: &Path) -> Result<(), String> {
    fs::create_dir_all(to).map_err(|error| format!("创建目录失败：{error}"))?;
    for entry in fs::read_dir(from)
        .map_err(|error| format!("读取目录失败：{error}"))?
        .flatten()
    {
        let path = entry.path();
        let name = entry.file_name();
        let target = to.join(&name);
        if path.is_dir() {
            copy_dir(&path, &target)?;
        } else {
            fs::copy(&path, &target).map_err(|error| format!("复制 {name:?} 失败：{error}"))?;
        }
    }
    Ok(())
}
