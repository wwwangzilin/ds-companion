//! 桌面端入口。真正的逻辑全在 lib.rs —— 拆成 lib + bin 是为了让同一个 crate
//! 还能编出 Android 版（Tauri mobile 要求库目标，见 lib.rs 顶部说明）。
//!
//! `windows_subsystem = "windows"` 是**无条件**的（不是 `not(debug_assertions)`）：
//! 加条件会让 debug 构建保留控制台，而开发时跑的正是 debug —— 表现是每次开都弹一个
//! 黑色窗口、还抢焦点。要彻底不弹就得无条件写。
//!
//! 代价：这个子系统下 print!/eprintln! 会 panic（"failed printing to stderr"），
//! 所以非测试代码里一个都不许有，日志一律走 lib.rs 的 shell_log。

#![windows_subsystem = "windows"]

fn main() {
    ds_companion_lib::run()
}
