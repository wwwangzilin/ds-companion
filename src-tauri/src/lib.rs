//! DS Companion —— 把 chat.deepseek.com 装进一个原生窗口，并注入人设。
//!
//! 两个窗口：
//!   main     远程 chat.deepseek.com（注入脚本挂在这里）
//!   settings 本地设置界面（人设 / 状态 / 记忆 / 日志）
//!
//! 三条踩实过的硬约束：
//!   1. 窗口标题**不会**跟随 document.title —— 要标题事件得显式 on_document_title_changed
//!   2. 远程来源调自定义命令必须有 ACL（build.rs 的 AppManifest::commands + capability 里的 allow-*）
//!   3. 建窗口不能在同步 command / 事件回调里直接 build()（会死锁）—— async + spawn 再 await
//!
//! 【常驻】关窗不退出，缩到托盘。理由：空闲主动、身体层的时间流逝都要求进程活着 ——
//! 窗口一关她就"消失"了，那条时间线也就断了。
//!
//! 【日志】不再有独立的黑色控制台窗口（windows_subsystem=windows，见 main.rs），
//! 全部落 %TEMP%\ds-companion.log，在设置界面的「日志」页里实时看。
//! 注意：这个子系统下 print!/eprintln! 会 panic，非测试代码里一个都不许有。
//!
//! 【为什么是 lib.rs 而不是 main.rs】挂 Android 端的要求：Tauri mobile 需要一个带
//! `mobile_entry_point` 的**库**目标，Android 的 MainActivity 通过 JNI 直接调它。
//! 桌面端的 main.rs 现在只剩一句 `ds_companion_lib::run()`。
//! `windows_subsystem = "windows"` 是 bin 才认的属性，所以它跟着 main.rs 走。

mod chat;
mod config;
mod digest;
mod memory;
mod personas;
mod propose;
mod state;
mod tools;

use std::fs::OpenOptions;
use std::io::{Read, Write};
use std::path::PathBuf;
use std::sync::OnceLock;

use tauri::webview::PageLoadEvent;
use tauri::{Emitter, Manager};

/// 日志超过这个大小就轮转一份（保留 1 个 .1 备份）
const LOG_MAX_BYTES: u64 = 1_500_000;

/// 平台注入的日志目录（目前只有 Android 用）。
///
/// 手机上 `std::env::temp_dir()` 是 `/data/local/tmp`，**不是 app 能写的地方** ——
/// 日志会静默丢干净（`shell_log` 的 `if let Ok(...)` 吞掉失败），排查时一片漆黑。
/// 所以 setup 拿到 AppHandle 后注入 `app_data_dir()`。
static LOG_DIR_OVERRIDE: OnceLock<PathBuf> = OnceLock::new();

pub fn set_log_dir_override(p: PathBuf) {
    let _ = LOG_DIR_OVERRIDE.set(p);
}

fn log_path() -> PathBuf {
    match LOG_DIR_OVERRIDE.get() {
        Some(d) => d.join("ds-companion.log"),
        None => std::env::temp_dir().join("ds-companion.log"),
    }
}

fn log_backup_path() -> PathBuf {
    match LOG_DIR_OVERRIDE.get() {
        Some(d) => d.join("ds-companion.log.1"),
        None => std::env::temp_dir().join("ds-companion.log.1"),
    }
}

/// 只写文件。GUI 子系统下没有 stdout，所以这里不再"尽力写 stdout"了 ——
/// 那行代码在无控制台时会白白失败一次，还会让排查的人以为日志丢在控制台里。
fn shell_log(line: &str) {
    rotate_log_if_needed();
    if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(log_path()) {
        let _ = writeln!(f, "{line}");
    }
}

/// 每写若干行才查一次大小：stat 一次不贵，但没必要每行都查
fn rotate_log_if_needed() {
    use std::sync::atomic::{AtomicU32, Ordering};
    static N: AtomicU32 = AtomicU32::new(0);
    let n = N.fetch_add(1, Ordering::Relaxed);
    if n % 200 != 0 {
        return;
    }
    let path = log_path();
    let Ok(meta) = std::fs::metadata(&path) else {
        return;
    };
    if meta.len() < LOG_MAX_BYTES {
        return;
    }
    let backup = log_backup_path();
    let _ = std::fs::remove_file(&backup);
    let _ = std::fs::rename(&path, &backup);
    shell_log("[shell] 日志已轮转（上一份在 ds-companion.log.1）");
}

/// 崩溃也要留痕：GUI 子系统下 panic 默认是"静默消失"，最难查
fn install_panic_hook() {
    let default = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let msg = format!("[panic] {info}");
        if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(log_path()) {
            let _ = writeln!(f, "{msg}");
        }
        default(info);
    }));
}

/// 标准 base64（带 padding）。只为把 PoW 用的 26KB wasm 内联进注入脚本，
/// 引一个依赖不值当，所以手写。
fn base64_encode(data: &[u8]) -> String {
    const TABLE: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(data.len().div_ceil(3) * 4);
    for chunk in data.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = *chunk.get(1).unwrap_or(&0) as u32;
        let b2 = *chunk.get(2).unwrap_or(&0) as u32;
        let n = (b0 << 16) | (b1 << 8) | b2;
        out.push(TABLE[(n >> 18) as usize & 63] as char);
        out.push(TABLE[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 {
            TABLE[(n >> 6) as usize & 63] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            TABLE[n as usize & 63] as char
        } else {
            '='
        });
    }
    out
}

// ─────────────────────────── 页面 → 壳 ────────────────────────────────────

/// 注入脚本的日志（远程页面只被允许干这个，写不了人设）
#[tauri::command]
fn dsc_log(payload: String) {
    shell_log(&format!("[page] {payload}"));
}

/// 注入脚本启动时拉一次配置
#[tauri::command]
fn dsc_get_config() -> config::InjectPayload {
    config::inject_payload()
}

// ─────────────────────────── 设置界面用 ──────────────────────────────────

#[tauri::command]
fn persona_list() -> Vec<personas::Persona> {
    personas::list_personas()
}

#[tauri::command]
fn persona_get(id: String) -> Option<personas::Persona> {
    // 出厂默认角色在磁盘上没有文件，但它必须在界面上打得开 —— 所以走 any（磁盘优先、内置兜底）
    personas::get_persona_any(&id)
}

#[tauri::command]
fn persona_save(persona: personas::Persona) -> Result<personas::Persona, String> {
    let saved = personas::save_persona(&persona)?;
    shell_log(&format!("[settings] saved persona {}", saved.id));
    Ok(saved)
}

#[tauri::command]
fn persona_delete(id: String) -> Result<(), String> {
    personas::delete_persona(&id)?;
    shell_log(&format!("[settings] persona {id} moved to trash"));
    // 删掉的正是当前激活的，就把激活清掉，免得注入一个不存在的人设
    let mut cfg = config::load();
    if cfg.active_persona.as_deref() == Some(personas::safe_id(&id).as_str()) {
        cfg.active_persona = None;
        let _ = config::save(&cfg);
    }
    Ok(())
}

#[tauri::command]
fn dsh_preset_scan() -> Vec<personas::DshPreset> {
    personas::scan_dsh_presets()
}

#[tauri::command]
fn dsh_preset_import(id: String) -> Result<personas::Persona, String> {
    let p = personas::import_dsh_preset(&id)?;
    shell_log(&format!("[settings] imported dsh preset {} -> {}", id, p.id));
    Ok(p)
}

#[tauri::command]
fn config_get() -> config::AppConfig {
    config::load()
}

// ─────────────────────────── 记忆库 ──────────────────────────────────────

#[tauri::command]
fn memory_list() -> Vec<memory::WeightedMemory> {
    // 带权重返回：设置界面能直接显示"哪条会被优先注入"（顺序就是注入顺序）
    memory::list_weighted()
}

#[tauri::command]
fn memory_save(app: tauri::AppHandle, item: memory::MemoryItem) -> Result<memory::MemoryItem, String> {
    let saved = memory::save_memory(&item)?;
    shell_log(&format!("[settings] saved memory {} ({})", saved.id, saved.name));
    // 改完立刻把新的可见记忆推给页面，不然要刷新才生效
    push_config(&app);
    Ok(saved)
}

#[tauri::command]
fn memory_delete(app: tauri::AppHandle, id: String) -> Result<(), String> {
    memory::delete_memory(&id)?;
    shell_log(&format!("[settings] memory {id} moved to trash"));
    push_config(&app);
    Ok(())
}

/// 页面每轮注入后回报"用到了哪几条"，用来维护热度（accessCount / lastAccessedAt）
#[tauri::command]
fn memory_touch(ids: Vec<String>) -> Result<(), String> {
    memory::touch_memories(ids)
}

/// B 链路的落盘口（页面唯一能写记忆的通道，只增不删）。
///
/// 页面整理失败时也会调一次（items 空 + error 有值），这样设置窗口能收到
/// 同一个事件、知道是"挂了"而不是"还在跑"—— 省一个只用来报错的命令。
#[tauri::command]
fn memory_ingest(
    app: tauri::AppHandle,
    items: Vec<memory::IngestItem>,
    error: Option<String>,
) -> Result<memory::IngestReport, String> {
    // 模型给的理由只进日志，不入库 —— 排查"它为什么这么记"时全靠这行
    let reasons: Vec<&str> = items
        .iter()
        .map(|i| i.reason.trim())
        .filter(|r| !r.is_empty())
        .collect();
    if !reasons.is_empty() {
        shell_log(&format!("[page] memory reasons: {}", reasons.join(" | ")));
    }

    let report = match error {
        Some(e) if !e.trim().is_empty() => memory::IngestReport::failed(e.trim()),
        _ => memory::ingest_memories(items),
    };
    shell_log(&format!(
        "[page] memory ingest ok={} +{} ~{} skip={} {}{}",
        report.ok,
        report.added,
        report.updated,
        report.skipped,
        report.error,
        if report.details.is_empty() {
            String::new()
        } else {
            format!(" | {}", report.details.join("; "))
        }
    ));
    if report.ok && (report.added > 0 || report.updated > 0) {
        // 新记忆立刻对页面可见（否则要等下次拉配置才生效）
        push_config(&app);
    }
    // 设置窗口靠这个事件收工，不用轮询
    let _ = app.emit("dsc:memory-ingest", &report);
    Ok(report)
}

/// 设置界面点「立即整理」→ 让主窗口里的页面跑一次提取（页面自己有登录态）
#[tauri::command]
fn memory_extract(app: tauri::AppHandle) -> Result<(), String> {
    let Some(win) = app.get_webview_window("main") else {
        return Err("主窗口还没开 —— 先打开 DeepSeek 窗口聊几句".into());
    };
    win.eval("window.__DSC_EXTRACT__ && window.__DSC_EXTRACT__();")
        .map_err(|e| e.to_string())?;
    shell_log("[settings] memory extract triggered");
    Ok(())
}

// ─────────────────────────── 角色状态 ───────────────────────────────────

/// 一轮说完之后页面回报：壳负责感知情绪、推进状态、落盘，再把新块回给页面。
///
/// 【为什么放 Rust】情绪打分、状态演化、clamp、门控判断都是纯逻辑，
/// 放这边能单测；页面只管把"用户说了什么"递进来。
#[derive(serde::Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
struct TurnReport {
    ok: bool,
    state: state::CharState,
    /// 对方（主人）的状态 —— 从文本 + 历史 + 时间推的
    user_state: state::UserState,
    state_text: String,
    anchor_text: String,
    signal: state::Signal,
    /// 对用户状态的那次判断（hits 里有命中词，排查用）
    user_signal: state::UserSignal,
    /// 身体层这次推进发生了什么（"睡了一觉"之类），没发生就是空
    body_note: String,
    /// 这一轮新解锁的里程碑（页面据此闪角标）
    new_milestones: Vec<String>,
    /// 该不该花额度让模型再看一眼（页面据此决定，门在 Rust 这边算）
    want_model_sense: bool,
    /// 页面也该把【回锚】补上了吗（按会话轮数由页面自己判断，这里只是把间隔带回去）
    anchor_every_turns: u32,
    /// 这一轮是不是"工作模式"（页面据此决定：带不带【工作模式】块、主动搭话要不要静默）
    task_mode: bool,
    /// 刚刚发生变化（页面可以闪一下角标，让主人看见模式切了）
    task_changed: bool,
    /// 【工作模式】块正文（task_mode 为真时带上；Rust 渲染，页面别自己拼）
    task_text: String,
    /// 通路自检的告警（空 = 没看出问题）。
    ///
    /// 【为什么要跟着每轮回来】"机制没坏、通路断了"这类问题（情绪冻结、饿着没人管）
    /// 原来都要人主动去翻日志才发现。这里每轮算一次（纯函数，很便宜），
    /// 页面把它写进 [health]，设置页一眼就能看见。
    vitals: Vec<state::Vital>,
}

/// 任务模式的运行时状态：按角色分开存。
///
/// 为什么不落盘：这是**会话级**的临时判断（"主人现在在不在干活"），不是角色的状态。
/// 写进 state/*.json 会污染"她的状态"那份文件，还得处理老文件兼容；进程重启后
/// 从"还没有信号"重新开始，代价只是重判一次。
static TASK_TRACKERS: std::sync::Mutex<
    Option<std::collections::HashMap<String, state::TaskTracker>>,
> = std::sync::Mutex::new(None);

fn step_task_mode(character: &str, mode: &str, sig: &state::TaskSignal) -> (bool, bool) {
    let Ok(mut guard) = TASK_TRACKERS.lock() else {
        // 锁坏了也不能让整轮失败：退化成"只按这一句判"
        let mut t = state::TaskTracker::default();
        return t.apply_mode(mode, sig);
    };
    let map = guard.get_or_insert_with(std::collections::HashMap::new);
    let tracker = map.entry(character.to_string()).or_default();
    tracker.apply_mode(mode, sig)
}

/// 当前**实际生效**的角色 id。
///
/// 注意它和 `config.active_persona` 不是一回事：配置里没选角色（None）时这里给的是
/// **出厂默认角色**（DeepSeek 娘）—— 她有自己的一份状态与记忆。选「原版」时才是空串。
/// 所有"按角色取状态/记忆"的地方都必须走这个函数，别各自 `unwrap_or_default()`。
fn active_character() -> String {
    personas::active_character_id(config::load().active_persona.as_deref())
}

#[tauri::command]
fn dsc_turn_report(app: tauri::AppHandle, user_text: String, hour: u32) -> TurnReport {
    let cfg = config::load();
    let character = personas::active_character_id(cfg.active_persona.as_deref());
    if !cfg.state_enabled || character.is_empty() {
        return TurnReport {
            ok: false,
            state: state::CharState::default(),
            user_state: state::UserState::default(),
            state_text: String::new(),
            anchor_text: String::new(),
            signal: state::Signal::default(),
            user_signal: state::UserSignal::default(),
            body_note: String::new(),
            new_milestones: Vec::new(),
            want_model_sense: false,
            anchor_every_turns: cfg.anchor_every_turns,
            task_mode: false,
            task_changed: false,
            task_text: String::new(),
            vitals: Vec::new(),
        };
    }
    let now = now_ms();
    let hour = if hour > 23 { 12 } else { hour };

    // ⓪ 任务模式：先判"现在是不是在办正事" —— 它会影响后面三处
    // （好感保护 / 状态块压缩 / 感知门控），所以必须排在最前面
    let task_sig = state::sense_task(&user_text);
    let (task_mode, task_changed) = step_task_mode(&character, &cfg.task_mode, &task_sig);

    // ① 角色：情绪 → 心理状态；② 身体：先补时间流逝，再按这轮的反应推进
    let mut st = state::load_state(&character);
    let body_note = state::apply_body_elapsed(&mut st.body, now, hour);
    let sig = state::sense_text(&user_text);
    // 亲昵判断由 sense_text 一起给出 —— 这里原来**硬编码了第二份词表**，
    // 两份必然走散（state.rs 那边加了"在吗""露娜"这类呼唤，这边根本不认）
    let intimate = sig.intimate;
    state::apply_turn(&mut st, &sig, intimate, now, task_mode);
    state::apply_body_turn(&mut st.body, &sig, st.arousal, now);
    // 关系里程碑：第一次说话 / 聊满 N 轮 / 好感度达标 / 认识第 N 天 / 第一次叫主人
    let new_ms = state::detect_milestones(&mut st, &sig, now, intimate);
    // 工作态下不主动花额度做模型感知 —— 干活时来一句"你是不是心情不好"最碍事
    let want =
        !task_mode && state::want_model_sense(&cfg.sense_mode, cfg.sense_every_turns, &st, &sig);
    let saved = state::save_state(&st).unwrap_or(st);

    // ③ 对方：从"这条消息 + 隔了多久 + 现在几点"推
    let mut user = state::load_user_state();
    let away = if user.last_turn_at > 0 {
        ((now.saturating_sub(user.last_turn_at)) / 60_000) as u32
    } else {
        0
    };
    let usig = state::sense_user(&user_text, hour, away);
    state::apply_user_turn(&mut user, &usig, now, hour);
    let saved_user = state::save_user_state(&user).unwrap_or(user);

    let persona = cfg
        .active_persona
        .as_deref()
        .and_then(personas::get_persona);
    let (state_text, anchor_text) = (
        state::render_state_block(
            &saved,
            if cfg.body_enabled { Some(&saved.body) } else { None },
            if cfg.user_state_enabled { Some(&saved_user) } else { None },
            now,
            task_mode,
        ),
        state::render_anchor_block(
            &saved,
            persona.as_ref().map(|p| p.name.as_str()).unwrap_or(""),
            persona.as_ref().map(|p| p.body.as_str()).unwrap_or(""),
            &saved.addendum,
        ),
    );
    shell_log(&format!(
        "[state] turn={} mood={} v={:.2} aff={} energy={:.2} | body 困={:.2} 体={:.2} 饿={:.2} hr={}{} | user {} 精力={:.2} 投入={:.2}{}{} | hits={} wantModel={} | task={}{}",
        saved.turns,
        saved.mood,
        saved.valence,
        saved.affinity,
        saved.energy,
        saved.body.sleepiness,
        saved.body.stamina,
        saved.body.hunger,
        saved.body.heart_rate,
        if saved.body.asleep { " 睡" } else { "" },
        saved_user.mood,
        saved_user.energy,
        saved_user.engagement,
        if saved_user.busy { " 忙" } else { "" },
        if saved_user.tired { " 累" } else { "" },
        if sig.hits.is_empty() { "-".to_string() } else { sig.hits.join("/") },
        want,
        task_mode,
        if task_changed { " (刚切换)" } else { "" }
    ));
    if task_changed {
        shell_log(&format!(
            "[task] 模式切换 -> {}（信号 {} 分：{}）",
            if task_mode { "工作" } else { "日常" },
            task_sig.score,
            if task_sig.hits.is_empty() {
                "-".to_string()
            } else {
                task_sig.hits.join("/")
            }
        ));
    }
    if let Some(n) = &body_note {
        shell_log(&format!("[state] body: {n}"));
    }
    for m in &new_ms {
        shell_log(&format!("[milestone] 解锁：{m}（第 {} 轮）", saved.turns));
    }
    let _ = app.emit("dsc:state-changed", &saved);
    let _ = app.emit("dsc:user-state-changed", &saved_user);
    // 先算好：下面 `state: saved` 会把 saved 移进结构体，之后就不能再借用了
    let vitals = state::check_vitals(&saved);
    TurnReport {
        ok: true,
        state: saved,
        user_state: saved_user,
        state_text,
        anchor_text,
        signal: sig,
        user_signal: usig,
        body_note: body_note.unwrap_or_default(),
        new_milestones: new_ms,
        want_model_sense: want,
        anchor_every_turns: cfg.anchor_every_turns,
        task_mode,
        task_changed,
        // 只有真在工作时才给块：日常态给一段"你在工作"会让她莫名其妙地端着
        task_text: if task_mode {
            state::render_task_block()
        } else {
            String::new()
        },
        vitals,
    }
}

#[tauri::command]
fn user_state_get() -> state::UserState {
    state::load_user_state()
}

#[tauri::command]
fn user_state_save(
    app: tauri::AppHandle,
    state: state::UserState,
) -> Result<state::UserState, String> {
    let saved = state::save_user_state(&state)?;
    shell_log(&format!(
        "[settings] saved user state mood={} energy={:.2} engagement={:.2}",
        saved.mood, saved.energy, saved.engagement
    ));
    push_config(&app);
    Ok(saved)
}

#[tauri::command]
fn user_state_reset() -> Result<(), String> {
    state::reset_user_state()?;
    shell_log("[settings] user state moved to trash");
    Ok(())
}

/// 页面上要花额度之前先来问一句"今天还能不能问"（先扣额度再发请求）
#[tauri::command]
fn dsc_sense_reserve(day: String, cap: u32) -> bool {
    let character = active_character();
    if character.is_empty() {
        return false;
    }
    let mut st = state::load_state(&character);
    let ok = state::sense_budget_ok(&mut st, &day, cap);
    if ok {
        let _ = state::save_state(&st);
    } else {
        shell_log(&format!("[state] 模型感知额度用完（{day} cap={cap}）"));
    }
    ok
}

/// 模型判断完之后把结果交回来（好感增量/心情/处境/新锚点）
#[tauri::command]
fn dsc_sense_apply(
    app: tauri::AppHandle,
    sense: state::ModelSense,
) -> Result<state::CharState, String> {
    let character = active_character();
    if character.is_empty() {
        return Err("没有激活角色".into());
    }
    let mut st = state::load_state(&character);
    state::apply_model_sense(&mut st, &sense, now_ms());
    let saved = state::save_state(&st)?;
    shell_log(&format!(
        "[state] model-sense v={:.2} a={:.2} aff={} mood={} anchors={}",
        saved.valence,
        saved.arousal,
        saved.affinity,
        saved.mood,
        saved.anchors.len()
    ));
    let _ = app.emit("dsc:state-changed", &saved);
    push_config(&app);
    Ok(saved)
}

/// 空闲主动：先过额度闸，再给话术。
/// local 模式直接把话术给页面；model 模式只回"允许"，由页面自己发请求生成。
#[derive(serde::Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
struct ProactiveReply {
    ok: bool,
    text: String,
    source: String,
    reason: String,
    state: state::CharState,
}

#[tauri::command]
fn dsc_proactive(day: String, cap: u32, hour: u32) -> ProactiveReply {
    let cfg = config::load();
    let character = personas::active_character_id(cfg.active_persona.as_deref());
    let deny = |reason: &str| ProactiveReply {
        ok: false,
        text: String::new(),
        source: String::new(),
        reason: reason.to_string(),
        state: state::CharState::default(),
    };
    // 只认显式的 local / model —— 空串、拼错的、老配置里的残留都必须当"关"，
    // 否则一个笔误就会让它自己发请求花钱（成本闸宁可保守）
    let mode = cfg.proactive_mode.trim().to_string();
    if mode != "local" && mode != "model" {
        return deny("空闲主动是关的");
    }
    if !cfg.state_enabled {
        return deny("状态层是关的");
    }
    if character.is_empty() {
        return deny("没有激活角色");
    }
    let mut st = state::load_state(&character);
    if !state::proactive_budget_ok(&mut st, &day, cap) {
        shell_log(&format!("[state] 主动额度用完（{day} cap={cap}）"));
        return deny("今天的额度用完了");
    }
    let model = mode == "model";
    let text = if model {
        String::new()
    } else {
        state::proactive_line(&st, hour)
    };
    let saved = match state::save_state(&st) {
        Ok(s) => s,
        Err(e) => return deny(&e),
    };
    shell_log(&format!(
        "[state] proactive mode={} count={} text={}",
        cfg.proactive_mode,
        saved.proactive_count,
        if text.is_empty() { "(model)" } else { text.as_str() }
    ));
    ProactiveReply {
        ok: true,
        text,
        source: if model { "model".into() } else { "local".into() },
        reason: String::new(),
        state: saved,
    }
}

/// 页面想让它"说一句"时把结果交回来落盘（好让 HUD 与设置界面知道说过什么）
#[tauri::command]
fn dsc_proactive_done(app: tauri::AppHandle, text: String) -> Result<(), String> {
    shell_log(&format!("[state] proactive said: {}", state::clip_chars(&text, 120)));
    let character = active_character();
    if character.is_empty() {
        return Ok(());
    }
    let mut st = state::load_state(&character);
    st.arc = st.arc.clone();
    st.updated_at = now_ms();
    state::save_state(&st)?;
    let _ = app.emit("dsc:state-changed", &st);
    Ok(())
}

/// 任务栏闪一下（把主人的注意力叫回来）。没有通知插件也能做到，不用加依赖。
///
/// Android 上没有"任务栏"这个概念，闪不了 —— 那边的对应物是通知栏，
/// 等做前台服务时一起接（见 docs/android/README.md 的迁移清单）。
#[tauri::command]
fn dsc_attention(app: tauri::AppHandle) {
    #[cfg(desktop)]
    {
        use tauri::UserAttentionType;
        if let Some(win) = app.get_webview_window("main") {
            let _ = win.request_user_attention(Some(UserAttentionType::Informational));
        }
    }
    #[cfg(mobile)]
    let _ = app;
}

#[tauri::command]
fn dsc_state_get() -> state::CharState {
    state::load_state(&active_character())
}

// 设置界面用

#[tauri::command]
fn state_get(character_id: String) -> state::CharState {
    state::load_state(&character_id)
}

#[tauri::command]
fn state_save(app: tauri::AppHandle, state: state::CharState) -> Result<state::CharState, String> {
    let saved = state::save_state(&state)?;
    shell_log(&format!(
        "[settings] saved state {} mood={} aff={} anchors={}",
        saved.character_id,
        saved.mood,
        saved.affinity,
        saved.anchors.len()
    ));
    // 改完立刻推给页面，HUD 不用等下一轮
    push_config(&app);
    Ok(saved)
}

#[tauri::command]
fn state_reset(character_id: String) -> Result<(), String> {
    state::reset_state(&character_id)?;
    shell_log(&format!("[settings] state {character_id} moved to trash"));
    Ok(())
}

/// 手动喂一顿（设置页的「喂一顿」按钮）。
///
/// 【为什么要有这条命令】hunger 原来**只有加法通路**（时间流逝 / 每轮对话 / 睡醒都在涨），
/// 主人反馈"饿的状态怎么也解除不了，即使我喂她吃东西"—— 对话里也没有对应的识别。
/// 这条是最直接的出口：点一下立刻降下来，不必等对话识别命中。
#[tauri::command]
fn state_feed(app: tauri::AppHandle, character_id: String) -> Result<state::CharState, String> {
    let mut st = state::load_state(&character_id);
    let before = st.body.hunger;
    state::feed(&mut st.body, 0.5);
    // 通路自检靠它判断"多久没人喂过"—— 手动喂也要记账，否则告警会一直挂着
    st.last_fed_turn = st.turns;
    let saved = state::save_state(&st)?;
    shell_log(&format!(
        "[state] 喂了一顿 {}：饿 {:.0}% → {:.0}%",
        character_id,
        before * 100.0,
        saved.body.hunger * 100.0
    ));
    push_config(&app);
    // 托盘上那两行也要跟着变（设置页喂完，右键看托盘不该还写着"饿 90%"）
    refresh_tray(&app);
    Ok(saved)
}

/// 「她今天怎么样」：把今天拼成一段人话（设置页的「今天」卡片 + 托盘菜单都用它）。
///
/// `day` 留空时从各处记着的日期里挑最近的一天 —— **壳不自己算日期**（std 只给 UTC，
/// 本机 UTC+8 会在下午 4 点前算成昨天）。见 `digest` 模块的头注释。
#[tauri::command]
fn daily_digest(character_id: String, day: String) -> digest::Digest {
    let cfg = config::load();
    let cid = if character_id.trim().is_empty() {
        personas::active_character_id(cfg.active_persona.as_deref())
    } else {
        character_id.trim().to_string()
    };
    let st = state::load_state(&cid);
    let name = if cid.is_empty() {
        "原版（不注入人设）".to_string()
    } else {
        match personas::get_persona_any(&cid) {
            Some(p) => p.name,
            None => cid.clone(),
        }
    };

    let seen = tools::last_seen_day();
    let chat_days = chat::days();
    let picked = if day.trim().is_empty() {
        digest::latest_day(&[
            &st.sense_day,
            &st.proactive_day,
            &st.review_day,
            &seen,
            &chat_days.first().cloned().unwrap_or_default(),
        ])
    } else {
        day.trim().to_string()
    };

    // 工具额度按天分桶：挑了别的日子就该报 0，不能把"今天用过的次数"贴在昨天头上
    let (used_now, cap) = tools::quota_used_today();
    let used = if !picked.is_empty() && picked == seen {
        used_now
    } else {
        0
    };
    let turns_today = if picked.is_empty() {
        0
    } else {
        chat::read_day(&picked).len()
    };
    let mems = memory::list_memories();
    let mem_total = mems.len();
    let mem_own = mems
        .iter()
        .filter(|m| !cid.is_empty() && m.character_id == cid)
        .count();

    digest::build(
        &picked,
        &name,
        &st,
        &digest::Extras {
            turns_today,
            tool_used: used,
            tool_cap: cap,
            mem_total,
            mem_own,
            now_ms: now_ms(),
        },
    )
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[tauri::command]
fn config_set(app: tauri::AppHandle, cfg: config::AppConfig) -> Result<(), String> {
    config::save(&cfg)?;
    shell_log(&format!(
        "[settings] config saved: persona={:?} cadence={}",
        cfg.active_persona, cfg.cadence
    ));
    push_config(&app);
    // 角色 / 暂停状态都可能刚被改过 —— 托盘（勾选与摘要）同步跟上
    refresh_tray(&app);
    Ok(())
}

/// 把最新配置推给正在跑的页面（改完立刻生效，不用刷新）
fn push_config(app: &tauri::AppHandle) {
    let payload = config::inject_payload();
    let js = format!(
        "window.__DSC_SET_CONFIG__ && window.__DSC_SET_CONFIG__({});",
        serde_json::to_string(&payload).unwrap_or_else(|_| "null".into())
    );
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.eval(&js);
    }
}

/// 打开设置窗口。async + spawn 再 await：同步上下文里 build 会死锁（Quill 两轮才定位的坑）。
///
/// `tab` 是"打开后切到哪一页"：托盘菜单点「看日志」就直接落到日志页。
/// 已经开着的窗口靠事件切；刚建的窗口靠 `settings_take_tab` 主动来取
/// （新窗口的页面要加载几百毫秒才装得上监听，事件会丢）。
static PENDING_TAB: std::sync::Mutex<Option<String>> = std::sync::Mutex::new(None);

#[tauri::command]
async fn open_settings(app: tauri::AppHandle, tab: Option<String>) -> Result<(), String> {
    open_settings_at(app, tab).await
}

/// 设置页启动时来取"这次该显示哪一页"（取完就清，只生效一次）
#[tauri::command]
fn settings_take_tab() -> Option<String> {
    PENDING_TAB.lock().ok().and_then(|mut g| g.take())
}

async fn open_settings_at(app: tauri::AppHandle, tab: Option<String>) -> Result<(), String> {
    if let Some(t) = tab.as_ref() {
        if let Ok(mut g) = PENDING_TAB.lock() {
            *g = Some(t.clone());
        }
    }
    if let Some(win) = app.get_webview_window("settings") {
        let _ = win.show();
        // unminimize 是桌面专属：Android 的窗口归系统管，没有"最小化"这个状态
        #[cfg(desktop)]
        let _ = win.unminimize();
        let _ = win.set_focus();
        if let Some(t) = tab {
            let _ = win.emit("dsc:open-tab", t);
        }
        return Ok(());
    }
    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        let mut builder = tauri::WebviewWindowBuilder::new(
            &handle,
            "settings",
            tauri::WebviewUrl::App("settings.html".into()),
        )
        .title("DS Companion · 设置")
        .inner_size(1080.0, 760.0)
        .min_inner_size(900.0, 620.0)
        .background_color(tauri::window::Color(11, 9, 18, 255));
        // center / decorations 都是桌面窗口概念；Android 上窗口由系统摆布，
        // 而且**绝不能去掉系统装饰** —— 全屏页面会因此没有出口
        #[cfg(desktop)]
        {
            builder = builder.center().decorations(false);
        }
        match builder.build()
        {
            Ok(_) => shell_log("[settings] window opened"),
            Err(e) => shell_log(&format!("[settings] window FAILED: {e}")),
        }
    })
    .await
    .map_err(|e| e.to_string())?;
    Ok(())
}

// ─────────────────────────── 启动 ────────────────────────────────────────

// ─────────────────────────── 对话留档 ───────────────────────────────────

/// 页面每说完一轮调一次：把这一问一答落进按天分的 Markdown。
/// 留档同时服务三件事：记忆能溯源、刷新后仍能整理、她自己有东西可反思。
#[tauri::command]
fn dsc_chat_append(turn: chat::Turn) -> Result<(), String> {
    chat::append_turn(&turn)
}

/// 最近的对话（页面的内存版 transcript 空了时用它兜底 —— 比如刚刷新过）
#[tauri::command]
fn chat_recent(limit: u32) -> Vec<chat::Turn> {
    chat::recent(limit.clamp(1, 60) as usize)
}

// ─────────────────────────── 工具层（页面 → 壳） ───────────────────────────

/// 页面把模型吐出来的工具调用交给这里执行。
///
/// 【为什么必须过一条 IPC】页面侧只负责"解析文本"，真正的能力全在这边：
/// 开关、工作区、白名单、路径沙箱、当日配额、审计日志。反过来写（页面自己读文件）
/// 等于把主人的硬盘交给一段可能被污染的文本（记忆就是每轮注入进 prompt 的）。
#[tauri::command]
fn dsc_tool_invoke(call: tools::ToolCall, day: String) -> tools::ToolOutcome {
    let d = if day.trim().is_empty() {
        "unknown".to_string()
    } else {
        day.trim().to_string()
    };
    tools::run(&call, &d)
}

/// 页面每轮开始时问一次：能调什么、一轮最多几次（配置改了不用刷新页面）
#[derive(serde::Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
struct ToolBrief {
    enabled: bool,
    workspace_ok: bool,
    max_per_turn: u32,
    left_today: u32,
    /// 写工具开着吗（第四道门：只读开着 ≠ 允许改文件）
    write_enabled: bool,
    /// 还挂着几条待确认的写入（>0 时页面要把确认卡补出来）
    pending: u32,
    names: Vec<String>,
}

#[tauri::command]
fn dsc_tools_brief(day: String) -> ToolBrief {
    let cfg = config::load();
    let d = if day.trim().is_empty() {
        "unknown"
    } else {
        day.trim()
    };
    ToolBrief {
        enabled: cfg.tools_enabled,
        workspace_ok: tools::workspace().is_some(),
        max_per_turn: cfg.tool_max_per_turn,
        left_today: if cfg.tools_enabled {
            tools::quota_left(d, cfg.tool_daily_cap)
        } else {
            0
        },
        write_enabled: cfg.tools_write_enabled,
        pending: tools::list_pending().len() as u32,
        // 列出来的就是**真的能用**的：写工具没开时它一个字都不出现
        names: tools::TOOLS
            .iter()
            .filter(|t| t.risk != tools::Risk::Write || cfg.tools_write_enabled)
            .map(|t| t.name.to_string())
            .collect(),
    }
}

/// 工具结果回给模型时用的包装（页面拼【工具结果】块时调它，保证声明一致）
#[tauri::command]
fn dsc_tool_wrap(name: String, body: String) -> String {
    tools::wrap_result(&name, &body)
}

// 设置界面用

#[tauri::command]
fn tools_status(day: String) -> tools::ToolsStatus {
    let d = if day.trim().is_empty() {
        "unknown"
    } else {
        day.trim()
    };
    tools::status(d)
}

/// 设工作区。**必须校验存在且是目录** —— 一个手滑的相对路径会让"工具能碰的范围"
/// 变成"进程当前目录"，那比不设还危险。
#[tauri::command]
fn tools_set_workspace(app: tauri::AppHandle, path: String) -> Result<String, String> {
    let trimmed = path.trim().to_string();
    if trimmed.is_empty() {
        let mut cfg = config::load();
        cfg.workspace = String::new();
        config::save(&cfg)?;
        shell_log("[tools] 工作区已清空");
        push_config(&app);
        return Ok(String::new());
    }
    let p = std::path::PathBuf::from(&trimmed);
    if !p.is_dir() {
        return Err(format!("不是目录或不存在：{trimmed}"));
    }
    let canon = std::fs::canonicalize(&p).map_err(|e| e.to_string())?;
    let mut cfg = config::load();
    // 存**去掉 `\\?\` 前缀**的路径：Windows 上 canonicalize 会带上 verbatim 前缀，
    // 原样存进配置后设置页会显示成 `\\?\D:\projects\...`，看着像坏了（工具内部比较前
    // 一律会 strip，所以存哪种都能用 —— 那就存人看得懂的那种）。
    cfg.workspace = tools::strip_verbatim(&canon);
    config::save(&cfg)?;
    shell_log(&format!("[tools] 工作区 = {}", canon.display()));
    push_config(&app);
    Ok(cfg.workspace)
}

/// 工具开关（默认关；开之前必须工作区有效，否则开了也是白开）
#[tauri::command]
fn tools_set_enabled(app: tauri::AppHandle, on: bool) -> Result<bool, String> {
    let mut cfg = config::load();
    if on && tools::workspace().is_none() {
        return Err("先设置一个有效的工作区，再打开工具".into());
    }
    cfg.tools_enabled = on;
    config::save(&cfg)?;
    shell_log(&format!("[tools] enabled={on}"));
    push_config(&app);
    Ok(cfg.tools_enabled)
}

#[tauri::command]
fn tools_log_tail(limit: u32) -> Vec<String> {
    tools::recent_log(limit.clamp(1, 200) as usize)
}

/// 写工具开关（默认关）。它和 `tools_enabled` 是**两道独立的门**：
/// 只读工具开着，不等于允许她改文件。
#[tauri::command]
fn tools_set_write_enabled(app: tauri::AppHandle, on: bool) -> Result<bool, String> {
    let mut cfg = config::load();
    if on && tools::workspace().is_none() {
        return Err("先设置一个有效的工作区，再打开写工具".into());
    }
    cfg.tools_write_enabled = on;
    config::save(&cfg)?;
    shell_log(&format!("[tools] write_enabled={on}"));
    push_config(&app);
    Ok(cfg.tools_write_enabled)
}

/// 还挂着的待确认写入（页面弹确认卡、设置页显示都读它）
#[tauri::command]
fn tool_pending_list() -> Vec<tools::ToolProposal> {
    tools::list_pending()
}

/// 主人点了"允许 / 拒绝"。
///
/// 【为什么这条命令敢给远程页面】确认卡长在页面上，点的就是主人 —— 所以页面必须能调它。
/// 但它只能**决定一条已经存在的提案**，不能凭空造一条：提案只可能由 `write_file` 的调用
/// 产生，而要走到那一步得先过写工具开关 + 工作区 + 路径沙箱。也就是说这条命令
/// 本身不构成任何新能力，它只是"把人点的那一下送回壳里"。
#[tauri::command]
fn dsc_tool_proposal_decide(id: String, allow: bool) -> Result<tools::ToolOutcome, String> {
    let (p, out) = tools::decide_proposal(&id, allow)?;
    shell_log(&format!(
        "[tool-proposal] {} {} -> {}",
        if allow { "允许" } else { "拒绝" },
        p.id,
        p.status
    ));
    Ok(out)
}

// ─────────────────────────── 自我修订 ───────────────────────────────────

/// 反思之前先问一句"今天还能不能反思"（先扣额度再发请求，和情绪感知一个规矩）
#[tauri::command]
fn dsc_review_reserve(day: String, cap: u32) -> bool {
    let character = active_character();
    if character.is_empty() {
        return false;
    }
    let mut st = state::load_state(&character);
    let ok = state::review_budget_ok(&mut st, &day, cap);
    if ok {
        if let Ok(saved) = state::save_state(&st) {
            shell_log(&format!(
                "[review] reserved day={day} count={}/{}",
                saved.review_count, cap
            ));
        }
    } else {
        shell_log(&format!("[review] 今日反思额度用完（{day} cap={cap}）"));
    }
    ok
}

/// 她反思完了：收下提案**但不自动采纳** —— 改动要主人点头才生效。
#[tauri::command]
fn dsc_review_submit(
    app: tauri::AppHandle,
    proposal: propose::Proposal,
) -> Result<propose::Proposal, String> {
    let now = now_ms();
    let mut p = proposal;
    if p.character_id.trim().is_empty() {
        p.character_id = active_character();
    }
    let saved = propose::submit(p, now)?;
    // 记一笔"这次反思发生在第几轮"，供间隔门控用
    let character = saved.character_id.clone();
    if !character.is_empty() {
        let mut st = state::load_state(&character);
        st.last_review_turn = st.turns;
        let _ = state::save_state(&st);
    }
    shell_log(&format!(
        "[review] 提案 {}（第 {} 轮）：自订设定「{}」锚点 {} 处境「{}」理由「{}」",
        saved.id,
        saved.turn,
        saved.persona_addendum,
        saved.anchors.len(),
        saved.arc,
        saved.reason
    ));
    let _ = app.emit("dsc:proposal", &saved);
    push_config(&app);
    Ok(saved)
}

/// 设置界面点「让她反思一下」→ 交给主窗口的页面去跑（它才有登录态）
#[tauri::command]
fn review_now(app: tauri::AppHandle) -> Result<(), String> {
    let Some(win) = app.get_webview_window("main") else {
        return Err("主窗口还没开".into());
    };
    win.eval("window.__DSC_REVIEW_NOW__ && window.__DSC_REVIEW_NOW__();")
        .map_err(|e| e.to_string())?;
    shell_log("[settings] self-review triggered");
    Ok(())
}

#[tauri::command]
fn proposal_list(character_id: String) -> Vec<propose::Proposal> {
    propose::list(&character_id)
}

/// 采纳：写进她的"自订设定"/锚点/处境。**原始人设一个字都不动。**
#[tauri::command]
fn proposal_accept(
    app: tauri::AppHandle,
    character_id: String,
    id: String,
    day: String,
) -> Result<propose::Proposal, String> {
    let items = propose::list(&character_id);
    let p = items
        .iter()
        .find(|x| x.id == id)
        .cloned()
        .ok_or_else(|| "找不到这条提案".to_string())?;
    let mut st = state::load_state(&character_id);
    let applied = propose::apply_to_state(&mut st, &p, &day);
    state::save_state(&st)?;
    let out = propose::set_status(&character_id, &id, "accepted", now_ms())?;
    shell_log(&format!("[proposal] 采纳 {}：{}", id, applied.join("；")));
    if applied.is_empty() {
        shell_log(&format!("[proposal] {id} 没有新内容可写（可能早就采纳过）"));
    }
    let _ = app.emit("dsc:proposal-applied", &out);
    push_config(&app);
    Ok(out)
}

#[tauri::command]
fn proposal_reject(
    app: tauri::AppHandle,
    character_id: String,
    id: String,
) -> Result<propose::Proposal, String> {
    let out = propose::set_status(&character_id, &id, "rejected", now_ms())?;
    shell_log(&format!("[proposal] 驳回 {id}"));
    push_config(&app);
    Ok(out)
}

/// 对话留档的浏览（设置界面用）：有哪些天、某天聊了什么
#[tauri::command]
fn chat_days() -> Vec<String> {
    chat::days()
}

#[tauri::command]
fn chat_read_day(day: String) -> Vec<chat::Turn> {
    chat::read_day(&day)
}

// ─────────────────────────── 日志（设置界面用） ──────────────────────────

#[derive(serde::Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
struct LogInfo {
    path: String,
    size: u64,
    /// 本次返回的行（最新的在最后）
    lines: Vec<String>,
    /// 文件里总行数（估算：按换行数）
    total: usize,
    truncated: bool,
}

/// 读日志尾部。设置界面每 1.5 秒拉一次做"实时"效果 —— 所以在 Rust 侧只读尾巴，
/// 不要把整个文件搬过 IPC（日志可能几 MB）。
#[tauri::command]
fn log_tail(lines: u32) -> LogInfo {
    let path = log_path();
    let want = lines.clamp(20, 2000) as usize;
    let size = std::fs::metadata(&path).map(|m| m.len()).unwrap_or(0);
    let mut text = String::new();
    if let Ok(mut f) = std::fs::File::open(&path) {
        // 先按"最后 64KB"读，够 tail 用了；尾部可能有半个多字节字符，用 from_utf8_lossy 兜
        let start = size.saturating_sub(256 * 1024);
        if start > 0 {
            use std::io::Seek;
            let _ = f.seek(std::io::SeekFrom::Start(start));
        }
        let mut buf = Vec::new();
        let _ = f.read_to_end(&mut buf);
        text = String::from_utf8_lossy(&buf).to_string();
        // 从中间截断时，第一行大概率是半截，丢掉
        if start > 0 {
            if let Some(i) = text.find('\n') {
                text = text[i + 1..].to_string();
            }
        }
    }
    let total = text.lines().count();
    let all: Vec<String> = text.lines().map(|l| l.to_string()).collect();
    let truncated = all.len() > want;
    let lines_out = if truncated {
        all[all.len() - want..].to_vec()
    } else {
        all
    };
    LogInfo {
        path: path.display().to_string(),
        size,
        lines: lines_out,
        total,
        truncated,
    }
}

/// 清空日志（轮转一份再清，别把刚发生的事直接抹掉）
#[tauri::command]
fn log_clear() -> Result<(), String> {
    let path = log_path();
    if path.exists() {
        let backup = log_backup_path();
        let _ = std::fs::remove_file(&backup);
        std::fs::rename(&path, &backup).map_err(|e| e.to_string())?;
    }
    shell_log("[shell] 日志已清空（上一份在 ds-companion.log.1）");
    Ok(())
}

/// 在资源管理器里选中日志文件（找不到文件就打开所在目录）
#[tauri::command]
fn log_reveal() -> Result<(), String> {
    let path = log_path();
    let mut cmd = std::process::Command::new("explorer");
    if path.exists() {
        cmd.arg(format!("/select,{}", path.display()));
    } else {
        cmd.arg(std::env::temp_dir());
    }
    no_window(&mut cmd);
    cmd.spawn().map_err(|e| e.to_string())?;
    Ok(())
}

// ─────────────────────────── 数据目录（隔离可见化） ──────────────────────────

/// 当前生效的数据根目录 + 它是不是"被 DSC_DATA_DIR 隔离过的"。
///
/// 两件事都靠它：
///   ① 设置界面把目录显示出来 —— 主人得知道她的记忆/状态到底存在哪；
///   ② 验收脚本开跑前的门禁 —— 脚本做的是"真存真删"，跑在真实数据上就是拿主人的
///      记忆当沙包（memory-trash 里那 100+ 条测试残留就是这么来的）。
///      `isolated=false` 时脚本应当直接拒绝执行。
#[derive(serde::Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
struct DataDirInfo {
    path: String,
    isolated: bool,
    /// 里面已经有多少条记忆 —— 让"跑在真数据上"这件事变得肉眼可见
    memories: usize,
}

fn data_dir_info() -> DataDirInfo {
    let isolated = std::env::var("DSC_DATA_DIR")
        .map(|v| !v.trim().is_empty())
        .unwrap_or(false);
    DataDirInfo {
        path: personas::app_root().display().to_string(),
        isolated,
        memories: memory::list_memories().len(),
    }
}

#[tauri::command]
fn data_dir() -> DataDirInfo {
    data_dir_info()
}

/// 打开数据目录：点一下就能看到自己的记忆/人设/状态文件在哪
#[tauri::command]
fn data_reveal() -> Result<(), String> {
    let dir = personas::app_root();
    let _ = std::fs::create_dir_all(&dir);
    let mut cmd = std::process::Command::new("explorer");
    cmd.arg(dir.display().to_string());
    no_window(&mut cmd);
    cmd.spawn().map_err(|e| e.to_string())?;
    Ok(())
}

/// 整理回收站：把四个 trash 目录都按上限清一遍（只删 trash 里的旧备份，不动正本）
#[tauri::command]
fn trash_prune() -> Result<usize, String> {
    let removed = personas::prune_all_trash();
    shell_log(&format!(
        "[settings] 回收站整理完成：清掉 {removed} 份旧备份（上限 {}）",
        personas::TRASH_KEEP
    ));
    Ok(removed)
}

// ─────────────────────────── 常驻：自启 / 退出 / 窗口 ─────────────────────

/// 给控制台子进程加 CREATE_NO_WINDOW —— GUI 程序里跑 reg/explorer 不该闪黑框
fn no_window(cmd: &mut std::process::Command) {
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000);
    }
}

const AUTOSTART_KEY: &str = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run";
const AUTOSTART_NAME: &str = "DS Companion";

/// 开机自启：直接写注册表 Run 键。
/// 为什么不用 tauri-plugin-autostart：那个插件不在本机离线缓存里，
/// 而 Run 键就是它底下干的事 —— 零依赖、行为完全一样、还能自己读回校验。
#[tauri::command]
fn autostart_get() -> bool {
    let mut cmd = std::process::Command::new("reg");
    cmd.args(["query", AUTOSTART_KEY, "/v", AUTOSTART_NAME]);
    no_window(&mut cmd);
    match cmd.output() {
        Ok(out) => out.status.success(),
        Err(_) => false,
    }
}

#[tauri::command]
fn autostart_set(on: bool) -> Result<bool, String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let mut cmd = std::process::Command::new("reg");
    if on {
        cmd.args([
            "add",
            AUTOSTART_KEY,
            "/v",
            AUTOSTART_NAME,
            "/t",
            "REG_SZ",
            "/d",
            &format!("\"{}\"", exe.display()),
            "/f",
        ]);
    } else {
        cmd.args(["delete", AUTOSTART_KEY, "/v", AUTOSTART_NAME, "/f"]);
    }
    no_window(&mut cmd);
    let out = cmd.output().map_err(|e| e.to_string())?;
    if !on && !out.status.success() {
        // 本来就没这一项，删失败不算错
        shell_log("[shell] 自启项本来就不存在，忽略删除失败");
        return Ok(false);
    }
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).to_string());
    }
    shell_log(&format!("[shell] 开机自启 = {}", on));
    // 读回校验：写注册表也可能被策略挡掉，别只信命令退出码
    Ok(autostart_get())
}

/// 真正退出（托盘菜单与设置界面都用它）—— 关窗只是缩到托盘，这个才是"不干了"
#[tauri::command]
fn app_quit(app: tauri::AppHandle) {
    shell_log("[shell] quit requested");
    app.exit(0);
}

/// 把主窗口叫回来（托盘点击 / 自启后手动打开）
fn show_main(app: &tauri::AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.show();
        #[cfg(desktop)]
        let _ = win.unminimize();
        let _ = win.set_focus();
    }
}

#[tauri::command]
fn window_show_main(app: tauri::AppHandle) {
    show_main(&app);
}

/// 单实例：拿一个独占锁文件。进程一死句柄自动释放，所以不会留下需要手动清的僵尸锁。
///
/// **锁名跟数据目录绑定**：隔离实例（`DSC_DATA_DIR`）与正式实例互不干扰 ——
/// 否则"跑一次验收"就得先杀掉主人正在用的那个（它可能正主动说着一句话）。
/// 两个实例写的是两份数据，本来就不该互相排他。
fn take_single_instance_lock() -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        let mut p = std::env::temp_dir();
        let scope = personas::app_root().display().to_string().to_lowercase();
        p.push(format!(
            "ds-companion-{:08x}.lock",
            personas::fnv1a32(&scope)
        ));
        match OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(false)
            .share_mode(0) // 独占：第二个实例会拿到 sharing violation
            .open(&p)
        {
            Ok(mut f) => {
                let _ = f.set_len(0);
                let _ = writeln!(f, "{}", std::process::id());
                // 故意泄漏这个句柄：它必须活到进程结束
                std::mem::forget(f);
                true
            }
            Err(_) => false,
        }
    }
    #[cfg(not(windows))]
    {
        true
    }
}

/// FNV-1a 32 — **这里不要再放第二份实现**。
///
/// 曾经这个文件里有一份本地副本（和 `personas::fnv1a32` 一模一样），早就没人调用了，
/// 每轮编译都报一句 `never used`。留着它的唯一后果是：哪天有人想改哈希规则，
/// 看到两份实现得先花时间判断哪份在生效（而且很容易改错那一份）。
/// 需要哈希就调 `personas::fnv1a32`（见上面的实例锁）。
// ─────────────────────────── 托盘 ───────────────────────────────────────
//
// 【它不只是个启动入口】她是常驻后台的东西（关窗只收进托盘），而托盘原来只有
// "显示/设置/看日志/退出" —— 想让状态动一下（喂一顿、换个角色）都得开设置页翻到那一栏。
// 现在最常做的几件事就在右键一下的地方，而且**菜单顶部直接写着她的现状**：
// 不打开任何窗口就能知道她饿不饿、今天用了几次工具。

/// 托盘上需要动态改文本 / 勾选的项。**存进 app 的托管状态**，刷新时按句柄改。
///
/// 为什么不是"每次重建整个菜单"：重建会让正开着的菜单闪一下，子菜单里的勾选也会被重置
/// —— 手还没离开鼠标，菜单内容就换了。
#[cfg(desktop)] // 托盘只有桌面有（tauri::menu / tauri::tray 在 Android 上整个模块不存在）
struct TrayState {
    line1: tauri::menu::MenuItem<tauri::Wry>,
    line2: tauri::menu::MenuItem<tauri::Wry>,
    pause: tauri::menu::CheckMenuItem<tauri::Wry>,
    /// 人设 id → 勾选项（"切换角色"子菜单里的那些）
    personas: Vec<(String, tauri::menu::CheckMenuItem<tauri::Wry>)>,
}

/// 托盘那两行摘要。**纯函数**（单测打它），读盘的部分在 `tray_lines_now`。
fn tray_lines(name: &str, st: Option<&state::CharState>, used: u32, cap: u32) -> (String, String) {
    let Some(st) = st else {
        // 没有角色状态：可能是选了「原版」，也可能是状态文件读不出来。
        // **别再硬编码"还没选角色"** —— 名字由调用方给（它才知道是哪一种），
        // 否则「原版」会被写成一句看着像出错的话（踩过）。
        return (name.to_string(), String::new());
    };
    let mood = {
        let m = st.mood.trim();
        if m.is_empty() {
            "—"
        } else {
            m
        }
    };
    (
        format!("{name} · {mood} · 好感 {}/100", st.affinity),
        format!(
            "饿 {:.0}% · 精力 {:.0}% · 工具 {}/{}",
            st.body.hunger * 100.0,
            st.energy * 100.0,
            used,
            cap
        ),
    )
}

/// 现在该显示什么（配置 → 角色 → 状态 → 今日额度）
fn tray_lines_now() -> (String, String) {
    let cfg = config::load();
    let cid = personas::active_character_id(cfg.active_persona.as_deref());
    // 空 id = 选了「原版」（人设不注入，也没有角色状态可言）—— 那是一句**要说清楚**的话，
    // 不是一个该显示成"没选角色"的错误状态。
    let name = if cid.is_empty() {
        "原版（不注入人设）".to_string()
    } else {
        match personas::get_persona_any(&cid) {
            Some(p) => p.name,
            // 人设文件没了但配置还指着它：显示 id，别装作没事
            None => cid.clone(),
        }
    };
    let st = if cid.is_empty() {
        None
    } else {
        Some(state::load_state(&cid))
    };
    let (used, cap) = tools::quota_used_today();
    tray_lines(&name, st.as_ref(), used, cap)
}

/// 勾选 / 取消"暂停人设注入"。**纯函数**，返回"配置真的变了吗"（调用方据此决定要不要落盘）。
///
/// 暂停 = `cadence: "off"`（注入侧看到它就整块跳过人设），原节奏记进 `cadence_before_pause`；
/// 恢复 = 把原节奏放回去。**不是**一律回到 `first` —— 那叫改配置，不叫恢复。
fn apply_pause(cfg: &mut config::AppConfig, want_pause: bool) -> bool {
    if want_pause {
        if cfg.cadence == "off" {
            return false;
        }
        cfg.cadence_before_pause = Some(cfg.cadence.clone());
        cfg.cadence = "off".into();
        true
    } else {
        if cfg.cadence != "off" {
            return false;
        }
        cfg.cadence = cfg
            .cadence_before_pause
            .clone()
            .unwrap_or_else(|| "first".into());
        cfg.cadence_before_pause = None;
        true
    }
}

/// 按当前配置+状态刷新托盘的文本、勾选与 tooltip。
///
/// 任何时候调都安全：托盘还没建出来（TrayState 没托管）就直接返回 ——
/// 这个函数会被命令回调调用，而那些回调可能在 setup 之前就跑过一次。
/// Android 上没有托盘，刷新是空操作 —— 状态改走通知栏（待实现）。
/// 保留同名 no-op 是为了让 7 个调用点一个字都不用改。
#[cfg(mobile)]
fn refresh_tray(_app: &tauri::AppHandle) {}

#[cfg(desktop)]
fn refresh_tray(app: &tauri::AppHandle) {
    let Some(ts) = app.try_state::<TrayState>() else {
        return;
    };
    let (l1, l2) = tray_lines_now();
    let _ = ts.line1.set_text(&l1);
    let _ = ts.line2.set_text(&l2);
    let cfg = config::load();
    let _ = ts.pause.set_checked(cfg.cadence == "off");
    // 子菜单的勾选用**实际生效**的角色 id：没选过时勾的是出厂默认角色（列表里有它），
    // 选「原版」时一个都不勾（那时确实没有角色在生效）
    let active = personas::active_character_id(cfg.active_persona.as_deref());
    for (id, item) in ts.personas.iter() {
        let _ = item.set_checked(*id == active);
    }
    if let Some(tray) = app.tray_by_id("dsc-tray") {
        let tip = if l2.is_empty() {
            l1
        } else {
            format!("{l1}\n{l2}")
        };
        let _ = tray.set_tooltip(Some(tip));
    }
}

/// 托盘上点"喂一顿"
fn tray_feed(app: &tauri::AppHandle) {
    let cid = active_character();
    if cid.is_empty() {
        shell_log("[tray] 喂一顿：还没选角色，跳过");
        return;
    }
    if let Err(e) = state_feed(app.clone(), cid) {
        shell_log(&format!("[tray] 喂一顿失败：{e}"));
    }
    refresh_tray(app);
}

/// 托盘上点"暂停人设注入"（勾选态由配置推出来，不问"上次是什么"）
fn tray_toggle_pause(app: &tauri::AppHandle) {
    let mut cfg = config::load();
    let want_pause = cfg.cadence != "off";
    if apply_pause(&mut cfg, want_pause) {
        if let Err(e) = config::save(&cfg) {
            shell_log(&format!("[tray] 保存暂停状态失败：{e}"));
        }
        shell_log(&format!(
            "[tray] 人设注入{}（cadence={}）",
            if want_pause { "暂停" } else { "恢复" },
            cfg.cadence
        ));
        push_config(app);
    }
    refresh_tray(app);
}

/// 托盘上换角色（子菜单里点某个名字）
fn switch_persona(app: &tauri::AppHandle, id: &str) {
    let mut cfg = config::load();
    if cfg.active_persona.as_deref() == Some(id) {
        refresh_tray(app);
        return;
    }
    cfg.active_persona = Some(id.to_string());
    match config::save(&cfg) {
        Ok(()) => shell_log(&format!("[tray] 切换角色 -> {id}")),
        Err(e) => shell_log(&format!("[tray] 切换角色失败：{e}")),
    }
    push_config(app);
    refresh_tray(app);
}

/// Android 上不做托盘（那是系统级的东西）。这里只记一行日志，
/// 让 setup 里的 `build_tray(...)` 调用点保持原样。
#[cfg(mobile)]
fn build_tray(_app: &tauri::AppHandle) -> tauri::Result<()> {
    shell_log("[tray] Android 没有托盘，跳过（状态改走通知栏，待实现）");
    Ok(())
}

#[cfg(desktop)]
fn build_tray(app: &tauri::AppHandle) -> tauri::Result<()> {
    use tauri::menu::{CheckMenuItem, IsMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu};
    use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};

    let cfg = config::load();
    let (l1, l2) = tray_lines_now();

    // 前两行是**不可点**的状态行：这就是"角标"那件事的落地 ——
    // 不打开任何窗口，右键一下就知道她还饿不饿、今天用了几次工具。
    let line1 = MenuItem::with_id(app, "status1", &l1, false, None::<&str>)?;
    let line2 = MenuItem::with_id(app, "status2", &l2, false, None::<&str>)?;
    let sep1 = PredefinedMenuItem::separator(app)?;
    let sep2 = PredefinedMenuItem::separator(app)?;
    let sep3 = PredefinedMenuItem::separator(app)?;
    let sep4 = PredefinedMenuItem::separator(app)?;

    let today = MenuItem::with_id(app, "today", "她今天怎么样", true, None::<&str>)?;
    let feed = MenuItem::with_id(app, "feed", "喂一顿", true, None::<&str>)?;
    let pause = CheckMenuItem::with_id(
        app,
        "pause",
        "暂停人设注入",
        true,
        cfg.cadence == "off",
        None::<&str>,
    )?;

    // "切换角色"子菜单：启动时建一次。人设列表不长变（新导入的下次启动出现）——
    // 动态重建子菜单会把正开着的菜单掀掉，不值得。
    // 子菜单的勾选用**实际生效**的角色 id：没选过时勾的是出厂默认角色（列表里有它），
    // 选「原版」时一个都不勾（那时确实没有角色在生效）
    let active = personas::active_character_id(cfg.active_persona.as_deref());
    let mut persona_items: Vec<(String, CheckMenuItem<tauri::Wry>)> = Vec::new();
    for p in personas::list_personas() {
        let item = CheckMenuItem::with_id(
            app,
            format!("persona:{}", p.id),
            &p.name,
            true,
            p.id == active,
            None::<&str>,
        )?;
        persona_items.push((p.id, item));
    }
    let persona_refs: Vec<&dyn IsMenuItem<tauri::Wry>> = persona_items
        .iter()
        .map(|(_, it)| it as &dyn IsMenuItem<tauri::Wry>)
        .collect();
    let sub = if persona_refs.is_empty() {
        None
    } else {
        Some(Submenu::with_items(app, "切换角色", true, &persona_refs)?)
    };

    let show = MenuItem::with_id(app, "show", "显示窗口", true, None::<&str>)?;
    let settings = MenuItem::with_id(app, "settings", "设置", true, None::<&str>)?;
    let logs = MenuItem::with_id(app, "logs", "看日志", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;

    let mut refs: Vec<&dyn IsMenuItem<tauri::Wry>> =
        vec![&line1, &line2, &sep1, &today, &feed, &pause, &sep2];
    if let Some(s) = sub.as_ref() {
        refs.push(s);
        refs.push(&sep3);
    }
    refs.push(&show);
    refs.push(&settings);
    refs.push(&logs);
    refs.push(&sep4);
    refs.push(&quit);
    let menu = Menu::with_items(app, &refs)?;

    let mut builder = TrayIconBuilder::with_id("dsc-tray")
        .tooltip(if l2.is_empty() {
            l1.clone()
        } else {
            format!("{l1}\n{l2}")
        })
        .menu(&menu)
        // Windows 习惯：左键开窗、右键出菜单
        .show_menu_on_left_click(false)
        .on_menu_event(|app, ev| {
            let id = ev.id().as_ref().to_string();
            // 角色子菜单的 id 是 `persona:<id>`（人设 id 里可能有冒号吗？不会 —— safe_id 只留字母数字与连字符）
            if let Some(pid) = id.strip_prefix("persona:") {
                switch_persona(app, pid);
                return;
            }
            match id.as_str() {
                "show" => show_main(app),
                "feed" => tray_feed(app),
                // 「今天」是个**要看**的东西，不是一个动作 —— 所以它开设置窗口的「状态」页
                // （日报卡片就在那一页顶部），而不是在托盘里塞一段长文本
                "today" => {
                    let h = app.clone();
                    tauri::async_runtime::spawn(async move {
                        let _ = open_settings_at(h, Some("state".to_string())).await;
                    });
                }
                "pause" => tray_toggle_pause(app),
                "settings" => {
                    let h = app.clone();
                    tauri::async_runtime::spawn(async move {
                        let _ = open_settings_at(h, None).await;
                    });
                }
                "logs" => {
                    let h = app.clone();
                    tauri::async_runtime::spawn(async move {
                        let _ = open_settings_at(h, Some("log".to_string())).await;
                    });
                }
                "quit" => {
                    shell_log("[shell] tray quit");
                    app.exit(0);
                }
                _ => {}
            }
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                let app = tray.app_handle();
                if let Some(win) = app.get_webview_window("main") {
                    let visible = win.is_visible().unwrap_or(false);
                    if visible {
                        let _ = win.hide();
                    } else {
                        show_main(app);
                    }
                } else {
                    show_main(app);
                }
            }
        });

    // 图标：用打包时嵌进来的默认图标（tauri.conf.json 的 bundle.icon）。
    // 拿不到就不给图标 —— 总比建不出托盘好（没托盘=关窗就退出）。
    match app.default_window_icon().cloned() {
        Some(icon) => {
            builder = builder.icon(icon);
        }
        None => shell_log("[tray] 没有默认图标，托盘会是个空白图标"),
    }
    builder.build(app)?;
    // 句柄托进托管状态，之后 refresh_tray 按它改文本/勾选
    app.manage(TrayState {
        line1,
        line2,
        pause,
        personas: persona_items,
    });
    Ok(())
}

/// 给设置页 / 验收脚本看的"托盘上现在是什么样"。
///
/// 【为什么要有它】托盘是**看不见的界面**：菜单文本、勾选、tooltip 都没法用 CDP 断言。
/// 把它读出来才能验证"她饿的时候托盘真的会写饿"—— 不然这块只能靠肉眼。
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct TraySnapshot {
    line1: String,
    line2: String,
    tooltip: String,
    paused: bool,
    cadence: String,
    active: String,
    personas: Vec<String>,
}

#[tauri::command]
fn tray_snapshot() -> TraySnapshot {
    let cfg = config::load();
    let (line1, line2) = tray_lines_now();
    TraySnapshot {
        tooltip: if line2.is_empty() {
            line1.clone()
        } else {
            format!("{line1}\n{line2}")
        },
        line1,
        line2,
        paused: cfg.cadence == "off",
        cadence: cfg.cadence.clone(),
        active: personas::active_character_id(cfg.active_persona.as_deref()),
        personas: personas::list_personas().into_iter().map(|p| p.name).collect(),
    }
}

/// 应用入口。桌面端由 main.rs 调；Android 端由 Tauri 的 mobile runtime 调
///（`mobile_entry_point` 宏会生成 JNI 符号，Activity 启动时进来）。
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    install_panic_hook();
    if !take_single_instance_lock() {
        shell_log("[shell] 已经有一个实例在跑了，这次退出");
        return;
    }
    let _ = personas::ensure_dirs();
    let _ = memory::ensure_dir();
    let _ = state::ensure_dir();
    let _ = chat::ensure_dir();
    let _ = propose::ensure_dir();
    shell_log(&format!(
        "=== ds-companion start (root={}) ===",
        personas::app_root().display()
    ));
    // 哪份数据、隔没隔离：一行说清（验收脚本与主人排查都靠它）
    shell_log(&format!("[shell] {}", personas::scope_line()));

    let autoexit: Option<u64> = std::env::var("DSC_PROBE_AUTOEXIT")
        .ok()
        .and_then(|v| v.parse().ok());

    tauri::Builder::default()
        // 关窗不退出：缩到托盘。空闲主动、身体层的时间流逝都要求进程活着 ——
        // 窗口一关她就"消失"了，那条时间线也就断了。真退出走托盘菜单。
        // （放在 app 级而不是 builder 级：WebviewWindowBuilder 上没有 on_window_event）
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main" {
                    api.prevent_close();
                    let _ = window.hide();
                    shell_log("[shell] 主窗口收进托盘（真退出：托盘菜单→退出）");
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            dsc_log,
            dsc_get_config,
            open_settings,
            persona_list,
            persona_get,
            persona_save,
            persona_delete,
            dsh_preset_scan,
            dsh_preset_import,
            config_get,
            config_set,
            tray_snapshot,
            daily_digest,
            memory_list,
            memory_save,
            memory_delete,
            memory_touch,
            memory_ingest,
            memory_extract,
            dsc_turn_report,
            dsc_sense_reserve,
            dsc_sense_apply,
            dsc_proactive,
            dsc_proactive_done,
            dsc_attention,
            dsc_state_get,
            user_state_get,
            user_state_save,
            user_state_reset,
            state_get,
            state_save,
            state_reset,
            state_feed,
            log_tail,
            log_clear,
            log_reveal,
            data_dir,
            data_reveal,
            trash_prune,
            autostart_get,
            autostart_set,
            app_quit,
            window_show_main,
            settings_take_tab,
            dsc_chat_append,
            chat_recent,
            // 工具层：页面只用得到前三条；后三条是设置窗口的事
            dsc_tool_invoke,
            dsc_tools_brief,
            dsc_tool_wrap,
            tools_status,
            tools_set_workspace,
            tools_set_enabled,
            tools_log_tail,
            tools_set_write_enabled,
            tool_pending_list,
            dsc_tool_proposal_decide,
            dsc_review_reserve,
            dsc_review_submit,
            review_now,
            proposal_list,
            proposal_accept,
            proposal_reject,
            chat_days,
            chat_read_day,
        ])
        .setup(move |app| {
            // 【Android】数据与日志都得住进 app 私有目录。
            // 手机上没有 `%APPDATA%`、`temp_dir()`（/data/local/tmp）也不可写 ——
            // 不注入的话 `app_root()` 会落到相对路径 `./.ds-companion`，
            // 配置/状态/记忆/对话记录/提案**全部写不进去**，而日志会静默丢干净。
            // 桌面端整段跳过（那边的 %APPDATA% 与 %TEMP% 本来就是对的）。
            #[cfg(mobile)]
            {
                match app.path().app_data_dir() {
                    Ok(dir) => {
                        let _ = std::fs::create_dir_all(&dir);
                        personas::set_app_root_override(dir.clone());
                        set_log_dir_override(dir.clone());
                        shell_log(&format!("[android] data root -> {}", dir.display()));
                    }
                    Err(e) => shell_log(&format!("[android] app_data_dir() 失败：{e}")),
                }
            }
            let boot = serde_json::to_string(&config::inject_payload())
                .unwrap_or_else(|_| "null".into());
            // 注入脚本 = 引导配置 + 纯函数检索器 + 主逻辑 + DeepSeek 自请求通道。
            // 拆文件是为了能用 node 直接单测（tools/test-selector.cjs）。
            // PoW 的 26KB wasm 以 base64 内联，脚本自包含、不依赖外部文件。
            //
            // 顺序有讲究：tools.js（解析/执行）必须在 tool-loop.js（编排）之前，
            // 而 tool-loop 在 inject.js 之后 —— inject.js 只通过 window 上的函数名回调它们，
            // 谁在前谁在后都不影响运行，但**读代码的人按这个顺序读最顺**。
            let pow_b64 = base64_encode(include_bytes!("../inject/sha3_wasm_bg.wasm"));
            const INJECT_BODY: &str = concat!(
                include_str!("../inject/selector.js"),
                "\n",
                include_str!("../inject/inject.js"),
                "\n",
                include_str!("../inject/deepseek-client.js"),
                "\n",
                include_str!("../inject/extract.js"),
                "\n",
                include_str!("../inject/sense.js"),
                "\n",
                include_str!("../inject/tools.js"),
                "\n",
                include_str!("../inject/tool-loop.js"),
                "\n",
                // 确认卡（写工具）：放在 tool-loop 之后 —— 它只通过 window 上的函数名交互
                include_str!("../inject/confirm.js"),
                "\n",
                include_str!("../inject/empty-reply.js")
            );
            // 【幂等守卫】Android 上 Tauri/wry 会把初始化脚本注入**两次**：
            // WebViewCompat.addDocumentStartJavaScript（document-start，真身）
            // 和 WebViewClient.onPageStarted 的 evaluateJavascript（几百毫秒后）。
            // 桌面端只有一次，所以在桌面上这段守卫是空转。
            //
            // 不守卫会怎样：XHR/fetch 钩子被叠两层，同一个 body.prompt 被改写两次
            //（第一层加人设、第二层再加一遍）。真机上已实测确认双注入，见
            // docs/android/README.md 第 6 节。
            //
            // 页面真正导航/刷新时 window 是新的，守卫自然失效、注入照常生效；
            // SPA 内部跳转不重载文档，注入本来也不会重跑。
            let script = format!(
                "if (window.__DSC_INJECTED__) {{\n  window.__DSC_INJECTED_AGAIN__ = (window.__DSC_INJECTED_AGAIN__ || 0) + 1;\n  console.log('[dsc] 重复注入已跳过 #' + window.__DSC_INJECTED_AGAIN__);\n}} else {{\n  window.__DSC_INJECTED__ = true;\n  window.__DSC_BOOT_CONFIG__ = {boot};\n  window.__DSC_POW_WASM_B64__ = \"{pow}\";\n{body}\n}}\n",
                boot = boot,
                pow = pow_b64,
                body = INJECT_BODY
            );

            let url = tauri::WebviewUrl::External(
                "https://chat.deepseek.com/"
                    .parse()
                    .expect("hardcoded url parses"),
            );

            let built = tauri::WebviewWindowBuilder::new(app, "main", url)
                .title("DS Companion")
                .inner_size(1180.0, 820.0)
                .initialization_script(script)
                .on_document_title_changed(|_win, title| {
                    if title.len() < 120 {
                        shell_log(&format!("[title] {title}"));
                    }
                })
                .on_page_load(|_webview, payload| {
                    let ev = match payload.event() {
                        PageLoadEvent::Started => "started",
                        PageLoadEvent::Finished => "finished",
                    };
                    shell_log(&format!("[pageload] {ev} {}", payload.url()));
                })
                .build();

            match built {
                Ok(_) => shell_log("[main] window built ok"),
                Err(e) => {
                    shell_log(&format!("[main] window build FAILED: {e}"));
                    std::process::exit(3);
                }
            }

            // 托盘：常驻入口。建失败也不致命（还能用窗口），但一定要留一行日志
            if let Err(e) = build_tray(app.handle()) {
                shell_log(&format!("[tray] build FAILED: {e}"));
            } else {
                shell_log("[tray] ready（左键开窗 / 右键菜单；关窗=收进托盘）");
                // 摘要每 30 秒自己刷一次：她的状态随时间在变（饿、精力），
                // 不能只在"人点开菜单那一刻"才算 —— 那正好是他看的时候。
                let h = app.handle().clone();
                std::thread::spawn(move || loop {
                    std::thread::sleep(std::time::Duration::from_secs(30));
                    refresh_tray(&h);
                });
            }

            if let Some(secs) = autoexit {
                let handle = app.handle().clone();
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_secs(secs));
                    if let Some(win) = handle.get_webview_window("main") {
                        shell_log(&format!(
                            "[final] url={}",
                            win.url().map(|u| u.to_string()).unwrap_or_default()
                        ));
                    }
                    // 自动跑模式顺手把设置窗口也开一次，供 CDP 验收
                    // （std::thread 里不能 await，用 block_on 把 async 命令跑完）
                    if let Err(e) =
                        tauri::async_runtime::block_on(open_settings_at(handle.clone(), None))
                    {
                        shell_log(&format!("[settings] autoopen failed: {e}"));
                    }
                    shell_log("[shell] autoexit");
                    std::process::exit(0);
                });
            }

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 单测全局锚点：`DSC_DATA_DIR` 指向临时目录，**整个测试进程只设一次**。
    ///
    /// 为什么必须锚死：环境变量是进程级的，而个别测试为了自证会临时改它
    /// （配置的坏文件隔离用例就是）。不锚的话，并行的另一个测试正好在那一刻
    /// 读到别人的临时目录 —— 表现就是"单跑绿、全跑红"。
    ///
    /// 更重要的是安全：不设它，测试直接写主人的真实 %APPDATA%\ds-companion。
    /// 这不是假想 —— 实测真实记忆目录里真的出现过一张测试写的坏记忆文件
    /// （memory/broken.md），memory-trash 里也堆过 100+ 条测试残留。
    /// 全局配置是**进程级唯一**的那一份（`config_path()` 指向隔离数据目录里的文件）。
    /// 任何会写它的测试都得拿这把锁，否则就是"单跑绿、全跑红"：
    /// 实测 tools 的 `use_workspace`（写配置指工作区）与 config 的坏文件用例并行时，
    /// 前者把 `active_persona` 清成 None，后者那句断言就红了 —— 而且看起来像配置被写坏了。
    pub(crate) static CONFIG_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    pub(crate) fn lock_test_data_dir() {
        static ONCE: std::sync::Once = std::sync::Once::new();
        ONCE.call_once(|| {
            // 让 aux_log 走 stderr：单测不该往主人的 %TEMP%\ds-companion.log 里灌恢复/审计行
            std::env::set_var("DSC_UNIT_TEST", "1");
            if std::env::var("DSC_DATA_DIR").map(|v| !v.trim().is_empty()).unwrap_or(false) {
                return; // 外面已经指好了（CI 或人工隔离），不抢
            }
            let dir = std::env::temp_dir().join(format!(
                "dsc-unittest-{}",
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_millis())
                    .unwrap_or(0)
            ));
            let _ = std::fs::create_dir_all(&dir);
            std::env::set_var("DSC_DATA_DIR", &dir);
        });
    }

    /// 测试自己不能把数据写进主人的真实目录 —— 这条断言是对上面那个 ONCE 的看门狗
    #[test]
    fn tests_never_touch_real_appdata() {
        lock_test_data_dir();
        let root = personas::app_root().display().to_string();
        assert!(
            root.contains("dsc-unittest-") || std::env::var("DSC_DATA_DIR").is_ok(),
            "测试进程的数据目录没有被隔离：{root}"
        );
        assert!(
            !root.to_lowercase().contains("roaming\\ds-companion"),
            "测试正在往主人的真实数据目录写东西：{root}"
        );
    }

    /// base64 手写实现必须与标准一致（含 padding 的三种余数情况），
    /// 否则内联的 PoW wasm 会解不出来 —— 那是最难查的一类错。
    #[test]
    fn base64_matches_standard() {
        assert_eq!(base64_encode(b""), "");
        assert_eq!(base64_encode(b"f"), "Zg==");
        assert_eq!(base64_encode(b"fo"), "Zm8=");
        assert_eq!(base64_encode(b"foo"), "Zm9v");
        assert_eq!(base64_encode(b"foob"), "Zm9vYg==");
        assert_eq!(base64_encode(b"fooba"), "Zm9vYmE=");
        assert_eq!(base64_encode(b"foobar"), "Zm9vYmFy");
        // wasm 魔数 \0asm → 已知前缀
        assert_eq!(base64_encode(&[0x00, 0x61, 0x73, 0x6d]), "AGFzbQ==");
    }

    /// 内联的 wasm 必须是真 wasm（魔数 \0asm），别拷错文件
    #[test]
    fn pow_wasm_is_real_wasm() {
        let bytes = include_bytes!("../inject/sha3_wasm_bg.wasm");
        assert_eq!(&bytes[0..4], &[0x00, 0x61, 0x73, 0x6d]);
        assert!(bytes.len() > 10_000, "wasm 太小了：{}", bytes.len());
    }

    // ─────────────────── 托盘：摘要与暂停 ───────────────────
    //
    // 托盘是**看不见的界面**（菜单文本、勾选、tooltip 都没法用 CDP 断言），所以这里
    // 把"该显示什么"和"勾选该是什么"都做成纯函数，逻辑在单测里盯住；
    // 真机上托盘长什么样由 `tray_snapshot` 命令读出来给验收脚本。

    /// 摘要要像人话：没角色时说清楚，有角色时数字都在
    #[test]
    fn tray_lines_reads_like_a_status() {
        let (a, b) = tray_lines("（没选角色）", None, 3, 20);
        assert_eq!(a, "（没选角色）", "没有状态时名字要原样透传");
        assert!(b.is_empty(), "没角色时第二行该是空的：{b}");
        // 没有角色状态时**名字必须由调用方决定**：选了「原版」的人不该看到
        // "还没选角色"（那句看着像出错）。这条防的是有人把硬编码加回来。
        let (a2, b2) = tray_lines("原版（不注入人设）", None, 0, 20);
        assert!(a2.contains("原版"), "名字要透传：{a2}");
        assert!(b2.is_empty(), "{b2}");

        let mut st = state::CharState::default();
        st.mood = "有点得意".into();
        st.affinity = 81;
        st.energy = 0.65;
        st.body.hunger = 0.4;
        let (a, b) = tray_lines("露娜", Some(&st), 3, 20);
        assert!(
            a.contains("露娜") && a.contains("有点得意") && a.contains("81/100"),
            "{a}"
        );
        assert!(
            b.contains("饿 40%") && b.contains("精力 65%") && b.contains("工具 3/20"),
            "{b}"
        );

        // 心情标签是空的（老状态文件 / 手改过）也不能显示成一片空白
        st.mood = "   ".into();
        let (a, _) = tray_lines("露娜", Some(&st), 0, 20);
        assert!(a.contains('—'), "{a}");
    }

    /// 暂停要记住原节奏：恢复 ≠ 一律回到 first
    #[test]
    fn pause_remembers_previous_cadence() {
        let mut cfg = config::AppConfig {
            cadence: "every".into(),
            ..Default::default()
        };

        assert!(apply_pause(&mut cfg, true), "首次暂停要算改动");
        assert_eq!(cfg.cadence, "off");
        assert_eq!(cfg.cadence_before_pause.as_deref(), Some("every"));
        assert!(!apply_pause(&mut cfg, true), "已经暂停了，再勾一次不该算改动");

        assert!(apply_pause(&mut cfg, false), "恢复要算改动");
        assert_eq!(cfg.cadence, "every", "恢复必须回到原节奏，不是 first");
        assert_eq!(cfg.cadence_before_pause, None);
        assert!(!apply_pause(&mut cfg, false), "没暂停时恢复不该算改动");

        // 老配置里没记过原节奏（比如手工把 cadence 改成 off 的）—— 只能落到默认
        let mut old = config::AppConfig {
            cadence: "off".into(),
            cadence_before_pause: None,
            ..Default::default()
        };
        assert!(apply_pause(&mut old, false));
        assert_eq!(old.cadence, "first");
    }
}
