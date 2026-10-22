//! `lattice-widget://` —— 用户组件的静态文件服务
//!
//! 内置组件的文件在 `public/widgets` 里，跟着前端资源一起打包，
//! `/widgets/<id>/index.html` 这条路径就够用了。
//! 用户装的组件不在那儿：它们在 `%APPDATA%\<identifier>\widgets\<id>\`，
//! 是运行期才出现的文件，前端资源里根本没有。所以开一个自定义协议，
//! 把 iframe 的 src 指过来：
//!
//! ```text
//! Windows / Android : http://lattice-widget.localhost/<id>/<相对路径>
//! macOS / Linux     : lattice-widget://localhost/<id>/<相对路径>
//! ```
//!
//! 路径规则只有一条：**第一段是组件 id，剩下的全部是组件目录内的相对路径**。
//! 任何想跳出自己目录的请求（`..`、盘符、反斜杠）一律 404 ——
//! 一个组件只能读到自己的文件，读不到别的组件，更读不到用户的磁盘。

use std::path::{Path, PathBuf};

use tauri::http::{header, Request, Response, StatusCode};
use tauri::{Runtime, UriSchemeContext};

use crate::widgets;

/// 协议名。前端 `registry.ts` 里有一份同名常量，改这里要一起改。
pub const SCHEME: &str = "lattice-widget";

pub fn handle<R: Runtime>(
    ctx: UriSchemeContext<'_, R>,
    request: Request<Vec<u8>>,
) -> Response<Vec<u8>> {
    let method = request.method().as_str();
    if method != "GET" && method != "HEAD" {
        return empty(StatusCode::METHOD_NOT_ALLOWED);
    }

    let Some((id, relative)) = split_path(request.uri().path()) else {
        return empty(StatusCode::NOT_FOUND);
    };

    let Ok(root) = widgets::user_widgets_dir(ctx.app_handle()) else {
        return empty(StatusCode::INTERNAL_SERVER_ERROR);
    };

    let Some(file) = resolve(&root, &id, &relative) else {
        return empty(StatusCode::NOT_FOUND);
    };

    let Ok(bytes) = std::fs::read(&file) else {
        return empty(StatusCode::NOT_FOUND);
    };
    let length = bytes.len();
    // HEAD 只要头，不必把文件读出来再丢掉
    let body = if method == "HEAD" { Vec::new() } else { bytes };

    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, mime_of(&file))
        .header(header::CONTENT_LENGTH, length)
        // 组件是自己写的，改完刷新就得看到新内容，别缓存
        .header(header::CACHE_CONTROL, "no-cache")
        // iframe 是 sandbox="allow-scripts"，文档源是 opaque 的，
        // 组件 fetch 自己的 json/图片在浏览器看来是跨域 —— 放行
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
        .header("X-Content-Type-Options", "nosniff")
        .body(body)
        .unwrap_or_else(|_| empty(StatusCode::INTERNAL_SERVER_ERROR))
}

fn empty(code: StatusCode) -> Response<Vec<u8>> {
    Response::builder()
        .status(code)
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
        .body(Vec::new())
        .expect("空响应头一定合法")
}

/// `/lattice.todo/index.html` → (`lattice.todo`, `index.html`)
///
/// 返回 None 的几种情况都当作 404 处理，不区分「id 非法」和「文件不存在」：
/// 对组件来说结果一样，对探测者来说少给一点信息。
fn split_path(raw: &str) -> Option<(String, PathBuf)> {
    let trimmed = raw.trim_start_matches('/');
    if trimmed.is_empty() {
        return None;
    }

    let mut parts = trimmed.splitn(2, '/');
    let id = parts.next()?;
    let rest = parts.next().unwrap_or("");
    if !is_safe_id(id) || rest.is_empty() {
        return None;
    }

    let mut relative = PathBuf::new();
    for segment in rest.split('/') {
        let segment = percent_decode(segment)?;
        if segment.is_empty() || segment == "." {
            continue;
        }
        // 这一层的检查是真正防穿越的地方：解码之后再判断，
        // 免得 `%2e%2e` 这类写法绕过
        if segment == ".." || segment.contains('\\') || segment.contains(':') {
            return None;
        }
        relative.push(segment);
    }

    if relative.as_os_str().is_empty() {
        return None;
    }
    Some((id.to_string(), relative))
}

/// 和 `install_widget` 用的是同一套规则
fn is_safe_id(id: &str) -> bool {
    !id.is_empty()
        && id
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '.' || c == '-')
}

/// 把相对路径拼到组件目录下，并确认拼完还在目录里
fn resolve(root: &Path, id: &str, relative: &Path) -> Option<PathBuf> {
    let dir = root.join(id).canonicalize().ok()?;
    let candidate = dir.join(relative).canonicalize().ok()?;
    if !candidate.starts_with(&dir) || !candidate.is_file() {
        return None;
    }
    Some(candidate)
}

fn mime_of(path: &Path) -> &'static str {
    match path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        "html" | "htm" => "text/html; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "json" => "application/json; charset=utf-8",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "avif" => "image/avif",
        "ico" => "image/x-icon",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "ttf" => "font/ttf",
        "otf" => "font/otf",
        "wasm" => "application/wasm",
        "txt" | "md" => "text/plain; charset=utf-8",
        "map" => "application/json; charset=utf-8",
        // 未知类型按二进制发：宁可下载也不要让浏览器猜成 HTML 执行
        _ => "application/octet-stream",
    }
}

/// 只处理 %XX，不处理 `+`（那是 query string 的规则，路径里加号就是加号）
fn percent_decode(input: &str) -> Option<String> {
    if !input.contains('%') {
        return Some(input.to_string());
    }

    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' {
            let hex = input.get(index + 1..index + 3)?;
            out.push(u8::from_str_radix(hex, 16).ok()?);
            index += 3;
        } else {
            out.push(bytes[index]);
            index += 1;
        }
    }
    String::from_utf8(out).ok()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn path_splits_into_id_and_relative() {
        let (id, relative) = split_path("/lattice.todo/index.html").unwrap();
        assert_eq!(id, "lattice.todo");
        assert_eq!(relative, PathBuf::from("index.html"));
    }

    #[test]
    fn nested_entry_keeps_its_subdirectory() {
        let (_, relative) = split_path("/demo/src/app.js").unwrap();
        assert_eq!(relative, PathBuf::from("src").join("app.js"));
    }

    #[test]
    fn traversal_is_rejected() {
        assert!(split_path("/demo/../secret.txt").is_none());
        assert!(split_path("/demo/%2e%2e/secret.txt").is_none());
        assert!(split_path("/demo/..%5csecret.txt").is_none());
        assert!(split_path("/demo/C:/Windows/win.ini").is_none());
    }

    #[test]
    fn bad_ids_are_rejected() {
        assert!(split_path("/Lattice.Todo/index.html").is_none());
        assert!(split_path("/../index.html").is_none());
        assert!(split_path("/").is_none());
    }

    #[test]
    fn percent_decoding_handles_utf8() {
        assert_eq!(percent_decode("%E4%BE%BF%E7%AD%BE.html").unwrap(), "便签.html");
        assert_eq!(percent_decode("a+b").unwrap(), "a+b");
    }

    #[test]
    fn mime_covers_the_usual_suspects() {
        assert_eq!(mime_of(Path::new("a.html")), "text/html; charset=utf-8");
        assert_eq!(mime_of(Path::new("a.WOFF2")), "font/woff2");
        assert_eq!(mime_of(Path::new("a.unknown")), "application/octet-stream");
    }
}
