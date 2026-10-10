//! 桌宠 —— 让立绘**离开浏览器**，变成一个真正飘在桌面上的小窗。
//!
//! 【为什么要它】在这之前，她的立绘是**注入到 DeepSeek 网页里的浮层**（`#dsc-avatar`）。
//! 也就是说：切到 IDE、切到文件管理器，她就不存在了 —— 而"桌面伴侣"最该做的事，
//! 恰恰是在你不看那个网页的时候还待在那儿。
//!
//! 【为什么这么小】桌宠的窗口只有立绘那么大（200×300，正好 2:3，和 1280×1920 的图同比例）。
//! 窗口越大，挡住主人点东西的面积就越大 —— 而这个窗口默认**点一下就穿过去**
//! （`set_ignore_cursor_events(true)`），她绝不能成为一个挡路的窗口。
//!
//! 【为什么 v1 不给拖动】无边框 + 透明的窗口在 Windows 上拖动会露出系统画的幽灵边框
//! （tauri-apps/tauri#14764）。与其做一个"拖起来有点怪"的交互，不如先**不给拖**，
//! 位置用设置里的四个角来定 —— 反正它就该待在边上。
//!
//! 【为什么位置在 Rust 算】只有这几行，却要两处（托盘、设置页）都能改 ——
//! 算一次、存在配置里，比两边各写一遍稳。

use std::sync::Mutex;

use crate::config;
use tauri::{AppHandle, Emitter, Manager};

/// 桌宠窗口的逻辑尺寸。
///
/// 宽度 × 立绘区高度 = 200×300，和立绘原图（1280×1920）同比例 —— 换比例就是拉伸。
/// 顶上那 44px 是**留给"正在干什么"那条气泡**的：气泡要是浮在图上就会盖住她的头，
/// 而多这 44px 完全看不出来（窗口本身是透明的）。立绘区那 300px 在 pet.css 里。
pub const W: f64 = 200.0;
pub const H: f64 = 344.0;
/// 离屏幕边缘留多少。贴死边看着像卡住了。
const MARGIN: f64 = 24.0;
/// 任务栏高度（逻辑像素）。Tauri 不会告诉我们任务栏在哪一边，就按最常见的下方算。
/// `pub` 是因为 pet_move 那边的抛掷物理也要用它当地板线 —— 两处必须是同一个数，
/// 不然她会在空中停住（一个说 1080、一个说 1032）。
pub const TASKBAR: f64 = 48.0;

pub const WINDOW_LABEL: &str = "pet";
/// 配置里那四个角。右下是默认 —— 屏幕右下角是"眼睛余光能扫到、但写字时挡不着"的地方。
pub const CORNERS: &[&str] = &["br", "bl", "tr", "tl"];

/// 配置里的角落名合法吗（非法一律回落右下，别让一个手写的值把窗口放到屏幕外）
pub fn normalize_corner(raw: &str) -> String {
    let s = raw.trim().to_ascii_lowercase();
    if CORNERS.contains(&s.as_str()) {
        s
    } else {
        "br".to_string()
    }
}

// ─────────────────────── 表情变体 ───────────────────────
//
// 【这段是 inject.js `avatarVariant()` 的移植（inject.js 里在 paintAvatarVariant 上面）】
// 立绘的七张差分（neutral/happy/smug/angry/sad/sleepy/shy）两边都得判一次：页面里那份
// 有实时的体温/心跳（身体层每轮都在动），桌宠这边只读落盘的 state。所以两边**判定顺序
// 必须一样**，否则会出现"网页里她是生气的、桌面上她是笑的"。
// 改动这里时请一并看 inject.js 那份。

/// 0-1 之间的数：不是有限值就用兜底（老 state 文件里可能缺字段）
fn unit(v: f32, fallback: f32) -> f32 {
    if v.is_finite() {
        v.clamp(0.0, 1.0)
    } else {
        fallback
    }
}

/// 收进 -1…1
fn pm1(v: f32) -> f32 {
    if v.is_finite() {
        v.clamp(-1.0, 1.0)
    } else {
        0.0
    }
}

fn has_any(text: &str, words: &[&str]) -> bool {
    words.iter().any(|w| text.contains(w))
}

/// 现在该显示哪张差分。
///
/// 【判定顺序有讲究】身体层排在心情前面：睡着了、困得睁不开眼、被撩到脸红心跳，
/// 这几件事跟"心情好不好"没关系 —— 让心情盖过它们，就会"明明睡着了还在笑"。
pub fn variant_of(s: &crate::state::CharState) -> String {
    let b = &s.body;
    if b.asleep {
        return "sleepy".to_string();
    }
    if unit(b.sleepiness, 0.2) >= 0.65 {
        return "sleepy".to_string();
    }
    // 脸红心跳 = 被撩到（出戏那一下 fluster 会 +22 心跳、+0.18 体温）
    if b.heart_rate >= 96 && unit(b.warmth, 0.5) >= 0.62 {
        return "shy".to_string();
    }

    let mood = s.mood.as_str();
    let valence = pm1(s.valence);
    let arousal = unit(s.arousal, 0.3);
    // 先认模型手写的词（它有时比数值网格细），认不出再退到数值
    if has_any(mood, &["炸毛", "生气", "愤怒", "气死", "烦躁", "烦"]) {
        return "angry".to_string();
    }
    if has_any(mood, &["低落", "难过", "委屈", "伤心", "闷", "沮丧"]) {
        return "sad".to_string();
    }
    if has_any(mood, &["雀跃", "开心", "高兴", "兴奋", "激动", "得意"]) {
        return "smug".to_string();
    }
    if has_any(mood, &["满足", "不错", "还好", "平静"]) {
        return if valence >= 0.3 { "happy" } else { "neutral" }.to_string();
    }

    if valence <= -0.3 {
        return if arousal >= 0.55 { "angry" } else { "sad" }.to_string();
    }
    if valence >= 0.3 {
        return if arousal >= 0.65 { "smug" } else { "happy" }.to_string();
    }
    "neutral".to_string()
}

// ─────────────────────── 窗口 ───────────────────────

/// 按配置里的角落把窗口摆到屏幕边上。
pub fn place(app: &AppHandle) {
    let Some(win) = app.get_webview_window(WINDOW_LABEL) else {
        return;
    };
    let corner = normalize_corner(&config::load().pet_corner);
    // 屏幕的逻辑尺寸：monitor.size() 是物理像素，要除以缩放比才是 set_position 认的坐标
    let (sw, sh) = match win.primary_monitor() {
        Ok(Some(m)) => {
            let sf = m.scale_factor();
            (m.size().width as f64 / sf, m.size().height as f64 / sf)
        }
        // 拿不到显示器就别瞎放，按 1080p 算
        _ => (1920.0, 1080.0),
    };
    let right = sw - W - MARGIN;
    let bottom = sh - H - MARGIN - TASKBAR;
    let (x, y) = match corner.as_str() {
        "bl" => (MARGIN, bottom),
        "tr" => (right, MARGIN),
        "tl" => (MARGIN, MARGIN),
        _ => (right, bottom),
    };
    // 屏幕太小的话别把窗口推到负数坐标（推出去就再也看不见了）
    let x = x.max(0.0);
    let y = y.max(0.0);
    let _ = win.set_position(tauri::LogicalPosition::new(x, y));
}

/// 开桌宠（已经开着就只摆一下位置）。
///
/// 【为什么是 async + spawn】Tauri 2 在 Windows 上，同步命令或事件回调里调
/// `WebviewWindowBuilder::build()` 会**死锁** —— 壳建出来了，webview 起不来，
/// 停在 about:blank（Quill 那边查了两轮才定位）。这个坑写在项目铁律里。
pub async fn open(app: AppHandle) -> Result<(), String> {
    if app.get_webview_window(WINDOW_LABEL).is_some() {
        place(&app);
        return Ok(());
    }
    let handle = app.clone();
    // 等它建完：调用方（config_set / 启动）拿到 Ok 时窗口就已经在屏幕上了。
    // 等待的是 async 任务、不是主线程 —— 这也是这个模式能用的原因。
    let _ = tauri::async_runtime::spawn(async move {
        let built = tauri::WebviewWindowBuilder::new(
            &handle,
            WINDOW_LABEL,
            tauri::WebviewUrl::App("pet.html".into()),
        )
        .title("DS Companion · 桌宠")
        .inner_size(W, H)
        .resizable(false)
        .maximizable(false)
        .minimizable(false)
        .decorations(false)
        // 透明 + 无边框：立绘直接"贴"在桌面上，没有一块白底
        .transparent(true)
        .shadow(false)
        .always_on_top(true)
        // 不进任务栏、不抢焦点 —— 她是待在角落里陪着的，不是来跟你抢窗口的
        .skip_taskbar(true)
        .focused(false)
        .build();
        match built {
            Ok(win) => {
                // ★默认点击穿透★：她绝不能挡住主人点任何东西。
                // 想跟她互动（拖动/右键）得在设置里把这个关掉。
                let _ = win.set_ignore_cursor_events(true);
                // Tauri 的 skip_taskbar 在这台机器上没生效（见 win_style 里的说明），自己动手
                hide_from_taskbar(&win);
                place(&handle);
                // 「手脚」那一拍：光标命中 → 决定吃不吃鼠标；拖拽跟手；抛掷物理；自己走
                crate::pet_move::set_interact(crate::config::load().pet_interact);
                crate::pet_move::ensure_loop(&handle);
                crate::shell_log("[pet] window opened（点击穿透已开）");
            }
            Err(e) => crate::shell_log(&format!("[pet] window FAILED: {e}")),
        }
    })
    .await;
    Ok(())
}

/// 关掉桌宠窗口（配置里的开关是另一回事：这里只负责窗口）。
pub fn close(app: &AppHandle) {
    crate::pet_move::stop_loop();
    if let Some(win) = app.get_webview_window(WINDOW_LABEL) {
        let _ = win.close();
        crate::shell_log("[pet] window closed");
    }
}

/// 把配置里的开关落成窗口的实际状态（启动时、改配置后都走它）。
pub fn sync_window(app: &AppHandle) {
    if config::load().pet_enabled {
        let h = app.clone();
        tauri::async_runtime::spawn(async move {
            let _ = open(h).await;
        });
    } else if app.get_webview_window(WINDOW_LABEL).is_some() {
        close(app);
    }
}

/// 让桌宠窗口重新拉一次状态（配置/状态一变就叫它）。
///
/// 【为什么用事件而不是让它自己轮询】她的表情、正在做的事都只在"对话跑完一轮"时才变，
/// 而那一刻壳这边正好知道（push_config）。让它自己定时拉，就是在没人看的时候也一直问。
pub fn ping(app: &AppHandle) {
    if app.get_webview_window(WINDOW_LABEL).is_some() {
        let _ = app.emit("dsc:pet", ());
    }
}

/// 桌宠需不需要重新摆位（设置里换了角落）。
pub fn on_corner_changed(app: &AppHandle) {
    if app.get_webview_window(WINDOW_LABEL).is_some() {
        // 正在走/飞的时候挪窗口，物理会拿一个跳变后的位置继续算（她会"瞬移"）——
        // 换角落就当"重新摆一次"，先把动作停了
        crate::pet_move::stop_motion();
        place(app);
    }
}

// ─────────────────────── 动作素材（从 dsh-pet 摘的） ───────────────────────
//
// 【为什么素材不在仓库里】dsh-pet 那 106 个 webm 一共 51.8 MB，而且是**别人画的**
// （PC2005-cloud，MIT）—— 让它待在自己的仓库里，我们只在本地按池下
// （`tools/fetch-pet-assets.mjs`，第一批只取 idle + clicks 共 2.7 MB）。
// 【许可证】MIT 要求带上版权声明 —— 见仓库根的 NOTICE。
//
// 【为什么走"壳喂 data URL"这条路】桌宠窗是 WebView2 里的一个本地页面，让它自己去读
// `%APPDATA%` 下的文件，要么开 asset 协议、要么给它 fs 权限；而**立绘本来就是这个走法**
// （`dsc_pet_state` 直接把 PNG 编成 data URL 递过去）。同一件事只留一条路。

/// 素材目录那一层（先只有 dsh-pet 这一套，将来可以有别的宠物包）
pub const CLIP_POOL: &str = "dsh-pet";

// ─────────────────────── 工作状态（她此刻在替你干什么） ───────────────────────
//
// 【为什么要壳来记这一档】上游 dsh-pet 的 `events.workStatus` 是"她正在干活"的六档动画
// （思考 / 干活 / 整理 / 等你点头 / 搞定 / 出错），触发源是 DSH 的会话事件。这边对应的是
// 注入层那几个天然节点：一次请求发出去 = 思考、工具开跑 = 干活、工具回来 = 整理、
// 一轮干净收尾 = 搞定、空回复/失败 = 出错。档位由**注入层**报上来（`dsc_pet_stage`），
// 壳只负责记着、过期丢掉、并在桌宠状态里带出去。
//
// 【为什么要有保鲜期】页面可能崩、可能被 F5、可能报了一次"干活"就再没下文 ——
// 一个永远停在"干活"的档位会让她一直循环播忙碌的动作。超过这个时间就当没有。
const STAGE_TTL_MS: u64 = 120_000;

static STAGE: Mutex<Option<(String, u64)>> = Mutex::new(None);

/// 记一档工作状态（注入层报上来的）。空串 = 她闲下来了（把档位清掉）。
pub fn set_stage(raw: &str) {
    let s = raw.trim();
    if s.is_empty() {
        // 空串是**合法的"空闲"**（页面/状态里空闲就是空串），别当成"非法值"忽略掉：
        // 忽略的话她会一直卡在上一档上（比如"干活"）直到保鲜期过 —— 那段时间她一直在忙。
        *STAGE.lock().unwrap() = None;
        return;
    }
    let ok = matches!(
        s,
        "thinking" | "working" | "result" | "waiting" | "success" | "error"
    );
    if !ok {
        return;
    }
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    *STAGE.lock().unwrap() = Some((s.to_string(), now));
}

/// 当前该播哪一档（空串 = 空闲）。
///
/// 【为什么"等你点头"排在最前】提案箱里躺着一条待审的提案时，她该做的是**站着等你**，
/// 而不是继续播"干活"—— 那个状态要主人动手才能往下走，跟 TTL 也没关系（你去忙别的，
/// 它就一直挂着，这是对的）。
pub fn stage() -> String {
    if let Some(id) = crate::personas::effective_persona(crate::config::load().active_persona.as_deref())
        .map(|p| p.id)
        .or_else(|| Some("dsh-deepseek".to_string()))
    {
        if crate::propose::list(&id).iter().any(|p| p.status == "pending") {
            return "waiting".into();
        }
    }
    let g = STAGE.lock().unwrap();
    match g.as_ref() {
        Some((s, at)) => {
            let now = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_millis() as u64)
                .unwrap_or(0);
            if now.saturating_sub(*at) <= STAGE_TTL_MS {
                s.clone()
            } else {
                String::new()
            }
        }
        None => String::new(),
    }
}


// ─────────────────────── 动作池（从 dsh-pet 摘的配置） ───────────────────────
//
// 【为什么抄一份配置进仓库】上游把池子写在 `assets/config.jsonc` 里（idle/turn/drag/clicks/
// moves/categories/events + 权重），那是**菜单树、随机链、事件档位的唯一事实来源**。
// 池子不跟素材一起下（素材 52 MB 不进仓库，配置才 4 KB），所以这里放一份摘录：
// `src-tauri/assets/pet-pools.json`，由上游那份去注释后取 animations + animationWeights 两段。
// 版权与出处见 NOTICE（MIT）。上游改了名字/权重，这里要跟着改 —— 认得出来的名字才播得出来。
const POOLS_JSON: &str = include_str!("../assets/pet-pools.json");

/// 池子过滤到**本地真装了**的素材。
///
/// 【为什么要过滤】"名字即文件名"：菜单里列出没下的动作，点下去只会静默失败
/// （上游注释原话：404 → 加载失败 → 表现成"点了没反应"）。宁可菜单短一点。
/// 只下第一批 6 段时，菜单里就只有 6 个能点的名字，装了全量自然全出来。
pub fn pools_for(installed: &[String]) -> serde_json::Value {
    use serde_json::{json, Value};
    let raw: Value = serde_json::from_str(POOLS_JSON).unwrap_or(Value::Null);
    let has = |n: &str| installed.iter().any(|x| x == n);
    let keep = |v: &Value| -> Vec<String> {
        v.as_array()
            .map(|a| {
                a.iter()
                    .filter_map(|x| x.as_str())
                    .filter(|s| has(s))
                    .map(str::to_string)
                    .collect()
            })
            .unwrap_or_default()
    };

    let mut cats: Vec<Value> = Vec::new();
    if let Some(arr) = raw["categories"].as_array() {
        for c in arr {
            let actions = keep(&c["actions"]);
            if actions.is_empty() {
                continue; // 一个都没装就不必出现在菜单里
            }
            cats.push(json!({
                "id": c["id"],
                "weight": c["weight"],
                "noMirror": c["noMirror"].as_bool().unwrap_or(false),
                "actions": actions,
            }));
        }
    }

    let mut moves: Vec<Value> = Vec::new();
    if let Some(arr) = raw["moves"]["actions"].as_array() {
        for m in arr {
            if m["name"].as_str().map(&has).unwrap_or(false) {
                moves.push(m.clone());
            }
        }
    }

    // 事件档位：值可能是单个名字，也可能是"档内候选数组"（上游两种都允许）
    let mut events = serde_json::Map::new();
    if let Some(obj) = raw["events"].as_object() {
        for (k, v) in obj {
            let slots: Vec<Value> = v
                .as_array()
                .map(|a| {
                    a.iter()
                        .filter_map(|slot| match slot {
                            Value::String(s) => has(s).then(|| json!(s)),
                            Value::Array(arr) => {
                                let inner: Vec<String> = arr
                                    .iter()
                                    .filter_map(|x| x.as_str())
                                    .filter(|s| has(s))
                                    .map(str::to_string)
                                    .collect();
                                (!inner.is_empty()).then(|| json!(inner))
                            }
                            _ => None,
                        })
                        .collect()
                })
                .unwrap_or_default();
            if !slots.is_empty() {
                events.insert(k.clone(), json!(slots));
            }
        }
    }

    json!({
        "weight": raw["weight"].clone(),
        "idle": keep(&raw["idle"]),
        "turn": keep(&raw["turn"]),
        "drag": keep(&raw["drag"]),
        "clicks": keep(&raw["clicks"]),
        "moves": { "default": raw["moves"]["default"].clone(), "actions": moves },
        "categories": cats,
        "events": events,
    })
}

pub fn clip_dir() -> std::path::PathBuf {
    crate::personas::app_root().join("pets").join(CLIP_POOL)
}

/// 动作名 → 安全文件名。空串 = 不接受。
///
/// 【为什么不能直接用 `avatar::sanitize`】那个只留 ASCII 字母数字，而 dsh-pet 的素材名是
/// **中文**的（`待机呼吸休闲`）—— 洗一遍全变成 `-`，一个也找不到。所以这里换一条判据：
/// **只禁危险的东西**，其余原样保留。
pub fn safe_clip_name(raw: &str) -> String {
    let s = raw.trim();
    if s.is_empty() || s.chars().count() > 80 {
        return String::new();
    }
    // 路径穿越 / 隐藏文件 / 路径分隔符，一律不接受
    if s.contains('/') || s.contains('\\') || s.contains("..") || s.starts_with('.') {
        return String::new();
    }
    if s.chars()
        .any(|c| c.is_control() || matches!(c, ':' | '*' | '?' | '"' | '<' | '>' | '|'))
    {
        return String::new();
    }
    s.to_string()
}

/// 现在装了哪些动作。**空表 = 没装素材 → 页面回落到立绘那条老路**。
///
/// 目录里就几个小文件，`read_dir` 是几十微秒的事，不值得再套一层缓存；
/// 真正的开销在下面的 base64 编码，那个缓存了。
pub fn clip_names() -> Vec<String> {
    let mut out = Vec::new();
    if let Ok(rd) = std::fs::read_dir(clip_dir()) {
        for e in rd.flatten() {
            let p = e.path();
            if p.extension().and_then(|s| s.to_str()) != Some("webm") {
                continue;
            }
            if let Some(stem) = p.file_stem().and_then(|s| s.to_str()) {
                if e.metadata().map(|m| m.len() > 0).unwrap_or(false) {
                    out.push(stem.to_string());
                }
            }
        }
    }
    out.sort();
    out
}

/// 已经编码过的动作：名字 → (文件 mtime 毫秒, data URL)。
///
/// 【为什么要缓存】一个 webm 中位 488 KB，编成 base64 是 650 KB —— 每换一次动作都编一遍、
/// 还要过一次 IPC。桌宠状态那条命令已经因为同类原因被优化过一轮（见 `dsc_pet_state`），
/// 这里一开始就带上。
/// 【为什么带 mtime】重新下素材（`--force`）之后不用重启就能生效。
static CLIP_CACHE: std::sync::Mutex<Option<std::collections::HashMap<String, (u64, String)>>> =
    std::sync::Mutex::new(None);

fn clip_mtime(path: &std::path::Path) -> u64 {
    std::fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// 取一段动作，编成 `data:video/webm;base64,…`。
///
/// 返回的是给页面用的 JSON：`{ok:true,name,dataUrl,bytes}` / `{ok:false,why}`。
pub fn clip_json(raw: &str) -> serde_json::Value {
    let name = safe_clip_name(raw);
    if name.is_empty() {
        return serde_json::json!({ "ok": false, "why": "名字不合法" });
    }
    let path = clip_dir().join(format!("{name}.webm"));
    let mtime = clip_mtime(&path);
    if mtime == 0 {
        return serde_json::json!({ "ok": false, "why": "没有这段动作" });
    }
    let mut guard = match CLIP_CACHE.lock() {
        Ok(g) => g,
        Err(p) => p.into_inner(),
    };
    let map = guard.get_or_insert_with(std::collections::HashMap::new);
    if let Some((at, url)) = map.get(&name) {
        if *at == mtime {
            return serde_json::json!({
                "ok": true, "name": name, "dataUrl": url, "cached": true,
            });
        }
    }
    let bytes = match std::fs::read(&path) {
        Ok(b) => b,
        Err(e) => return serde_json::json!({ "ok": false, "why": format!("读不出来：{e}") }),
    };
    let url = format!(
        "data:video/webm;base64,{}",
        crate::avatar::base64_encode(&bytes)
    );
    let n = bytes.len();
    map.insert(name.clone(), (mtime, url.clone()));
    serde_json::json!({ "ok": true, "name": name, "dataUrl": url, "bytes": n, "cached": false })
}

// ─────────────────────── 窗口的"实际样子"（诊断 / 验收用） ───────────────────────
//
// 【为什么需要它】"置顶"和"点击穿透"是这一层最要紧的两个属性，而它们**只体现在
// Win32 的扩展样式位里** —— "窗口开出来了"完全证明不了她不会挡路。
// 验收脚本据此断言（不查样式就只能靠肉眼，而肉眼是会骗人的）。

/// 扩展样式里我们关心的几位
pub const EX_TOPMOST: u32 = 0x0000_0008;
pub const EX_TRANSPARENT: u32 = 0x0000_0020;
pub const EX_LAYERED: u32 = 0x0008_0000;
/// 不进任务栏 / 不参与 Alt+Tab（`skip_taskbar` 用的就是它）
pub const EX_TOOLWINDOW: u32 = 0x0000_0080;

#[cfg(windows)]
mod win_style {
    #[link(name = "user32")]
    extern "system" {
        fn GetWindowLongW(hwnd: *mut core::ffi::c_void, index: i32) -> i32;
        fn SetWindowLongW(hwnd: *mut core::ffi::c_void, index: i32, value: i32) -> i32;
        fn ShowWindow(hwnd: *mut core::ffi::c_void, cmd: i32) -> i32;
    }
    /// GWL_EXSTYLE
    const GWL_EXSTYLE: i32 = -20;
    /// WS_EX_APPWINDOW —— 有这一位，窗口就**一定**在任务栏上
    const WS_EX_APPWINDOW: i32 = 0x0004_0000;
    const WS_EX_TOOLWINDOW: i32 = 0x0000_0080;
    const SW_HIDE: i32 = 0;
    const SW_SHOWNOACTIVATE: i32 = 4;

    pub fn ex_style(hwnd: *mut core::ffi::c_void) -> u32 {
        if hwnd.is_null() {
            return 0;
        }
        unsafe { GetWindowLongW(hwnd, GWL_EXSTYLE) as u32 }
    }

    /// 把它从任务栏上摘掉。
    ///
    /// 【为什么要自己动手】Tauri 的 `skip_taskbar(true)` 在这台机器上**没有生效**：
    /// 建出来的窗口扩展样式里 `WS_EX_APPWINDOW`（"一定要在任务栏上"）还在，于是
    /// 桌面右下角会多出一个莫名其妙的小图标 —— 而"桌宠不该占任务栏一格"是它对主人的
    /// 基本礼貌。这里直接改成 `WS_EX_TOOLWINDOW`（"这是个工具窗，别进任务栏/Alt+Tab"）
    /// 并清掉 APPWINDOW。
    ///
    /// 改完要 hide + show 一次：Shell 是在窗口显隐时重算任务栏按钮的，光改样式位
    /// 那个按钮会留在原地。（show 用 SW_SHOWNOACTIVATE —— 顺手把焦点抢走就更没礼貌了。）
    pub fn hide_from_taskbar(hwnd: *mut core::ffi::c_void) {
        if hwnd.is_null() {
            return;
        }
        unsafe {
            let ex = GetWindowLongW(hwnd, GWL_EXSTYLE);
            let want = (ex | WS_EX_TOOLWINDOW) & !WS_EX_APPWINDOW;
            if want == ex {
                return;
            }
            SetWindowLongW(hwnd, GWL_EXSTYLE, want);
            ShowWindow(hwnd, SW_HIDE);
            ShowWindow(hwnd, SW_SHOWNOACTIVATE);
        }
    }
}

#[cfg(not(windows))]
mod win_style {
    pub fn ex_style(_hwnd: *mut core::ffi::c_void) -> u32 {
        0
    }
    pub fn hide_from_taskbar(_hwnd: *mut core::ffi::c_void) {}
}

/// 这个窗口的扩展样式位（拿不到句柄就是 0）
pub fn ex_style(win: &tauri::WebviewWindow) -> u32 {
    #[cfg(windows)]
    {
        match win.hwnd() {
            Ok(h) => win_style::ex_style(h.0 as *mut core::ffi::c_void),
            Err(_) => 0,
        }
    }
    #[cfg(not(windows))]
    {
        let _ = win;
        0
    }
}

/// 把它从任务栏上摘掉（见 win_style::hide_from_taskbar 里的说明）
pub fn hide_from_taskbar(win: &tauri::WebviewWindow) {
    #[cfg(windows)]
    {
        if let Ok(h) = win.hwnd() {
            win_style::hide_from_taskbar(h.0 as *mut core::ffi::c_void);
        }
    }
    #[cfg(not(windows))]
    {
        let _ = win;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn corner_falls_back_to_bottom_right() {
        assert_eq!(normalize_corner("br"), "br");
        assert_eq!(normalize_corner(" TL "), "tl");
        assert_eq!(normalize_corner("左上"), "br");
        assert_eq!(normalize_corner(""), "br");
    }

    #[test]
    fn unit_and_pm1_survive_nan() {
        assert_eq!(unit(f32::NAN, 0.3), 0.3);
        assert_eq!(unit(2.0, 0.3), 1.0);
        assert_eq!(unit(-1.0, 0.3), 0.0);
        assert_eq!(pm1(f32::NAN), 0.0);
        assert_eq!(pm1(5.0), 1.0);
    }

    #[test]
    fn sleeping_beats_every_mood() {
        let mut s = crate::state::CharState::default();
        s.mood = "雀跃".to_string();
        s.body.asleep = true;
        assert_eq!(variant_of(&s), "sleepy");
    }

    #[test]
    fn tired_eyes_also_mean_sleepy() {
        let mut s = crate::state::CharState::default();
        s.body.sleepiness = 0.8;
        s.mood = "开心".to_string();
        assert_eq!(variant_of(&s), "sleepy");
    }

    #[test]
    fn fast_heart_and_warm_means_shy() {
        let mut s = crate::state::CharState::default();
        s.body.heart_rate = 110;
        s.body.warmth = 0.8;
        assert_eq!(variant_of(&s), "shy");
    }

    #[test]
    fn mood_words_win_over_numbers() {
        let mut s = crate::state::CharState::default();
        // 数值看着不错，但模型手写的词是"烦"
        s.valence = 0.6;
        s.arousal = 0.8;
        s.mood = "有点烦躁".to_string();
        assert_eq!(variant_of(&s), "angry");
    }

    #[test]
    fn numbers_are_the_fallback() {
        let mut s = crate::state::CharState::default();
        s.mood = "说不清".to_string();
        s.valence = 0.5;
        s.arousal = 0.8;
        assert_eq!(variant_of(&s), "smug");
        s.arousal = 0.4;
        assert_eq!(variant_of(&s), "happy");
        s.valence = -0.5;
        s.arousal = 0.2;
        assert_eq!(variant_of(&s), "sad");
        s.valence = 0.0;
        assert_eq!(variant_of(&s), "neutral");
    }

    /// 变体名必须都落在 avatar::VARIANTS 里 —— 拼错一个字母就是"图在那儿但永远用不到"
    #[test]
    fn every_variant_is_a_real_one() {
        for v in ["neutral", "happy", "smug", "angry", "sad", "sleepy", "shy"] {
            assert!(crate::avatar::is_variant(v), "{v} 不是合法变体");
        }
    }

    /// ★动作名会变成磁盘路径★ —— 这条是安全边界，不是格式检查
    #[test]
    fn clip_names_are_kept_but_dangerous_ones_are_rejected() {
        // 中文名字必须原样保留：洗成 ASCII 就一个素材也找不到了
        assert_eq!(safe_clip_name("待机呼吸休闲"), "待机呼吸休闲");
        assert_eq!(safe_clip_name("点击回应-傲娇生气"), "点击回应-傲娇生气");
        assert_eq!(safe_clip_name("  螃蟹走路  "), "螃蟹走路");
        // 路径穿越 / 分隔符 / 隐藏文件，一律不接受
        assert_eq!(safe_clip_name("../../config"), "");
        assert_eq!(safe_clip_name("a/b"), "");
        assert_eq!(safe_clip_name("a\\b"), "");
        assert_eq!(safe_clip_name(".."), "");
        assert_eq!(safe_clip_name(".hidden"), "");
        // 空 / 超长 / 控制字符 / Windows 保留字符
        assert_eq!(safe_clip_name(""), "");
        assert_eq!(safe_clip_name("   "), "");
        assert_eq!(safe_clip_name(&"喂".repeat(81)), "");
        assert_eq!(safe_clip_name("a\nb"), "");
        assert_eq!(safe_clip_name("a:b"), "");
    }

    /// 没装素材时 `clip_names` 必须是空表（页面靠它决定要不要走立绘那条老路）
    #[test]
    fn clip_names_is_empty_when_nothing_installed() {
        // 不碰真实磁盘：只钉住"空目录 → 空表"这条契约。
        // （真实数据目录里有素材也不能影响这条断言，所以这里不读它的返回值内容。）
        let names = clip_names();
        assert!(names.iter().all(|n| !n.is_empty()), "名字不该有空串：{names:?}");
    }

    /// 池子必须**过滤到本地真装了的**素材：一个都没装时每个池子都该是空的。
    ///
    /// 【为什么这条重要】上游那 106 段素材不进仓库，谁装到哪一步都是可能的
    /// （只下第一批 6 段 / 下了一半 / 全下）。菜单里列出没下的名字，点下去只会静默失败
    /// —— 那比"菜单短一点"糟得多。
    #[test]
    fn pools_are_empty_when_nothing_is_installed() {
        let p = pools_for(&[]);
        assert_eq!(p["idle"].as_array().map(|a| a.len()), Some(0));
        assert_eq!(p["turn"].as_array().map(|a| a.len()), Some(0));
        assert_eq!(p["drag"].as_array().map(|a| a.len()), Some(0));
        assert_eq!(p["clicks"].as_array().map(|a| a.len()), Some(0));
        assert_eq!(p["moves"]["actions"].as_array().map(|a| a.len()), Some(0));
        assert_eq!(p["categories"].as_array().map(|a| a.len()), Some(0));
        assert_eq!(p["events"].as_object().map(|o| o.len()), Some(0));
        // 权重是**配置**的一部分，跟装没装素材无关 —— 它必须原样留着，
        // 否则页面拿不到 idle/turn/move 的比例（掷骰会退到写死的兜底值）
        assert_eq!(p["weight"]["idle"].as_u64(), Some(10));
    }

    /// 装了什么就留什么（拿上游第一批那 6 段当样本）
    #[test]
    fn pools_keep_what_is_installed() {
        let installed: Vec<String> = ["待机呼吸休闲", "点击回应-傲娇生气"]
            .iter()
            .map(|s| s.to_string())
            .collect();
        let p = pools_for(&installed);
        assert_eq!(p["idle"], serde_json::json!(["待机呼吸休闲"]));
        assert_eq!(p["clicks"], serde_json::json!(["点击回应-傲娇生气"]));
        assert_eq!(p["turn"].as_array().map(|a| a.len()), Some(0), "没装的池子不该冒出来");
        // 分类池是"整池过滤"：一个动作都没装的分类整个消失，不留一个点不动的分组
        assert_eq!(p["categories"].as_array().map(|a| a.len()), Some(0));
    }

    /// 工作状态档位只认那六个（别的一律忽略 —— 它决定她播哪一段动画），空串 = 空闲
    #[test]
    fn stage_only_accepts_known_values() {
        set_stage("乱写的");
        assert_eq!(stage(), "", "不认识的档位不该落进状态里");
        set_stage("working");
        assert_eq!(stage(), "working");
        set_stage("");
        assert_eq!(stage(), "", "空串是合法的'空闲'，要能把档位清掉");
    }
}
