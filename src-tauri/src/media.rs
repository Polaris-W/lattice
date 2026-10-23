//! 媒体控制：读当前播放、按一下播放/暂停、上一首/下一首。
//!
//! # 这是什么
//!
//! Windows 的 SMTC（System Media Transport Controls）—— 按音量键时左上角那个
//! 浮层背后那套东西。任何走系统媒体会话的播放器（Spotify、Edge、网易云、
//! foobar2000……）都会出现在里面，我们只要问系统"现在是谁在放"就行。
//!
//! # 为什么走 WinRT 而不是 Win32
//!
//! 这套 API 只有 WinRT 一份。`Cargo.toml` 里本来就有 `windows` crate（读 PWSTR
//! 用的），把 `Media_Control` 这个 feature 打开就够了，不用引新的依赖。
//!
//! # COM 必须按线程初始化
//!
//! WinRT 激活要求调用线程已经 `CoInitializeEx`。命令跑在 tokio 的阻塞线程池上，
//! 那些线程没初始化过 —— 所以每次调用先初始化一次。重复初始化是允许的
//! （同模式返回 `S_FALSE`），代价可以忽略；**不初始化**的话报的是
//! `RPC_E_NOT_INITIALIZED`，看起来像"这台机器不支持媒体控制"。
//!
//! 已经用别的模式初始化过（`RPC_E_CHANGED_MODE`，比如 Tauri 主线程上的 STA）
//! 也不能当失败：那种情况下 WinRT 照样能用，只是不能再改模式。所以这里
//! 故意不看返回值。
//!
//! # 没有超时
//!
//! `join()` 会一直等到播放器回话。理论上某个播放器卡住能让这次调用挂住 ——
//! 真挂住了，组件侧那条 3 秒的桥超时会先放弃并显示"读不到"，界面不会跟着卡。
//! 加超时要么引 tokio 的 timer，要么每次开一条线程，两样都比这点风险重。

use serde::Serialize;
use windows::Media::Control::GlobalSystemMediaTransportControlsSessionManager as SessionManager;
use windows::Win32::System::Com::{CoInitializeEx, COINIT_MULTITHREADED};

/// 一次媒体会话的快照。
///
/// 字段名走 camelCase 给组件看；`status` 用字符串而不是数字 —— 组件里
/// 写 `status === "playing"` 比记 `4` 好读得多，而这个值本来也不会高频变化。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MediaSession {
    pub title: String,
    pub artist: String,
    pub album: String,
    /// 播放器的 AUMID，例如 `Spotify.exe`
    pub source: String,
    /// playing / paused / stopped / changing / opened / closed
    pub status: &'static str,
    pub can_play_pause: bool,
    pub can_next: bool,
    pub can_previous: bool,
    /// 播放进度（毫秒），`duration_ms` 为 0 时无意义
    pub position_ms: i64,
    pub duration_ms: i64,
}

/// 组件能做的四个动作。`toggle` 是"播放/暂停"合一 —— 组件不知道当前状态时
/// 用它最省事，也是系统音量键的行为。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Action {
    PlayPause,
    Next,
    Previous,
    Stop,
}

impl Action {
    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "playPause" | "toggle" | "play_pause" => Some(Self::PlayPause),
            "next" => Some(Self::Next),
            "previous" | "prev" => Some(Self::Previous),
            "stop" => Some(Self::Stop),
            _ => None,
        }
    }
}

fn init_com() {
    // SAFETY: 只是初始化本线程的 COM 单元。返回值故意丢弃：
    // RPC_E_CHANGED_MODE（已经用别的模式初始化过）不影响 WinRT 激活。
    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
    }
}

fn manager() -> Result<SessionManager, String> {
    init_com();
    SessionManager::RequestAsync()
        .and_then(|operation| operation.join())
        .map_err(|error| format!("could not reach the media session manager: {error}"))
}

/// 现在有没有人在放东西。没有会话时返回 `Ok(None)` —— 那是正常状态，
/// 不是错误：桌面上没开播放器的时候组件该显示"没在放"，而不是红字。
pub fn current() -> Result<Option<MediaSession>, String> {
    let manager = manager()?;
    // GetCurrentSession 在没有会话时返回错误，这里用 ok() 收掉
    let Some(session) = manager.GetCurrentSession().ok() else {
        return Ok(None);
    };

    let properties = session
        .TryGetMediaPropertiesAsync()
        .and_then(|operation| operation.join())
        .map_err(|error| format!("could not read the media properties: {error}"))?;

    let status = session
        .GetPlaybackInfo()
        .and_then(|info| info.PlaybackStatus())
        .map(playback_status)
        .unwrap_or("closed");

    // 控件可用性是"这个播放器支不支持按" —— 不支持的按钮组件就别画了
    let controls = session.GetPlaybackInfo().and_then(|info| info.Controls()).ok();
    let can_play_pause = controls
        .as_ref()
        .and_then(|controls| controls.IsPlayPauseToggleEnabled().ok())
        .unwrap_or(false);
    let can_next = controls
        .as_ref()
        .and_then(|controls| controls.IsNextEnabled().ok())
        .unwrap_or(false);
    let can_previous = controls
        .as_ref()
        .and_then(|controls| controls.IsPreviousEnabled().ok())
        .unwrap_or(false);

    let (position_ms, duration_ms) = session
        .GetTimelineProperties()
        .map(|timeline| {
            // TimeSpan 的单位是 100ns
            let position = timeline.Position().map(|value| value.Duration / 10_000).unwrap_or(0);
            let end = timeline.EndTime().map(|value| value.Duration / 10_000).unwrap_or(0);
            (position, end)
        })
        .unwrap_or((0, 0));

    Ok(Some(MediaSession {
        title: string_of(properties.Title()),
        artist: string_of(properties.Artist()),
        album: string_of(properties.AlbumTitle()),
        source: string_of(session.SourceAppUserModelId()),
        status,
        can_play_pause,
        can_next,
        can_previous,
        position_ms,
        duration_ms,
    }))
}

/// 按一下。返回"系统接受了这个动作"—— 播放器可能拒绝（`false`），
/// 比如已经暂停时按下一首。
pub fn control(action: Action) -> Result<bool, String> {
    let manager = manager()?;
    let Some(session) = manager.GetCurrentSession().ok() else {
        return Err("no media session is active".to_string());
    };

    let operation = match action {
        Action::PlayPause => session.TryTogglePlayPauseAsync(),
        Action::Next => session.TrySkipNextAsync(),
        Action::Previous => session.TrySkipPreviousAsync(),
        Action::Stop => session.TryStopAsync(),
    };

    operation
        .and_then(|operation| operation.join())
        .map_err(|error| format!("the media session refused the request: {error}"))
}

fn playback_status(status: windows::Media::Control::GlobalSystemMediaTransportControlsSessionPlaybackStatus) -> &'static str {
    use windows::Media::Control::GlobalSystemMediaTransportControlsSessionPlaybackStatus as Status;
    match status {
        Status::Playing => "playing",
        Status::Paused => "paused",
        Status::Stopped => "stopped",
        Status::Changing => "changing",
        Status::Opened => "opened",
        _ => "closed",
    }
}

/// HSTRING → String。读不到就空串：标题缺失不该让整次调用失败。
fn string_of(value: windows::core::Result<windows::core::HSTRING>) -> String {
    value.map(|text| text.to_string()).unwrap_or_default()
}

// ---------------------------------------------------------------------------
// Tauri 命令
// ---------------------------------------------------------------------------

#[tauri::command]
pub async fn media_session() -> Result<Option<MediaSession>, String> {
    // 阻塞调用不能占着异步运行时：丢给阻塞线程池
    tauri::async_runtime::spawn_blocking(current)
        .await
        .map_err(|error| format!("media task failed: {error}"))?
}

#[tauri::command]
pub async fn media_control(action: String) -> Result<bool, String> {
    let parsed = Action::parse(&action)
        .ok_or_else(|| format!("unknown media action \"{action}\" (playPause / next / previous / stop)"))?;
    tauri::async_runtime::spawn_blocking(move || control(parsed))
        .await
        .map_err(|error| format!("media task failed: {error}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_the_documented_action_names() {
        assert_eq!(Action::parse("playPause"), Some(Action::PlayPause));
        assert_eq!(Action::parse("next"), Some(Action::Next));
        assert_eq!(Action::parse("previous"), Some(Action::Previous));
        assert_eq!(Action::parse("stop"), Some(Action::Stop));
    }

    #[test]
    fn rejects_unknown_actions() {
        assert_eq!(Action::parse("rewind"), None);
        assert_eq!(Action::parse(""), None);
    }
}
