//! 自启命令行的两个纯函数：怎么写成 `Run` 值、怎么从 `Run` 值读回路径。
//!
//! # 为什么单独拆一个文件
//!
//! `autostart.rs` 一半是 `RegOpenKeyExW` 之类的 Win32，`cargo test` 在这台机器上
//! 又链接不出来（安全策略拦 `target/debug/deps` 下新写的 exe）。把"拼字符串 /
//! 剥字符串"这一步拆出来，它就不依赖任何东西了，能用 `rustc --test` 单独跑。
//!
//! # 为什么要成对
//!
//! 写进去和读回来必须是同一套规则，否则"自启已开启"会显示成"路径已失效"：
//!
//! - 写：`"C:\Program Files\Lattice\lattice.exe"` —— **必须带引号**。
//!   `Run` 的值会被系统当命令行拆，路径里有空格又不带引号，拆出来就是
//!   `C:\Program` + `Files\Lattice\lattice.exe`，开机直接报找不到文件。
//! - 读：可能带引号、可能裸着（早期版本 / 用户手改过）、也可能带参数
//!   （`"…\lattice.exe" --minimized`）。路径到第二个引号为止，参数丢掉。
//!
//! 下面那条 `round_trip` 单测就是钉这件事的。

/// 拼出要写进 `Run` 的命令行：路径加引号，不带参数。
///
/// 所有调用点都走这个函数，别再在别处手写 `format!("\"{exe}\"")` ——
/// 引号写漏一处，症状是"开机自启打开了但没反应"，而且只在路径含空格时复现。
pub(crate) fn run_command(exe: &str) -> String {
    format!("\"{exe}\"")
}

/// 从命令行里剥出 exe 路径：可能带引号，也可能裸着。
pub(crate) fn command_path(command: &str) -> String {
    let trimmed = command.trim();
    if let Some(rest) = trimmed.strip_prefix('"') {
        if let Some(end) = rest.find('"') {
            return rest[..end].to_string();
        }
        return rest.to_string();
    }
    trimmed.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn quoted_command_yields_the_path() {
        assert_eq!(
            command_path(r#""C:\Program Files\Lattice\lattice.exe""#),
            r"C:\Program Files\Lattice\lattice.exe"
        );
    }

    #[test]
    fn bare_command_is_left_alone() {
        assert_eq!(command_path(r"C:\Lattice\lattice.exe"), r"C:\Lattice\lattice.exe");
    }

    #[test]
    fn trailing_arguments_are_dropped() {
        // 早期版本可能写进过带参数的形式，读的时候不该把参数当成路径的一部分
        assert_eq!(
            command_path(r#""C:\Lattice\lattice.exe" --minimized"#),
            r"C:\Lattice\lattice.exe"
        );
    }

    #[test]
    fn a_path_with_spaces_survives_the_round_trip() {
        // 这条是整套规则的意义：写进去的那一份必须能原样读回来
        let exe = r"C:\Program Files\Lattice\lattice.exe";
        assert_eq!(command_path(&run_command(exe)), exe);
    }

    #[test]
    fn an_unterminated_quote_still_gives_a_path() {
        // 手改注册表改坏了（只留了开头那个引号）也不该读出空串
        assert_eq!(command_path(r#""C:\Lattice\lattice.exe"#), r"C:\Lattice\lattice.exe");
    }
}
