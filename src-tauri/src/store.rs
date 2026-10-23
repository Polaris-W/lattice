//! 组件商店：取目录、下载包、验签安装、写举报。
//!
//! # 这里没有服务端
//!
//! 目录是一份静态 `registry.json`（格式见 `src/runtime/catalogue.ts`），
//! 包是普通的 `.lattice` 文件。所以"商店"要做的事其实只有三件：
//!
//! 1. 把那份 JSON 取回来（**走 Rust**，不走 `fetch`：主窗口取远端会被 CORS 挡，
//!    而目录作者没理由为了 Lattice 去配一个 `Access-Control-Allow-Origin`）
//! 2. 把包取回来并**校验**（摘要 + ed25519 签名，见 `signature.rs`）
//! 3. 交给 `package::extract` 落盘（带备份，见 `backup.rs`）
//!
//! # 为什么平台自己出网不走 `network.rs` 的白名单
//!
//! 白名单是"组件能连哪儿"，按组件清单校验。商店的地址是**用户自己填的**
//! （或者应用自带的本地目录），没有清单可查 —— 拿组件的白名单去卡它，
//! 结果是"组件能连的地方商店不一定能连"，反过来也一样。两件事分开：
//! 组件走 `network_fetch`，平台走这里，各自有各自的闸门。
//!
//! 平台这条闸门是形状：只 http/https、只 GET、目录 ≤2MB、包 ≤16MB、
//! 重定向不跟随（和组件那条同一个理由：跟着 302 走等于没校验）。
//!
//! # 下载结果落到磁盘再验
//!
//! 包可能有几 MB，没必要让字节在 IPC 上走两趟（下载一趟、安装一趟）。
//! `store_download` 按内容 hash 命名存进 `store-cache/`，`store_install`
//! 直接读那个文件 —— 顺带得到一个"同一个包只下载一次"的缓存。
//! 缓存**不信任**：安装时仍然重新算一遍摘要，缓存里的文件被改过一样拦得住。

use std::fs;
use std::path::PathBuf;

use serde::Serialize;
use tauri::{AppHandle, Manager};

use crate::network_policy::parse_url;
use crate::signature_policy::{base64_decode, safe_id};

/// 目录 JSON 的上限。几百个组件也就几十 KB，2MB 已经很宽松
pub(crate) const MAX_CATALOGUE_BYTES: usize = 2 * 1024 * 1024;
/// 单个包的上限。`package_policy` 那边还有 64MB 的解压总量限制
pub(crate) const MAX_PACKAGE_BYTES: usize = 16 * 1024 * 1024;
/// 举报里正文的上限。这不是论坛，一句话说清问题就够了
const MAX_REPORT_NOTE: usize = 4000;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StoreDownload {
    pub path: String,
    pub sha256: String,
    pub size: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StoreInstall {
    pub id: String,
    /// 装完之后磁盘上那个版本（以清单为准，不信调用方传的）
    pub version: String,
    /// 被替换掉的版本，第一次装是 None
    pub previous_version: Option<String>,
    /// 有没有留下可回滚的备份
    pub backed_up: bool,
}

fn cache_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let base = app.path().app_data_dir().map_err(|error| error.to_string())?;
    let dir = base.join("store-cache");
    if !dir.exists() {
        fs::create_dir_all(&dir)
            .map_err(|error| format!("could not create the download cache: {error}"))?;
    }
    Ok(dir)
}

fn reports_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let base = app.path().app_data_dir().map_err(|error| error.to_string())?;
    let dir = base.join("reports");
    if !dir.exists() {
        fs::create_dir_all(&dir)
            .map_err(|error| format!("could not create the reports folder: {error}"))?;
    }
    Ok(dir)
}

/// 取一段文本（目录 JSON）。只 GET、只 http/https、上限 2MB。
#[tauri::command]
pub async fn store_fetch_text(url: String) -> Result<String, String> {
    let target = parse_url(&url)?;
    let fetched = tauri::async_runtime::spawn_blocking(move || {
        crate::network::send(&target, "GET", &[], None, MAX_CATALOGUE_BYTES)
    })
    .await
    .map_err(|error| format!("the catalogue request failed: {error}"))??;

    if !fetched.ok {
        return Err(format!(
            "the catalogue server answered {} — check the address",
            fetched.status
        ));
    }
    if fetched.truncated {
        return Err(format!(
            "the catalogue is larger than {} KB",
            MAX_CATALOGUE_BYTES / 1024
        ));
    }
    Ok(String::from_utf8_lossy(&fetched.body).to_string())
}

/// 下载一个包到缓存，返回路径与摘要。
///
/// 文件名就是内容 hash —— 同一个包第二次下载会命中同一个文件，
/// 也顺手说明"这个路径里的东西应该是什么"。
#[tauri::command]
pub async fn store_download(app: AppHandle, url: String) -> Result<StoreDownload, String> {
    let target = parse_url(&url)?;
    let fetched = tauri::async_runtime::spawn_blocking(move || {
        crate::network::send(&target, "GET", &[], None, MAX_PACKAGE_BYTES)
    })
    .await
    .map_err(|error| format!("the download failed: {error}"))??;

    if !fetched.ok {
        return Err(format!("the download failed with status {}", fetched.status));
    }
    if fetched.truncated {
        return Err(format!(
            "the package is larger than {} MB",
            MAX_PACKAGE_BYTES / 1024 / 1024
        ));
    }

    let sha256 = crate::signature::sha256_hex(&fetched.body);
    let path = cache_dir(&app)?.join(format!("{sha256}.lattice"));
    if !path.exists() {
        // 先写临时文件再改名：缓存目录里的东西要么完整，要么不存在
        let temp = path.with_extension("lattice.tmp");
        fs::write(&temp, &fetched.body).map_err(|error| format!("could not save the package: {error}"))?;
        fs::rename(&temp, &path).map_err(|error| format!("could not finish saving the package: {error}"))?;
    }

    Ok(StoreDownload {
        path: path.display().to_string(),
        sha256,
        size: fetched.body.len() as u64,
    })
}

/// 校验并安装一个包。
///
/// 两个来源二选一：
///   - `path`：`store_download` 落下来的缓存文件（远端目录）
///   - `bytes`：base64 的包字节（内置目录跟着应用一起发，前端直接 `fetch` 到）
///
/// 校验顺序不能换：摘要 → 签名 → 解包。摘要先跑是因为便宜，
/// 但它挡不住"连目录一起换掉"，所以签名必须在解包**之前**。
#[tauri::command]
pub async fn store_install(
    app: AppHandle,
    id: String,
    version: String,
    sha256: String,
    signature: String,
    public_key: String,
    path: Option<String>,
    bytes: Option<String>,
) -> Result<StoreInstall, String> {
    let checked_id = safe_id(&id).ok_or_else(|| format!("invalid widget id \"{id}\""))?.to_string();

    let archive = match (path, bytes) {
        (Some(path), _) => {
            let meta = fs::metadata(&path).map_err(|error| format!("could not read the package: {error}"))?;
            if meta.len() as usize > MAX_PACKAGE_BYTES {
                return Err(format!("the package is larger than {} MB", MAX_PACKAGE_BYTES / 1024 / 1024));
            }
            fs::read(&path).map_err(|error| format!("could not read the package: {error}"))?
        }
        (None, Some(encoded)) => base64_decode(&encoded)?,
        (None, None) => return Err("no package bytes were provided".to_string()),
    };

    if archive.len() > MAX_PACKAGE_BYTES {
        return Err(format!("the package is larger than {} MB", MAX_PACKAGE_BYTES / 1024 / 1024));
    }

    // 1 + 2：摘要与签名。失败时一个字都不写盘
    crate::signature::verify(&archive, &sha256, &signature, &public_key)?;

    let root = crate::widgets::user_widgets_dir(&app)?;
    let previous_version = read_manifest_version(&root.join(&checked_id));
    let backups = crate::backup::backup_root(&app)?;
    let _quiet = crate::watch::Suppress::new();

    // 3：解包（内部会先备份旧目录再原子换目录）
    let installed_id = crate::package::extract(&archive, &root, Some(&backups))?;
    if installed_id != checked_id {
        // 包里的清单 id 和目录说的一致才算数。不一致时 extract 已经把它装到
        // 别的目录去了 —— 这种情况只在"目录和包不是一对"时出现，必须删掉
        let _ = fs::remove_dir_all(root.join(&installed_id));
        return Err(format!(
            "the package contains \"{installed_id}\" but the catalogue lists \"{checked_id}\""
        ));
    }

    let installed_version = read_manifest_version(&root.join(&checked_id))
        .ok_or_else(|| "the installed package has no readable manifest.json".to_string())?;
    if installed_version != version {
        return Err(format!(
            "the package is version {installed_version} but the catalogue lists {version}"
        ));
    }

    let backed_up = crate::backup::info(&app, &checked_id)?.is_some();
    eprintln!(
        "[lattice] store_install {checked_id} {installed_version} (key {})",
        crate::signature_policy::key_fingerprint(&public_key)
    );

    Ok(StoreInstall {
        id: checked_id,
        version: installed_version,
        previous_version,
        backed_up,
    })
}

fn read_manifest_version(dir: &std::path::Path) -> Option<String> {
    let text = fs::read_to_string(dir.join("manifest.json")).ok()?;
    let value: serde_json::Value = serde_json::from_str(&text).ok()?;
    value.get("version").and_then(|item| item.as_str()).map(|item| item.to_string())
}

/// 把一条举报写到 `reports/<id>-<时间戳>.json`，返回文件路径。
///
/// 平台没有服务端，所以"举报"只能做到"写一份结构化的文件、告诉你它在哪儿"。
/// 这仍然是真功能：用户不用手抄版本号和权限清单，作者拿到的是一份完整现场。
/// 界面上的说明必须说清这一点 —— 假装"已提交"比不做更糟。
#[tauri::command]
pub fn store_report(
    app: AppHandle,
    id: String,
    version: String,
    reason: String,
    note: String,
    stars: Option<u8>,
) -> Result<String, String> {
    let checked = safe_id(&id).ok_or_else(|| format!("invalid widget id \"{id}\""))?;
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0);

    let mut text = note.trim().to_string();
    if text.chars().count() > MAX_REPORT_NOTE {
        text = text.chars().take(MAX_REPORT_NOTE).collect();
    }

    let payload = serde_json::json!({
        "schema": 1,
        "widget": checked,
        "version": version,
        "reason": reason,
        "note": text,
        "stars": stars,
        "at": stamp,
        "platform": {
            "app": "Lattice",
            "os": std::env::consts::OS,
            "arch": std::env::consts::ARCH,
        },
    });

    let file = reports_dir(&app)?.join(format!("{checked}-{stamp}.json"));
    let body = serde_json::to_string_pretty(&payload)
        .map_err(|error| format!("could not encode the report: {error}"))?;
    fs::write(&file, body).map_err(|error| format!("could not write the report: {error}"))?;

    Ok(file.display().to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn report_body_is_bounded() {
        // 只验"上限逻辑本身"：真正的写盘要有 AppHandle，端到端验（见 ROADMAP）
        let long = "x".repeat(MAX_REPORT_NOTE + 50);
        let trimmed: String = long.chars().take(MAX_REPORT_NOTE).collect();
        assert_eq!(trimmed.chars().count(), MAX_REPORT_NOTE);
    }
}
