/// 扫描 `assets/avatars/` 里的内置立绘差分，生成一张 (变体名, 字节) 表。
///
/// 【为什么用 codegen 而不是手写 include_bytes!】差分素材是主人**自己生成后丢进来的** ——
/// 手写的话少一张就编不过（`include_bytes!` 找不到文件直接报错），而扫描式是
/// 「丢进来就带上，还没生成的自动跳过」，于是只出了 neutral + happy 两张也能立刻用。
fn emit_avatar_assets() {
    use std::fmt::Write as _;
    let dir = std::path::Path::new("assets/avatars");
    let dest = std::path::Path::new(&std::env::var("OUT_DIR").expect("OUT_DIR 缺失"))
        .join("avatar_assets.rs");

    let mut names: Vec<String> = Vec::new();
    if let Ok(entries) = std::fs::read_dir(dir) {
        for e in entries.flatten() {
            let Some(name) = e.file_name().to_str().map(|s| s.to_string()) else {
                continue;
            };
            // 只认 `deepseek-<变体>.png`：内置角色的表情差分
            if name.starts_with("deepseek-") && name.ends_with(".png") {
                names.push(name);
            }
        }
    }
    names.sort();

    let mut code = String::from(
        "/// 内置立绘差分表 —— 由 build.rs 扫描 assets/avatars/ 生成，**不要手改**。\n\
         pub static BUILTIN_VARIANTS: &[(&str, &[u8])] = &[\n",
    );
    for name in &names {
        let variant = name.trim_start_matches("deepseek-").trim_end_matches(".png");
        let _ = writeln!(
            code,
            "    ({:?}, include_bytes!(concat!(env!(\"CARGO_MANIFEST_DIR\"), \"/assets/avatars/{}\"))),",
            variant, name
        );
    }
    code.push_str("];\n");
    std::fs::write(&dest, code).expect("写 avatar_assets.rs 失败");
    // 目录变了要重跑（新增/替换素材时自动带上）
    println!("cargo:rerun-if-changed=assets/avatars");
}

fn main() {
    emit_avatar_assets();
    // 自定义命令必须显式声明 ACL，否则调用会被拒
    // （远程来源：`probe_report not allowed. Plugin not found`；
    //  一旦有了 app manifest，本地窗口也一样要走 ACL）。
    // AppManifest::commands 会为每个命令生成 allow-<slug> / deny-<slug>，
    // capability 里再引用（无前缀 = 应用级 ACL）。
    tauri_build::try_build(
        tauri_build::Attributes::new().app_manifest(tauri_build::AppManifest::new().commands(&[
            // 页面可用（最小面）：写日志 / 读注入配置 / 开设置 / 记忆热度记账 / 记忆落盘
            // 注意 memory_ingest 只增不删 —— 删除仍然只有设置窗口能做
            "dsc_log",
            "dsc_get_config",
            "open_settings",
            "memory_touch",
            "memory_ingest",
            // 页面侧的角色状态：回报一轮 / 感知额度预约与落盘 / 空闲主动 / 任务栏提醒
            "dsc_turn_report",
            "dsc_roster_touch",
            "dsc_front_app",
            "dsc_screen_state",
            "dsc_screen_now",
            "dsc_screen_see",
            "dsc_sense_reserve",
            "dsc_sense_apply",
            "dsc_proactive",
            "dsc_proactive_done",
            "dsc_attention",
            "dsc_state_get",
            "user_state_get",
            // 只给本地设置窗口
            "persona_list",
            "persona_get",
            "persona_save",
            "persona_delete",
            "dsh_preset_scan",
            "dsh_preset_import",
            "config_get",
            "config_set",
            "memory_list",
            "memory_save",
            "memory_delete",
            "memory_extract",
            "state_get",
            "state_save",
            "state_reset",
            "state_feed",
            "user_state_save",
            "user_state_reset",
            // 设置窗口：日志 / 常驻 / 退出
            "log_tail",
            "log_clear",
            "log_reveal",
            // 数据目录（隔离可见化：设置界面显示 + 验收脚本门禁）
            "data_dir",
            "data_reveal",
            "trash_prune",
            "autostart_get",
            "autostart_set",
            "app_quit",
            "window_show_main",
            "settings_take_tab",
            // 对话留档 / 自我修订
            "dsc_chat_append",
            "chat_recent",
            "dsc_review_reserve",
            "dsc_review_submit",
            "review_now",
            "proposal_list",
            "proposal_accept",
            "proposal_reject",
            "chat_days",
            "chat_read_day",
            // 工具层：页面（远程）只给 invoke / brief / wrap —— 其余留设置窗口。
            // 这三条本身不碰文件：真正的沙箱与白名单在 Rust 的 tools::run 里。
            "dsc_tool_invoke",
            "dsc_tools_brief",
            "dsc_tool_wrap",
            "tools_status",
            "tools_set_workspace",
            "tools_set_enabled",
            "tools_log_tail",
            // 写工具（人工确认）：页面要能读待确认、并把"主人点的那一下"送回来；
            // 它只能决定一条已存在的提案，造不出新提案（提案只由 write_file 产生）。
            "tools_set_write_enabled",
            "tool_pending_list",
            "dsc_tool_proposal_decide",
            // 托盘自检：把"菜单上现在写着什么"读出来（托盘是看不见的界面，
            // 没有这条就只能靠肉眼验，验收脚本够不着）
            "tray_snapshot",
            // 日报：把今天拼成一段人话（设置页「今天」卡片 + 托盘菜单）
            "daily_digest",
            // 她自己的日记：页面侧让模型写完、把那段话送回来落盘。
            // 写盘留在壳里 —— 远程页面不该有任何文件系统能力。
            "dsc_diary_save",
            // 设置页翻日记（只读两条）
            "dsc_diary_days",
            "dsc_diary_read",
            // 立绘：页面只读当前角色的图 + 一个"随手关掉自己"的开关；传图/清图只有设置窗口能做
            "dsc_avatar_get",
            "dsc_avatar_set",
            "dsc_avatar_clear",
            "dsc_avatar_toggle",
            "dsc_avatar_matrix",
            "dsc_pet_state",
            "dsc_pet_clip",
            "dsc_pet_window",
            // 对话同步：打包与落包都得在页面里发起（只有页面有登录态，
            // 发消息/读对话都得用它）；壳只提供两个纯本地端点。
            "dsc_sync_pack",
            "dsc_sync_apply",
        ])),
    )
    .expect("failed to run tauri-build");
}
