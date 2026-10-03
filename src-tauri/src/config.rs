//! 应用配置：当前激活人设 + 注入策略。
//!
//! 落点：%APPDATA%\ds-companion\config.json（原子写）。
//! 字段用 camelCase，前端按 JS 习惯传参 —— 这是踩过的坑：
//! 结构体少了 rename_all 会让 serde 静默丢字段、代码悄悄退到默认值。

use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use crate::personas::app_root;

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AppConfig {
    /// 激活的人设 id（None = 不注入人设）
    pub active_persona: Option<String>,
    /// 注入节奏：off 关 / first 仅新会话首条 / every 每轮
    pub cadence: String,
    /// 「暂停人设注入」之前用的是哪个节奏（托盘那个勾选项用它恢复）。
    ///
    /// 【为什么不直接恢复成 first】主人可能一直用 every，暂停一下再打开却掉回 first ——
    /// 那不是"恢复"，是"改配置"。记住原值才对得起那个勾选框。
    #[serde(default)]
    pub cadence_before_pause: Option<String>,
    /// 记忆总开关（与人设节奏独立：人设可以只注首条，记忆按需每轮挑）
    #[serde(default = "default_true")]
    pub memory_enabled: bool,
    /// 记忆注入的 token 预算（每轮上限，卡成本的闸）
    #[serde(default = "default_memory_budget")]
    pub memory_budget: u32,
    /// 记忆整理用的专用会话 id（B 链路复用，别每次新建刷屏侧边栏）
    #[serde(default)]
    pub memory_session_id: Option<String>,
    /// 自动整理：每跑完 N 轮对话自动整理一次（0 = 只手动）。
    /// **默认 0** —— 自动整理会自己花网页额度，必须是主人显式打开的功能。
    #[serde(default)]
    pub extract_every_turns: u32,
    /// 隐藏会话「接着往下写」的上限：每整理/判断 N 次换一个新会话（0 = 一直往下接不轮换）。
    ///
    /// 会话接着往下写（parent = 上一条消息）才不会在侧边栏里表现成
    /// "一条消息被反复改写"，代价是每次请求都要带上该会话已有的历史 ——
    /// 所以必须有上限，这是成本闸。默认 20。
    #[serde(default = "default_chain_turns")]
    pub hidden_chain_turns: u32,

    // ── 状态层 / 回锚 / 感知 / 空闲主动（都是"默认保守"的成本闸） ──
    /// 状态层总开关：注入【状态】块 + 页面 HUD
    #[serde(default = "default_true")]
    pub state_enabled: bool,
    /// 人设回锚：每 N 轮补一次【回锚】防漂移（0 = 关）。默认 20 轮。
    /// 注意 cadence=every 时不再回锚（人设本来就每轮都在，回锚是重复花钱）
    #[serde(default = "default_anchor_every")]
    pub anchor_every_turns: u32,
    /// 情绪感知模式：off / local（零成本启发式）/ model（走 B 链路，多花一次额度）
    #[serde(default = "default_sense_mode")]
    pub sense_mode: String,
    /// 模型感知的第一道闸：距上次至少过这么多轮才允许再看
    #[serde(default = "default_sense_every")]
    pub sense_every_turns: u32,
    /// 模型感知的第二道闸：当日额度上限（0 = 不限）
    #[serde(default = "default_sense_cap")]
    pub sense_daily_cap: u32,
    /// 空闲主动：off / local（零成本话术）/ model（走 B 链路自己想说）
    #[serde(default = "default_proactive_mode")]
    pub proactive_mode: String,
    /// 多久没动静算空闲（分钟）
    #[serde(default = "default_idle_minutes")]
    pub proactive_idle_minutes: u32,
    /// 主动的当日上限（防打扰也防花钱）
    #[serde(default = "default_proactive_cap")]
    pub proactive_daily_cap: u32,
    /// 页面右下角状态 HUD
    #[serde(default = "default_true")]
    pub hud_enabled: bool,
    /// 虚拟身体层（困倦/体力/饿/心跳）注入进【状态】块
    #[serde(default = "default_true")]
    pub body_enabled: bool,
    /// 把"对方（主人）此刻什么状态"一并注入 —— 角色据此收着点
    #[serde(default = "default_true")]
    pub user_state_enabled: bool,
    /// 自我修订：off / manual（只有主人点才反思）/ auto（每 N 轮自己反思一次）。
    /// **默认 manual** —— 让角色评判自己、还可能改自己的设定，这种事不该悄悄发生。
    #[serde(default = "default_review_mode")]
    pub self_review_mode: String,
    #[serde(default = "default_review_every")]
    pub self_review_every_turns: u32,
    #[serde(default = "default_review_cap")]
    pub self_review_daily_cap: u32,

    // ── 工具层（让角色能动手：读文件 / 列目录 / 查找） ──
    //
    // 【为什么默认关 + 必须先配工作区】工具能读主人的源码，而调用请求的来源是
    // "模型在网页里吐的一段文本"，注入链路又让记忆每轮参与 prompt —— 所以要两道闸：
    // 开关默认关（跟 extract_every_turns 同一个哲学），工作区为空则一律拒绝执行。
    #[serde(default)]
    pub tools_enabled: bool,
    /// 工作区：工具唯一能碰的目录。空 = 工具全部拒绝（绝不"猜一个目录"）
    #[serde(default)]
    pub workspace: String,
    /// 工具当日调用上限（每条调用 = 一次网页请求 = 一份额度）
    #[serde(default = "default_tool_cap")]
    pub tool_daily_cap: u32,
    /// 一轮对话里最多连续调用几次（防它自己绕圈烧额度）
    #[serde(default = "default_tool_per_turn")]
    pub tool_max_per_turn: u32,
    /// **写工具**（write_file）的开关。默认关，而且它跟 `tools_enabled` 是两道独立的门：
    /// 只读工具开着，不等于允许她改文件。
    ///
    /// 开着的含义仅仅是"允许她把 write_file 提出来"，**不是"允许她写"**——
    /// 每一次写入都要落成提案、由主人点确认才执行（见 `tools::propose_write` / `decide_proposal`）。
    /// 为什么不做成"开了就随便写"：文件被改就可能不可逆（没有 git 的目录里尤其如此），
    /// 而调用请求的来源是一段模型文本、链路上还夹着记忆注入 —— 任何一环被污染，
    /// 代价都是主人的文件。点那一下确认，是这条链路上唯一兜得住的东西。
    #[serde(default)]
    pub tools_write_enabled: bool,

    // ── 任务模式 ──
    /// 任务模式：auto（本地启发式自动判定）/ on（一直当在工作）/ off（一直当在日常）。
    ///
    /// **默认 auto** —— 它零成本（纯关键词，不上 LLM），而且不开的话"干活被情绪拖后腿"
    /// 那个毛病就一直在。手动 on/off 是给"它判错了"准备的逃生口。
    #[serde(default = "default_task_mode")]
    pub task_mode: String,

    // ── 总开关 ──
    /// **注入总开关**：关掉之后一个字节都不往 `body.prompt` 里加 —— 就是"把它当普通浏览器用"。
    ///
    /// 【为什么需要】原来没有单一总开关：`cadence` 只管**人设块**，状态 / 工具 / 回锚
    /// 各自还按各自的开关照常注入，想完全静默得逐个关掉（README §6 与 inject.js 的注释
    /// 都把这条记成已知缺口）。这道闸是唯一的总闸：关 = 页面侧直接跳过整条注入路径。
    #[serde(default = "default_true")]
    pub inject_enabled: bool,
}

fn default_task_mode() -> String {
    "auto".into()
}

fn default_tool_cap() -> u32 {
    20
}

fn default_tool_per_turn() -> u32 {
    3
}

fn default_true() -> bool {
    true
}

fn default_memory_budget() -> u32 {
    500
}

fn default_anchor_every() -> u32 {
    20
}

fn default_chain_turns() -> u32 {
    20
}

fn default_sense_mode() -> String {
    // 本地启发式是零成本的，默认开着；让模型判断情绪默认关（要花额度）
    "local".into()
}

fn default_sense_every() -> u32 {
    // 【为什么从 12 降到 4】模型感知是"到点必问"的（见 state::want_model_sense），
    // 12 轮意味着日常对话里状态有十几轮拿不到语境判断 —— 而网页版走套餐额度，
    // 不按 token 计费（主人 2026-10-01 明确："网页本来也不花钱怕什么"）。
    // 4 轮一次 ≈ 一天几十轮里问十几次，够"实时"，也不至于每轮都在发请求。
    4
}

fn default_sense_cap() -> u32 {
    30
}

fn default_idle_minutes() -> u32 {
    20
}

/// 缺字段时要落成 "off" 而不是空串 —— 空串在配置里看着像"没配"，容易误判；
/// 而且 Rust 侧虽然把非 local/model 一律当关，文件里也不该出现这种暧昧值。
fn default_proactive_mode() -> String {
    "off".into()
}

fn default_review_mode() -> String {
    "manual".into()
}

fn default_review_every() -> u32 {
    30
}

fn default_review_cap() -> u32 {
    10
}

fn default_proactive_cap() -> u32 {
    6
}

impl Default for AppConfig {
    fn default() -> Self {
        Self {
            active_persona: None,
            cadence: "first".into(),
            cadence_before_pause: None,
            memory_enabled: true,
            memory_budget: 500,
            memory_session_id: None,
            extract_every_turns: 0,
            hidden_chain_turns: 20,
            state_enabled: true,
            anchor_every_turns: 20,
            sense_mode: default_sense_mode(),
            sense_every_turns: default_sense_every(),
            sense_daily_cap: 30,
            proactive_mode: default_proactive_mode(),
            proactive_idle_minutes: 20,
            proactive_daily_cap: 6,
            hud_enabled: true,
            body_enabled: true,
            user_state_enabled: true,
            self_review_mode: default_review_mode(),
            self_review_every_turns: 30,
            self_review_daily_cap: 10,
            tools_enabled: false,
            workspace: String::new(),
            tool_daily_cap: default_tool_cap(),
            tool_max_per_turn: default_tool_per_turn(),
            tools_write_enabled: false,
            task_mode: default_task_mode(),
            inject_enabled: true,
        }
    }
}

pub fn config_path() -> PathBuf {
    app_root().join("config.json")
}

/// 读配置。**坏文件不静默**：解析不了就把文件隔离成 `.bad-<戳>` + 写日志，
/// 然后才回默认值 —— 旧的 `unwrap_or_default()` 会让一份坏 JSON 悄悄抹掉
/// 主人选好的人设，日志里一个字都没有（对照 state.rs 的 load_state 同理）。
pub fn load() -> AppConfig {
    let path = config_path();
    let Ok(text) = std::fs::read_to_string(&path) else {
        // 读不到 = 还没配过，这不算错
        return AppConfig::default();
    };
    match serde_json::from_str::<AppConfig>(&text) {
        Ok(cfg) => cfg,
        Err(e) => {
            crate::personas::recover_bad_file(&path, &format!("config.json: {e}"));
            AppConfig::default()
        }
    }
}

pub fn save(cfg: &AppConfig) -> Result<(), String> {
    let path = config_path();
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let text = serde_json::to_string_pretty(cfg).map_err(|e| e.to_string())?;
    let tmp = path.with_extension("json.tmp-write");
    std::fs::write(&tmp, text.as_bytes()).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &path).map_err(|e| e.to_string())
}

/// 交给页面注入脚本的载荷（正文/记忆一起带上，页面侧不用再回问一次）。
///
/// 记忆是**按可见性过滤后**整库给过去的：检索要在页面里同步跑（钩子在 send()
/// 里同步改 body），所以 Rust 不做选择，只负责"哪些是可见的"。
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct InjectPayload {
    pub cadence: String,
    pub persona_id: Option<String>,
    pub persona_name: Option<String>,
    pub persona_text: String,
    pub memory_enabled: bool,
    pub memory_budget: u32,
    /// 页面自己数「攒了几轮还没整理」，攒够这个数就自动整理（0 = 关）
    pub extract_every_turns: u32,
    /// 隐藏会话接着往下写的上限：页面侧 ask() 用它决定攒够几次换个新会话（0 = 不轮换）
    pub hidden_chain_turns: u32,
    /// 可见记忆：**连带权重一起**给过去（页面侧的检索要用 weight 判"够不够格参与"）
    pub memories: Vec<crate::memory::WeightedMemory>,

    // ── 状态 / 回锚 / 感知 / 空闲主动 ──
    pub state_enabled: bool,
    /// 当前角色的状态快照（页面 HUD 与门控判断都用它）
    pub state: crate::state::CharState,
    /// 【状态】块（Rust 渲染好；每轮之后由 dsc_turn_report 刷新）
    pub state_text: String,
    /// 【回锚】块（同上）
    pub anchor_text: String,
    /// 回锚间隔：页面按会话轮数自己数（0 = 不回锚）
    pub anchor_every_turns: u32,
    pub hud_enabled: bool,
    pub sense_mode: String,
    pub sense_every_turns: u32,
    pub sense_daily_cap: u32,
    pub proactive_mode: String,
    pub proactive_idle_minutes: u32,
    pub proactive_daily_cap: u32,
    /// 身体层 / 对方状态各自的开关（页面据此决定显示哪几行）
    pub body_enabled: bool,
    pub user_state_enabled: bool,
    /// 对方（主人）的状态 —— 由文本 + 历史推断，页面 HUD 也会显示
    pub user_state: crate::state::UserState,
    /// 自我修订：模式与间隔（页面据此决定要不要自己反思；当日额度在 Rust 侧扣）
    pub self_review_mode: String,
    pub self_review_every_turns: u32,
    pub self_review_daily_cap: u32,
    /// 待审阅的提案数（角标/界面提示用，省得页面再问一次）
    pub pending_proposals: usize,

    // ── 工具层 ──
    /// 工具总开关（页面据此决定要不要解析/执行 dsc-tool 调用）
    pub tools_enabled: bool,
    /// 一轮最多连续调几次（页面侧数的，Rust 只给上限）
    pub tool_max_per_turn: u32,
    /// 【可用工具】块（Rust 渲染好；空 = 没开或没配工作区，页面就别解析调用）
    pub tool_text: String,

    /// 注入总开关：关 = 页面侧整条注入路径直接跳过（连轮数都不推进），当普通浏览器用
    pub inject_enabled: bool,
}

pub fn inject_payload() -> InjectPayload {
    let cfg = load();
    // 生效的人设：配置里没选 → **出厂默认角色**（DeepSeek 娘）；选「原版」→ 不注入。
    // 三态语义与兜底规则见 `personas::effective_persona`。
    let persona = crate::personas::effective_persona(cfg.active_persona.as_deref());
    let character_id = crate::personas::active_character_id(cfg.active_persona.as_deref());

    // 可见性：全局（无角色）+ 当前激活角色的。
    // 没有角色激活时，带角色的记忆一条都不给（沿用 gal 的语义）。
    //
    // 顺序用**权重降序**（`list_weighted`）：importance 打底、随时间衰减、被用到回血。
    // 页面按字数预算截断时是从头开始取的，所以这个顺序就是"谁会进上下文"的答案。
    //
    // 【为什么整条链路都带权重】页面侧（selector.js）要用它做两件事：
    //   ① "触发词没命中时这条够不够格参与"的判定（原来只看 importance >= 4）；
    //   ② 打分排序。只给 item 的话页面拿不到 `weight_of` 的结果，衰减/回血等于白算。
    let memories = if cfg.memory_enabled {
        crate::memory::list_weighted()
            .into_iter()
            .filter(|w| w.item.character_id.is_empty() || w.item.character_id == character_id)
            .collect()
    } else {
        Vec::new()
    };

    // 状态层：只认"有角色"的情况（没有角色就没有"内心状态"可言）
    let st = if cfg.state_enabled && !character_id.is_empty() {
        crate::state::load_state(&character_id)
    } else {
        crate::state::CharState::default()
    };
    let user_state = crate::state::load_user_state();
    let (state_text, anchor_text) = if cfg.state_enabled && !character_id.is_empty() {
        (
            crate::state::render_state_block(
                &st,
                if cfg.body_enabled { Some(&st.body) } else { None },
                if cfg.user_state_enabled { Some(&user_state) } else { None },
                crate::state::now(),
                // 这里给的是"配置推送时的初始载荷"：任务模式是每轮算的实时值，
                // 页面拿到之后会被 dsc_turn_report 的结果覆盖。所以这里按日常态给全量块，
                // 让主人一打开页面就看到完整状态；工作态压缩由每一轮的回报负责。
                false,
            ),
            crate::state::render_anchor_block(
                &st,
                persona.as_ref().map(|p| p.name.as_str()).unwrap_or(""),
                persona.as_ref().map(|p| p.body.as_str()).unwrap_or(""),
                &st.addendum,
            ),
        )
    } else {
        (String::new(), String::new())
    };

    InjectPayload {
        cadence: cfg.cadence.clone(),
        persona_id: persona.as_ref().map(|p| p.id.clone()),
        persona_name: persona.as_ref().map(|p| p.name.clone()),
        persona_text: persona.as_ref().map(|p| p.body.clone()).unwrap_or_default(),
        memory_enabled: cfg.memory_enabled,
        memory_budget: cfg.memory_budget,
        extract_every_turns: cfg.extract_every_turns,
        hidden_chain_turns: cfg.hidden_chain_turns,
        memories,
        state_enabled: cfg.state_enabled && !character_id.is_empty(),
        state: st.clone(),
        state_text: state_text.clone(),
        anchor_text: anchor_text.clone(),
        anchor_every_turns: cfg.anchor_every_turns,
        hud_enabled: cfg.hud_enabled,
        sense_mode: cfg.sense_mode.clone(),
        sense_every_turns: cfg.sense_every_turns,
        sense_daily_cap: cfg.sense_daily_cap,
        proactive_mode: cfg.proactive_mode.clone(),
        proactive_idle_minutes: cfg.proactive_idle_minutes,
        proactive_daily_cap: cfg.proactive_daily_cap,
        body_enabled: cfg.body_enabled,
        user_state_enabled: cfg.user_state_enabled,
        user_state,
        self_review_mode: cfg.self_review_mode.clone(),
        self_review_every_turns: cfg.self_review_every_turns,
        self_review_daily_cap: cfg.self_review_daily_cap,
        pending_proposals: crate::propose::list(&character_id)
            .iter()
            .filter(|p| p.status == "pending")
            .count(),
        // 工具块：没开 / 没配工作区 / 当日额度用完 -> 空串（页面就不会去解析调用，
        // 也不会白给模型一段"你能用工具"的诱饵去浪费一轮）
        tools_enabled: cfg.tools_enabled,
        tool_max_per_turn: cfg.tool_max_per_turn,
        tool_text: crate::tools::inject_block(&cfg),
        inject_enabled: cfg.inject_enabled,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 默认值是有语义的（"装好就该是这样"），所以单独盯住：
    /// 节奏只注首条（省额度）、自动整理关闭（不许不点就花钱）。
    #[test]
    fn defaults_are_cost_safe() {
        let d = AppConfig::default();
        assert_eq!(d.cadence, "first", "默认只注首条 —— 每轮太贵");
        assert_eq!(d.extract_every_turns, 0, "自动整理默认必须关 —— 它会自己花额度");
        assert_eq!(d.hidden_chain_turns, 20, "隐藏会话往下接必须封顶：默认每 20 次换新会话");
        assert!(d.memory_enabled);
        assert_eq!(d.active_persona, None);
        assert!(d.inject_enabled, "总开关默认必须开着 —— 装好就该照常注入");
    }

    /// 老 config.json 没有新字段时不能整份解析失败、悄悄退到全默认
    /// （那会把主人已经选好的人设抹掉）
    #[test]
    fn old_config_keeps_persona_when_new_fields_missing() {
        let json =
            r#"{"activePersona":"dsh-luna","cadence":"every","memoryEnabled":true,"memoryBudget":2000}"#;
        let c: AppConfig = serde_json::from_str(json).unwrap();
        assert_eq!(c.active_persona.as_deref(), Some("dsh-luna"));
        assert_eq!(c.cadence, "every");
        assert_eq!(c.memory_budget, 2000);
        assert_eq!(c.extract_every_turns, 0, "缺字段 = 关");
        assert_eq!(c.hidden_chain_turns, 20, "缺字段 = 默认 20 次换新会话");
        assert_eq!(c.memory_session_id, None);
    }

    /// 前端按 camelCase 传参：字段名对不上会静默丢值（Quill 踩过的老坑）
    #[test]
    fn camel_case_roundtrip() {
        let c = AppConfig {
            active_persona: Some("dsh-michiyo".into()),
            extract_every_turns: 20,
            ..AppConfig::default()
        };
        let json = serde_json::to_string(&c).unwrap();
        assert!(json.contains("\"extractEveryTurns\":20"), "{json}");
        assert!(json.contains("\"activePersona\":\"dsh-michiyo\""), "{json}");
        // 前端按 camelCase 读，键名必须一致
        assert!(json.contains("\"anchorEveryTurns\""), "{json}");
        assert!(json.contains("\"senseEveryTurns\""), "{json}");
        assert!(json.contains("\"proactiveIdleMinutes\""), "{json}");
        let back: AppConfig = serde_json::from_str(&json).unwrap();
        assert_eq!(back.extract_every_turns, 20);
        assert_eq!(back.anchor_every_turns, 20);
        assert_eq!(back.sense_mode, "local");
    }

    /// 状态层/感知/主动的默认值也是"成本闸"，单独盯住
    #[test]
    fn state_and_sensing_defaults_are_conservative() {
        let d = AppConfig::default();
        assert!(d.state_enabled, "状态注入是零成本的连贯性来源，默认开");
        assert_eq!(d.anchor_every_turns, 20, "回锚默认 20 轮一次");
        assert_eq!(d.sense_mode, "local", "本地感知零成本，默认开");
        assert_eq!(d.proactive_mode, "off", "空闲主动默认必须关 —— 它可能自己发请求");
        assert_eq!(d.proactive_daily_cap, 6, "就算开了也别刷屏");
        assert!(d.sense_daily_cap > 0, "模型感知要有当日闸");
        assert!(d.hud_enabled);
    }

    /// 端到端：一份坏 config.json 必须被隔离成 `.bad-*`，而不是被下一次保存悄悄覆盖。
    ///
    /// 这条测的是 load() 与 recover_bad_file 的接线 —— 单测 recover_bad_file 本身
    /// 只能证明"它会改名"，证明不了"load 真的调了它"（Quill 上踩过替身比真机宽容的坑）。
    /// 用 DSC_DATA_DIR 指到临时目录，所以碰不到主人的真配置。
    #[test]
    fn broken_config_is_quarantined_end_to_end() {
        crate::tests::lock_test_data_dir();
        // 用**全局**那把锁：它和 tools 里会写配置的写工具用例必须互斥（见 CONFIG_LOCK 的注释）
        let _guard = crate::tests::CONFIG_LOCK
            .lock()
            .unwrap_or_else(|e| e.into_inner());

        let dir = std::path::PathBuf::from(std::env::var("DSC_DATA_DIR").unwrap_or_default());
        std::fs::create_dir_all(&dir).unwrap();

        std::fs::write(config_path(), b"{ broken").unwrap();
        let cfg = load();
        assert_eq!(cfg.active_persona, None, "坏文件的读法只能是默认值");
        assert!(!config_path().exists(), "坏文件必须已被挪走");
        let bads: Vec<_> = std::fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .filter(|e| {
                let n = e.file_name().to_string_lossy().to_string();
                n.starts_with("config.json.bad-")
            })
            .collect();
        assert_eq!(bads.len(), 1, "应当留下一份 config.json.bad-* 证据：{bads:?}");
        // 清掉证据，免得同一进程里重跑时越攒越多
        for e in bads {
            let _ = std::fs::remove_file(e.path());
        }

        // 正常路径不受影响：写一份好配置再读回来，人设要还在
        let mut good = AppConfig::default();
        good.active_persona = Some("dsh-luna".into());
        save(&good).unwrap();
        assert_eq!(load().active_persona.as_deref(), Some("dsh-luna"));
    }
}
