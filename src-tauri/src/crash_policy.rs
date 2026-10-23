//! 崩溃判定的纯逻辑
//!
//! 从 `crash.rs` 拆出来：那边一进来就要 `tauri` 和 `webview2_com`，本机
//! `cargo test` 跑不起来（安全策略不让往 `target/debug/deps` 写新的 exe），
//! 判定这块就只能靠肉眼 —— 而"判定写错"的后果是死循环（见下）。
//!
//! 拆开之后 `.scratch/crash-test.rs` 用 `rustc --test` 就能把这一组断言真跑一遍。
//!
//! # 为什么"只重载渲染进程和 GPU"
//!
//! 第一版把认不出来的 kind 也当成"挂了"去重载。在 `--in-process-gpu` 下每次
//! 导航都会看到辅助进程退出（实测是 `UTILITY_PROCESS_EXITED`，kind 4），重载
//! 又触发下一次事件 —— 两个窗口在几十秒里各重载了一千多次，日志刷到 1.5MB，
//! 界面一直在闪。
//!
//! 教训：**只有明确知道"重载能修好"的情况才重载**。剩下的记一行就够了；
//! 拿不准时重载的代价是"把一个偶发事件变成死循环"。

use std::time::{Duration, Instant};

/// 60 秒内最多重载几次
pub(crate) const MAX_RELOADS: u32 = 3;
/// 超过这个时长没再崩，就把计数清零（说明它其实能跑）
pub(crate) const COOLDOWN: Duration = Duration::from_secs(60);

/// 一个窗口的崩溃记账
#[derive(Default)]
pub(crate) struct Ledger {
    /// 计数窗口的起点
    pub since: Option<Instant>,
    /// 这个窗口已经重载过几次
    pub reloads: u32,
    /// 已经放弃：不再重载，也不再打日志
    pub gave_up: bool,
    /// 已经报过"不用重载"的那些 kind —— 同类事件可能连着来，别重复刷
    pub reported: Vec<&'static str>,
}

/// 收到一次事件之后该做什么
#[derive(Debug, PartialEq)]
pub(crate) enum Action {
    /// 重载，这是第几次尝试
    Reload(u32),
    /// 不重载，但值得记一行（同类事件只记第一次）
    Report(&'static str),
    /// 放弃：上报主窗口，之后彻底安静
    GiveUp(&'static str),
    /// 什么都不做
    Ignore,
}

/// 判定。纯函数 —— 不碰 COM、不碰日志、不碰窗口，时间由调用方给。
pub(crate) fn decide(kind: &'static str, ledger: &mut Ledger, now: Instant) -> Action {
    // 放弃之后彻底安静：这类事件会持续来，再刷日志只会把有用的行冲掉
    if ledger.gave_up {
        return Action::Ignore;
    }

    /*
     * 只有"重载能修好"的两种才重载。
     *
     * `unresponsive` 不重载：WebView2 自己会尝试恢复，这时候重载反而可能
     * 把用户正在写的草稿一起弄丢。
     * `browser` 不重载：窗口已经废了，重载无从谈起。
     * 其余（utility / sandbox-helper / ppapi / unknown）不是组件挂了。
     */
    if kind != "render" && kind != "gpu" {
        let first_time = !ledger.reported.iter().any(|seen| *seen == kind);
        if first_time {
            ledger.reported.push(kind);
        }
        if kind == "browser" {
            ledger.gave_up = true;
            return Action::GiveUp(kind);
        }
        return if first_time {
            Action::Report(kind)
        } else {
            Action::Ignore
        };
    }

    // 上一次崩溃是很久以前的事：说明它平时能跑，重新计数
    let stale = ledger
        .since
        .map(|at| now.saturating_duration_since(at) > COOLDOWN)
        .unwrap_or(true);
    if stale {
        ledger.since = Some(now);
        ledger.reloads = 0;
    }
    ledger.reloads += 1;

    if ledger.reloads > MAX_RELOADS {
        ledger.gave_up = true;
        return Action::GiveUp(kind);
    }
    Action::Reload(ledger.reloads)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ledger() -> Ledger {
        Ledger::default()
    }

    #[test]
    fn render_crash_reloads() {
        let mut state = ledger();
        assert_eq!(decide("render", &mut state, Instant::now()), Action::Reload(1));
    }

    #[test]
    fn gpu_crash_reloads() {
        let mut state = ledger();
        assert_eq!(decide("gpu", &mut state, Instant::now()), Action::Reload(1));
    }

    /// 这条是那个死循环的回归测试：辅助进程退出不是组件挂了
    #[test]
    fn utility_exit_never_reloads() {
        let mut state = ledger();
        assert_eq!(decide("utility", &mut state, Instant::now()), Action::Report("utility"));
        // 同类事件连着来，只记第一次
        assert_eq!(decide("utility", &mut state, Instant::now()), Action::Ignore);
        assert_eq!(decide("utility", &mut state, Instant::now()), Action::Ignore);
    }

    #[test]
    fn other_auxiliary_processes_never_reload() {
        for kind in ["sandbox-helper", "ppapi-plugin", "ppapi-broker", "unknown", "unrecognized"] {
            let mut state = ledger();
            assert_eq!(decide(kind, &mut state, Instant::now()), Action::Report(kind), "{kind}");
        }
    }

    #[test]
    fn unresponsive_only_reports() {
        let mut state = ledger();
        assert_eq!(
            decide("unresponsive", &mut state, Instant::now()),
            Action::Report("unresponsive")
        );
    }

    #[test]
    fn browser_exit_gives_up_immediately() {
        let mut state = ledger();
        assert_eq!(decide("browser", &mut state, Instant::now()), Action::GiveUp("browser"));
        // 之后彻底安静
        assert_eq!(decide("render", &mut state, Instant::now()), Action::Ignore);
    }

    #[test]
    fn gives_up_after_three_reloads() {
        let mut state = ledger();
        let now = Instant::now();
        assert_eq!(decide("render", &mut state, now), Action::Reload(1));
        assert_eq!(decide("render", &mut state, now), Action::Reload(2));
        assert_eq!(decide("render", &mut state, now), Action::Reload(3));
        assert_eq!(decide("render", &mut state, now), Action::GiveUp("render"));
        // 放弃之后连日志都不打
        assert_eq!(decide("render", &mut state, now), Action::Ignore);
    }

    #[test]
    fn counter_resets_after_the_cooldown() {
        let mut state = ledger();
        let start = Instant::now();
        assert_eq!(decide("render", &mut state, start), Action::Reload(1));
        assert_eq!(decide("render", &mut state, start), Action::Reload(2));
        // 安静了两分钟：说明它其实能跑，重新计数
        let later = start + Duration::from_secs(120);
        assert_eq!(decide("render", &mut state, later), Action::Reload(1));
    }

    #[test]
    fn fresh_window_starts_at_one() {
        let mut state = ledger();
        // since 是 None（从没崩过）—— 不该被当成"很久以前"，直接算第一次
        assert_eq!(decide("render", &mut state, Instant::now()), Action::Reload(1));
    }
}
