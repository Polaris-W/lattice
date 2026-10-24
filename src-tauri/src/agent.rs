//! Agent 接入：一个只听 127.0.0.1 的 HTTP 端点。
//!
//! ## 为什么是 HTTP，不是命名管道
//!
//! 命名管道不开端口、不弹防火墙，但只有 Windows 客户端能用 —— 而 agent 宿主
//! 可能跑在 WSL 里、可能是 `curl`、可能是某个用 Go 写的 MCP 服务。HTTP 是唯一
//! 一个"任何东西都会说"的协议。代价是端口，所以：只绑 `127.0.0.1`、端口取 0
//! （由系统分配，不撞车）、默认关闭、每个请求都要令牌。
//!
//! ## 权威状态在前端，不在这里
//!
//! `state.json` 是**整份覆盖**写的（见 `state.rs`），内存里那份才是权威。
//! 所以这个模块不自己读写布局，它把请求转成一条事件发给主窗口，等前端回话，
//! 再把前端给的 JSON 原样当响应体发回去。
//!
//! 这条往返是**故意**的：任何"后端自己改 state.json"的捷径都会和前端内存里的
//! 那份打架，而这个项目已经被孤儿进程这么咬过一次。
//!
//! ## 令牌的边界（别高估它）
//!
//! 令牌文件就在 `%APPDATA%` 下，**同一个账户下的任何进程都读得到**。它挡的是
//! 别的用户、以及网络上过来的东西，挡不住你自己账户里跑着的程序。真正的防线
//! 是：默认关、动作白名单只有 8 个、每一步都进审计日志。

use std::collections::HashMap;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::mpsc::{self, Sender};
use std::sync::Mutex;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};

use crate::agent_policy::{self, ParseError};

/// 发给主窗口的事件名。前端 `platform/agent.ts` 监听它。
pub const EVENT: &str = "lattice:agent";

/// 前端回话的上限。布局操作都是同步的，8 秒还没回来说明主窗口卡住了。
const REPLY_TIMEOUT: Duration = Duration::from_secs(8);
/// accept 循环的空转间隔。也是"关掉之后多久真的不听了"的上界。
const POLL: Duration = Duration::from_millis(120);
/// 同时处理的连接数上限。本机 agent 是串行干活的，8 条已经过分了。
const MAX_CONNECTIONS: usize = 8;
const READ_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Default)]
pub struct Agent {
    enabled: Mutex<bool>,
    token: Mutex<Option<String>>,
    port: Mutex<Option<u16>>,
    /// 等在途的前端回话：id → 发送端
    pending: Mutex<HashMap<String, Sender<String>>>,
    seq: AtomicU64,
    active: AtomicUsize,
}

#[derive(Serialize, Deserialize, Default)]
struct Config {
    #[serde(default)]
    enabled: bool,
}

#[derive(Serialize)]
pub struct Status {
    enabled: bool,
    /// 正在听才有值；端口由系统分配，每次开启都可能不同
    port: Option<u16>,
    token: Option<String>,
}

// ---------------------------------------------------------------------------
// 落盘
// ---------------------------------------------------------------------------

fn agent_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let base = app
        .path()
        .app_config_dir()
        .map_err(|error| format!("could not resolve the config directory: {error}"))?;
    let dir = base.join("agent");
    std::fs::create_dir_all(&dir).map_err(|error| format!("failed to create {}: {error}", dir.display()))?;
    Ok(dir)
}

fn read_config(app: &AppHandle) -> Config {
    let Ok(dir) = agent_dir(app) else {
        return Config::default();
    };
    // 读坏了就当关闭：一个打不开的配置文件不该变成"意外开启的端口"
    std::fs::read_to_string(dir.join("config.json"))
        .ok()
        .and_then(|text| serde_json::from_str::<Config>(&text).ok())
        .unwrap_or_default()
}

fn write_config(app: &AppHandle, config: &Config) -> Result<(), String> {
    let dir = agent_dir(app)?;
    let text = serde_json::to_string_pretty(config).map_err(|error| format!("could not encode config: {error}"))?;
    std::fs::write(dir.join("config.json"), text).map_err(|error| format!("failed to save the config: {error}"))
}

/// 令牌生成一次就固定下来。每次重启换一把，等于用户每重启一次就要去改一次
/// agent 那边的配置 —— 那会让这个功能没人用。
fn ensure_token(app: &AppHandle) -> Result<String, String> {
    if let Some(token) = app.state::<Agent>().token.lock().unwrap().clone() {
        return Ok(token);
    }
    let dir = agent_dir(app)?;
    let path = dir.join("token");
    if let Ok(text) = std::fs::read_to_string(&path) {
        let token = text.trim().to_ascii_lowercase();
        if token.len() == 64 && token.chars().all(|c| c.is_ascii_hexdigit()) {
            *app.state::<Agent>().token.lock().unwrap() = Some(token.clone());
            return Ok(token);
        }
    }
    let mut bytes = [0u8; 32];
    getrandom::getrandom(&mut bytes).map_err(|error| format!("no system randomness available: {error}"))?;
    let token = agent_policy::token_from_bytes(&bytes);
    std::fs::write(&path, &token).map_err(|error| format!("failed to save the token: {error}"))?;
    *app.state::<Agent>().token.lock().unwrap() = Some(token.clone());
    Ok(token)
}

/// 给 CLI / agent 看的那个文件：端口和令牌放在一起，一个文件就能连上。
fn write_endpoint(app: &AppHandle, port: u16, token: &str) -> Result<(), String> {
    let dir = agent_dir(app)?;
    let text = serde_json::to_string_pretty(&json!({
        "url": format!("http://127.0.0.1:{port}/rpc"),
        "health": format!("http://127.0.0.1:{port}/health"),
        "port": port,
        "token": token,
    }))
    .map_err(|error| format!("could not encode endpoint: {error}"))?;
    std::fs::write(dir.join("endpoint.json"), text).map_err(|error| format!("failed to save the endpoint: {error}"))
}

fn clear_endpoint(app: &AppHandle) {
    if let Ok(dir) = agent_dir(app) {
        let _ = std::fs::remove_file(dir.join("endpoint.json"));
    }
}

/// 一行一条 JSON。**不做轮转**：一天点几十次也就几十 KB，而轮转代码本身
/// 是个没人会去读的角落。
fn audit(app: &AppHandle, op: &str, detail: &str, status: u16, ms: u128) {
    let Ok(dir) = agent_dir(app) else {
        return;
    };
    let at = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let line = json!({ "at": at, "op": op, "detail": detail, "status": status, "ms": ms }).to_string();
    use std::io::Write as _;
    if let Ok(mut file) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(dir.join("audit.log"))
    {
        let _ = writeln!(file, "{line}");
    }
}

// ---------------------------------------------------------------------------
// 生命周期
// ---------------------------------------------------------------------------

/// 启动时按磁盘上的配置决定要不要听。关着的时候**不 bind**，
/// 不是"绑上但拒绝" —— 端口开着就是开着了，拒绝逻辑写错一次就漏一次。
pub fn start(app: AppHandle) {
    let config = read_config(&app);
    *app.state::<Agent>().enabled.lock().unwrap() = config.enabled;
    if config.enabled {
        if let Err(error) = listen(&app) {
            eprintln!("[lattice] agent endpoint did not start: {error}");
            *app.state::<Agent>().enabled.lock().unwrap() = false;
        }
    }
}

fn listen(app: &AppHandle) -> Result<u16, String> {
    let token = ensure_token(app)?;
    let listener = TcpListener::bind(("127.0.0.1", 0))
        .map_err(|error| format!("could not bind 127.0.0.1: {error}"))?;
    let port = listener
        .local_addr()
        .map_err(|error| format!("could not read the bound address: {error}"))?
        .port();
    listener
        .set_nonblocking(true)
        .map_err(|error| format!("could not make the listener non-blocking: {error}"))?;

    write_endpoint(app, port, &token)?;
    *app.state::<Agent>().port.lock().unwrap() = Some(port);

    let handle = app.clone();
    std::thread::spawn(move || accept_loop(handle, listener, port));
    Ok(port)
}

fn accept_loop(app: AppHandle, listener: TcpListener, port: u16) {
    loop {
        // 关掉之后最迟 POLL 就退出，端口跟着 listener 一起释放
        if !*app.state::<Agent>().enabled.lock().unwrap() {
            break;
        }
        match listener.accept() {
            Ok((stream, _)) => {
                let handle = app.clone();
                std::thread::spawn(move || {
                    let state = handle.state::<Agent>();
                    if state.active.fetch_add(1, Ordering::SeqCst) >= MAX_CONNECTIONS {
                        state.active.fetch_sub(1, Ordering::SeqCst);
                        write_all(&stream, 503, r#"{"ok":false,"code":"busy","error":"too many connections"}"#);
                        return;
                    }
                    serve(&handle, stream);
                    handle.state::<Agent>().active.fetch_sub(1, Ordering::SeqCst);
                });
            }
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {}
            Err(error) => eprintln!("[lattice] agent accept failed: {error}"),
        }
        std::thread::sleep(POLL);
    }

    // 退出时把"我在这儿"的痕迹擦掉，否则 CLI 会连一个已经没人听的端口
    *app.state::<Agent>().port.lock().unwrap() = None;
    clear_endpoint(&app);
    eprintln!("[lattice] agent endpoint on 127.0.0.1:{port} stopped");
}

// ---------------------------------------------------------------------------
// 请求处理
// ---------------------------------------------------------------------------

fn serve(app: &AppHandle, mut stream: TcpStream) {
    let started = Instant::now();
    let _ = stream.set_read_timeout(Some(READ_TIMEOUT));
    let _ = stream.set_write_timeout(Some(READ_TIMEOUT));

    let mut buffer: Vec<u8> = Vec::new();
    let mut chunk = [0u8; 4096];

    let request = loop {
        match agent_policy::parse_request(&buffer) {
            Ok(request) => break request,
            Err(ParseError::Incomplete) => {
                if buffer.len() > agent_policy::MAX_HEAD + agent_policy::MAX_BODY + 4 {
                    write_all(&stream, 413, r#"{"ok":false,"code":"too_large","error":"request exceeds the size limit"}"#);
                    audit(app, "raw", "oversized", 413, started.elapsed().as_millis());
                    return;
                }
                match stream.read(&mut chunk) {
                    Ok(0) => {
                        // 对面连上就关：不回话，也不记审计（那不是一次调用）
                        return;
                    }
                    Ok(read) => buffer.extend_from_slice(&chunk[..read]),
                    Err(error)
                        if matches!(
                            error.kind(),
                            std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                        ) =>
                    {
                        write_all(&stream, 400, r#"{"ok":false,"code":"bad_request","error":"timed out reading the request"}"#);
                        return;
                    }
                    Err(_) => return,
                }
            }
            Err(ParseError::TooLarge) => {
                write_all(&stream, 413, r#"{"ok":false,"code":"too_large","error":"request exceeds the size limit"}"#);
                audit(app, "raw", "oversized", 413, started.elapsed().as_millis());
                return;
            }
            Err(ParseError::Malformed(reason)) => {
                let body = json!({ "ok": false, "code": "bad_request", "error": reason }).to_string();
                write_all(&stream, 400, &body);
                audit(app, "raw", reason, 400, started.elapsed().as_millis());
                return;
            }
        }
    };

    let (status, body, detail) = dispatch(app, &request);
    write_all(&stream, status, &body);
    audit(app, &request.path, &detail, status, started.elapsed().as_millis());
}

fn dispatch(app: &AppHandle, request: &agent_policy::Request) -> (u16, String, String) {
    let token = app.state::<Agent>().token.lock().unwrap().clone().unwrap_or_default();
    if token.is_empty() {
        return (
            503,
            json!({ "ok": false, "code": "not_ready", "error": "the endpoint has no token yet" }).to_string(),
            "no-token".to_string(),
        );
    }
    if !agent_policy::authorized(request.authorization.as_deref(), &token) {
        // 401 只说明令牌不对，不说明哪个对 —— 别回显任何东西
        return (
            401,
            json!({ "ok": false, "code": "unauthorized", "error": "missing or wrong bearer token" }).to_string(),
            "unauthorized".to_string(),
        );
    }

    if request.path == "/health" {
        return (200, json!({ "ok": true, "app": "lattice" }).to_string(), "health".to_string());
    }
    if request.path != "/rpc" {
        return (
            404,
            json!({ "ok": false, "code": "not_found", "error": "only /rpc and /health exist" }).to_string(),
            request.path.clone(),
        );
    }
    if request.method != "POST" {
        return (
            405,
            json!({ "ok": false, "code": "method_not_allowed", "error": "/rpc is POST only" }).to_string(),
            request.method.clone(),
        );
    }

    let body: Value = match serde_json::from_str(&request.body) {
        Ok(value) => value,
        Err(error) => {
            return (
                400,
                json!({ "ok": false, "code": "bad_request", "error": format!("body is not JSON: {error}") }).to_string(),
                "bad-json".to_string(),
            )
        }
    };

    let op = body.get("op").and_then(Value::as_str).unwrap_or("").to_string();
    match op.as_str() {
        "state" => forward(app, json!({ "op": "state" }), "state".to_string()),

        "act" => {
            let name = body.get("action").and_then(Value::as_str).unwrap_or("").to_string();
            if agent_policy::parse_action(&name).is_none() {
                // 说清楚是"没这个动作"还是"这个动作永远不给"，
                // 否则 agent 会一直重试一个它其实永远做不到的事
                let denied = agent_policy::DENIED.iter().find(|(denied, _)| *denied == name);
                let message = match denied {
                    Some((_, why)) => format!("{name} is never available to an agent: {why}"),
                    None => format!("unknown action {name:?}"),
                };
                return (
                    403,
                    json!({ "ok": false, "code": "forbidden", "error": message }).to_string(),
                    name,
                );
            }
            let args = body.get("args").cloned().unwrap_or(Value::Null);
            forward(app, json!({ "op": "act", "action": name, "args": args }), name)
        }

        // 第二层（组件工具）协议先占着位置：宁可现在回一句"还没做"，
        // 也不要等接进来的时候临时发明一个形状
        "tool" => (
            200,
            json!({
                "ok": false,
                "code": "unsupported",
                "error": "widget tools are not wired up yet — see docs/AGENT_ACCESS.md"
            })
            .to_string(),
            "tool".to_string(),
        ),

        other => (
            400,
            json!({ "ok": false, "code": "bad_request", "error": format!("unknown op {other:?}; expected state, act or tool") })
                .to_string(),
            other.to_string(),
        ),
    }
}

/// 把请求转给主窗口，等它回话。
///
/// 回话体是**前端给的 JSON 原样** —— 后端不解释结果，也就不需要为每个动作
/// 维护一份返回结构。少一层转译，少一处会不一致的地方。
fn forward(app: &AppHandle, payload: Value, detail: String) -> (u16, String, String) {
    match call_frontend(app, payload) {
        Ok(body) => {
            // 前端自己会给出 ok 字段；它说失败就还是 200（请求确实被处理了），
            // 只有"没答上来"才是 5xx
            (200, body, detail)
        }
        Err(error) => {
            let code = if error.starts_with("timeout") { "timeout" } else { "window_unreachable" };
            (
                503,
                json!({ "ok": false, "code": code, "error": error }).to_string(),
                detail,
            )
        }
    }
}

fn call_frontend(app: &AppHandle, payload: Value) -> Result<String, String> {
    let state = app.state::<Agent>();
    let id = format!("{}-{}", std::process::id(), state.seq.fetch_add(1, Ordering::SeqCst));
    let (tx, rx) = mpsc::channel::<String>();
    state.pending.lock().unwrap().insert(id.clone(), tx);

    if let Err(error) = app.emit(EVENT, json!({ "id": id, "request": payload })) {
        state.pending.lock().unwrap().remove(&id);
        return Err(format!("could not emit to the window: {error}"));
    }

    match rx.recv_timeout(REPLY_TIMEOUT) {
        Ok(body) => Ok(body),
        Err(_) => {
            state.pending.lock().unwrap().remove(&id);
            Err("timeout: the main window did not answer in time".to_string())
        }
    }
}

fn write_all(stream: &TcpStream, status: u16, body: &str) {
    let raw = agent_policy::response(status, body);
    let mut stream = stream;
    let _ = stream.write_all(&raw);
    let _ = stream.flush();
}

// ---------------------------------------------------------------------------
// 命令
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn agent_status(app: AppHandle) -> Status {
    let state = app.state::<Agent>();
    Status {
        enabled: *state.enabled.lock().unwrap(),
        port: *state.port.lock().unwrap(),
        token: state.token.lock().unwrap().clone(),
    }
}

/// 开关。**这是人在界面上按的**，不在 agent 的白名单里 ——
/// agent 能自己给自己开门的话，前面所有闸门就都白设了。
#[tauri::command]
pub fn agent_set_enabled(app: AppHandle, enabled: bool) -> Result<Status, String> {
    let state = app.state::<Agent>();

    if enabled {
        ensure_token(&app)?;
        write_config(&app, &Config { enabled: true })?;
        *state.enabled.lock().unwrap() = true;
        if state.port.lock().unwrap().is_none() {
            listen(&app)?;
        }
    } else {
        write_config(&app, &Config { enabled: false })?;
        *state.enabled.lock().unwrap() = false;
        // 等 accept 循环退出（最迟一个 POLL）。返回的状态必须是"真的已经不听"，
        // 否则界面上关掉了、端口还开着
        for _ in 0..20 {
            if state.port.lock().unwrap().is_none() {
                break;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
    }

    Ok(agent_status(app))
}

/// 前端回话。带 id 是因为可能同时有好几条在途。
#[tauri::command]
pub fn agent_reply(app: AppHandle, id: String, payload: String) {
    if let Some(tx) = app.state::<Agent>().pending.lock().unwrap().remove(&id) {
        let _ = tx.send(payload);
    }
}
