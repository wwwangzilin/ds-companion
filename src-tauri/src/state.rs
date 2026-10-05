//! 角色状态：心情 / 好感 / 精力 / 处境 / 回锚锚点。
//!
//! 为什么要有这个：人设只注首条（或每轮）都只能告诉模型"你是谁"，告诉不了它
//! "你俩现在到哪一步了"。聊几十轮之后角色会飘：忘了亲密度、语气忽冷忽热、
//! 人设被对话带跑。状态层就是把「此刻你是谁、你俩什么关系、刚才发生了什么」
//! 压缩成几十个 token，每轮带上 —— 这是连贯性的来源。
//!
//! 落点：%APPDATA%\ds-companion\state\<characterId>.json（人可读、原子写）。
//! 结构选 JSON 不选 frontmatter：它是**机器状态**（要 clamp、要画曲线），
//! 不是给人写给人读的散文；编辑入口在设置界面。
//!
//! 【成本闸】本地感知（sense_text）纯启发式、零额度；让模型判断情绪是另一条
//! 可选链路（页面侧 sense.js），默认关闭且带轮数/当日额度双闸。

use std::fs;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use crate::personas::{app_root, safe_id};

/// 曲线只留最近这么多点（够画一条趋势，又不会让状态文件无限长大）
pub const SAMPLE_LIMIT: usize = 40;
/// 没有激活角色时的兜底 id
pub const GLOBAL_ID: &str = "_global";

pub fn state_dir() -> PathBuf {
    app_root().join("state")
}

pub fn ensure_dir() -> std::io::Result<()> {
    fs::create_dir_all(state_dir())
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// 给别的模块用（渲染"认识第 N 天"要当前时间）
pub fn now() -> u64 {
    now_ms()
}

fn clamp01(v: f32) -> f32 {
    if v.is_nan() {
        return 0.0;
    }
    v.clamp(0.0, 1.0)
}

fn clamp_pm1(v: f32) -> f32 {
    if v.is_nan() {
        return 0.0;
    }
    v.clamp(-1.0, 1.0)
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct StateSample {
    pub t: u64,
    pub valence: f32,
    pub arousal: f32,
    pub affinity: u8,
}

/// 按天聚合的一个点（**长期**走势用）。
///
/// 【为什么不复用 `samples`】那个只留最近 40 次采样 —— 够看出"这一晚的起伏"，
/// 但看不出"这一个月好感怎么涨的"：40 轮很可能只是一个晚上聊出来的。
/// 一天一行的代价是几十字节（90 天上限 ≈ 几 KB），而"养成感"恰恰来自长期曲线。
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct DailyPoint {
    /// `YYYY-MM-DD`（**页面报上来的本地日期**，见 `fold_daily` 的说明）
    pub day: String,
    /// 当天最后记录的好感（0-100）
    pub affinity: u8,
    /// 当天情绪的滚动均值（-1..1）
    pub valence: f32,
    /// 当天聊了几轮
    pub turns: u32,
}

/// 长期曲线保留多少天。90 天足够看出趋势，又不至于把状态文件撑大。
pub const DAILY_LIMIT: usize = 90;

// ─────────────────────── 虚拟身体层 ───────────────────────
//
// 为什么要它：心理状态（心情/好感）回答"她怎么想"，身体层回答"她现在是什么感受"——
// 困不困、饿不饿、心跳快不快。有了它，角色才会写出"困得眼皮打架还在陪你聊"这种
// 有质感的话，而不是永远精力充沛地客套。
//
// 关键性质：**随时间自己变**。哪怕主人一整天不出现，困倦也会涨、体力也会掉 ——
// 身体是唯一能证明"你不在的时候她也在活着"的东西。

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(default, rename_all = "camelCase")]
pub struct Body {
    /// 0..1 体力
    pub stamina: f32,
    /// 0..1 困倦
    pub sleepiness: f32,
    /// 0..1 饥饿
    pub hunger: f32,
    /// 0..1 被在意的温度（互动会升，久不理会降）
    pub warmth: f32,
    /// 心跳 bpm
    pub heart_rate: u32,
    /// 0..1 呼吸急促度
    pub breath: f32,
    /// 睡着了（长时间不理 + 深夜/很困）
    pub asleep: bool,
    /// 派生字段：可见的身体语言（"眼皮直打架"）。每次落盘/读盘重算 ——
    /// 单一真相源在 Rust，界面和注入都只读它，免得两边各推一套说法。
    pub language: String,
    /// 上次推进身体的时间（醒来/流逝都从它算）
    pub last_body_at: u64,
}

impl Default for Body {
    fn default() -> Self {
        Self {
            stamina: 0.85,
            sleepiness: 0.2,
            hunger: 0.25,
            warmth: 0.5,
            heart_rate: 72,
            breath: 0.25,
            asleep: false,
            language: String::new(),
            last_body_at: 0,
        }
    }
}

/// 身体随时间流逝。返回一句"发生了什么"（睡了一觉 / 困到睡着），给日志和界面用。
///
/// 一条硬约定：**睡一觉要看"离开了多久"而不是猜**。4 小时以上没人理、又是深夜或
/// 本来就困，就当她睡过了 —— 醒来时困倦清零、体力回满、肚子饿。
pub fn apply_body_elapsed(b: &mut Body, now: u64, hour: u32) -> Option<String> {
    if b.last_body_at == 0 {
        b.last_body_at = now;
        return None;
    }
    if now <= b.last_body_at {
        return None;
    }
    // 最多只补 24 小时：中间关机几天的话不该一次算成"困了几百小时"
    let hours = (((now - b.last_body_at) as f32) / 3_600_000.0).min(24.0);
    if hours < 0.02 {
        return None;
    }
    let night = hour < 7 || hour >= 23;
    b.last_body_at = now;

    if hours >= 4.0 && (b.sleepiness >= 0.5 || night) {
        b.asleep = false;
        b.sleepiness = 0.15;
        b.stamina = clamp01(b.stamina + 0.75);
        b.hunger = clamp01(b.hunger + 0.25);
        b.heart_rate = 72;
        b.breath = 0.25;
        return Some(format!("睡了一觉（{:.1} 小时）", hours));
    }

    b.sleepiness = clamp01(b.sleepiness + hours * if night { 0.09 } else { 0.035 });
    b.stamina = clamp01(b.stamina - hours * 0.035);
    b.hunger = clamp01(b.hunger + hours * 0.07);
    b.warmth = clamp01(b.warmth - hours * 0.06);
    let hr = (b.heart_rate as f32 * 0.97).round();
    b.heart_rate = hr.max(62.0) as u32;
    b.breath = clamp01(b.breath * 0.96);
    if b.sleepiness >= 0.92 {
        b.asleep = true;
        return Some("困到睡着了".into());
    }
    None
}

/// 一轮对话之后身体的变化：被搭理会精神一点、心跳跟着情绪走。
pub fn apply_body_turn(b: &mut Body, sig: &Signal, base_arousal: f32, now: u64) {
    b.asleep = false;
    b.stamina = clamp01(b.stamina + 0.05);
    b.sleepiness = clamp01(b.sleepiness - 0.06);
    b.warmth = clamp01(b.warmth + 0.10 + sig.intensity * 0.05);
    // 【这是 hunger 唯一的下降通路】原来它只有加法：时间流逝 +0.07/小时、每轮 +0.01、
    // 睡醒还要 +0.25 —— 一路涨到 100% 就再也回不来。主人报的"饿的状态怎么也解除不了，
    // 即使我喂她吃东西"就是这个：系统里根本没有"吃东西"这回事。
    if sig.fed {
        feed(b, 0.45); // 一顿正餐的量
    } else {
        b.hunger = clamp01(b.hunger + 0.01);
    }
    let target = 68.0 + clamp01(base_arousal) * 45.0;
    b.heart_rate = (b.heart_rate as f32 * 0.55 + target * 0.45).round() as u32;
    b.breath = clamp01(0.25 + clamp01(base_arousal) * 0.6);
    b.last_body_at = now;
}

/// 喂一顿：hunger 降，顺带回一点体力和暖意。
///
/// 【参数是"这一顿多大"而不是"吃到几分饱"】后者会让连着喂两顿变成幂等的
/// —— 那样"多喂一点"就失去意义了。
pub fn feed(b: &mut Body, amount: f32) {
    b.hunger = clamp01(b.hunger - amount.clamp(0.0, 1.0));
    b.stamina = clamp01(b.stamina + 0.15);
    b.warmth = clamp01(b.warmth + 0.05);
}

// ─────────────────── 通路自检（每个数值有没有出口）───────────────────

/// 一条"通路"告警。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Vital {
    /// 哪个数值（hunger / mood / affinity / sleep / stamina）
    pub key: String,
    /// warn = 该看一眼了；bad = 已经卡住很久
    pub level: String,
    /// 一句话说清现象（带数字）
    pub text: String,
    /// 怎么办 —— 界面直接显示这句，别让主人再猜
    pub hint: String,
}

/// 通路自检：**每个数值有没有出口**。
///
/// 【它要防什么】2026-10-01 一天里连着三个 bug 都属于同一类：机制本身没坏，但**某条
/// 通路断了** —— 情绪信号断了（冻结在 0.00）、饥饿只有加法没有减法、状态页被挤成
/// 一条缝够不着。它们的共同点是**要人主动去发现**。这个函数把"看着正常、其实卡住"
/// 的情况变成明确的告警。
///
/// 【阈值为什么都偏保守】告警的价值在于"响了就是真有事"。宁可晚一点，也别动不动就报
/// —— 狼来了几次之后人就不看了。所以每条都要求**卡了很久**才出声。
///
/// 纯函数，能单测（见 vitals_* 那组测试）。
pub fn check_vitals(s: &CharState) -> Vec<Vital> {
    let mut out = Vec::new();

    // ① 饿着没人管：满级饥饿 + 十来轮没喂过
    if s.body.hunger >= 0.9 {
        let since_fed = s.turns.saturating_sub(s.last_fed_turn);
        if since_fed >= 12 {
            out.push(Vital {
                key: "hunger".into(),
                level: if since_fed >= 30 { "bad" } else { "warn" }.into(),
                text: format!(
                    "她饿着（{:.0}%），已经 {since_fed} 轮没人喂过",
                    s.body.hunger * 100.0
                ),
                hint: "设置 → 状态 → 「喂一顿」，或者在聊天里说「给你带了奶茶」".into(),
            });
        }
    }

    // ② 情绪信号断了：连续很多轮本地什么都读不出来（valence 会被慢回归到 0）
    if s.flat_turns >= 8 {
        out.push(Vital {
            key: "mood".into(),
            level: if s.flat_turns >= 20 { "bad" } else { "warn" }.into(),
            text: format!(
                "连续 {} 轮没从对话里读出情绪信号（心情会一直停在平静）",
                s.flat_turns
            ),
            hint: "日常聊天大多如此；想更灵敏就调「情绪感知」的间隔，或看日志里的 hits=".into(),
        });
    }

    // ③ 好感长期不动：微漂失效的信号。
    // 阈值放很高，因为好感越接近满值微漂越慢（那是设计，不是故障）——所以还要求 < 95。
    if s.affinity_stuck_turns >= 40 && s.affinity < 95 {
        out.push(Vital {
            key: "affinity".into(),
            level: "warn".into(),
            text: format!(
                "好感 {} 已经 {} 轮没动过",
                s.affinity, s.affinity_stuck_turns
            ),
            hint: "她可能一直处在工作模式（工作态不记关系账），或者情绪信号一直是 0".into(),
        });
    }

    // ④ 困过头却没睡着：这两个平时会自己回调，卡住说明时间推进没跑起来
    if s.body.sleepiness >= 0.95 && !s.body.asleep {
        out.push(Vital {
            key: "sleep".into(),
            level: "warn".into(),
            text: format!("困倦 {:.0}% 却没睡着", s.body.sleepiness * 100.0),
            hint: "设置 → 状态 里手动勾「睡着了」，或者等下一次时间推进".into(),
        });
    }
    if s.body.stamina <= 0.15 {
        out.push(Vital {
            key: "stamina".into(),
            level: "warn".into(),
            text: format!("体力只剩 {:.0}%", s.body.stamina * 100.0),
            hint: "睡一觉、或者聊几轮会回一点；一直不回来就看「虚拟身体」那几个数值".into(),
        });
    }

    out
}

/// 由身体数值推出**可见的身体语言**：界面上显示、注入里也用它。
/// 按"最明显的那个感受"排优先级，只给一句 —— 一次报五个症状像病历，不像人。
pub fn body_language(b: &Body, mood: &str) -> String {
    if b.asleep {
        return "睡着了，呼吸又轻又长".into();
    }
    if b.sleepiness >= 0.75 {
        return "眼皮直打架，脑袋一点一点的".into();
    }
    if b.hunger >= 0.72 {
        return "肚子咕咕叫，尾巴尖有气无力地晃".into();
    }
    if b.heart_rate >= 105 {
        return "心跳得厉害，耳朵尖有点烫".into();
    }
    if b.warmth >= 0.75 {
        return "挨得很近，尾巴绕在你手腕上".into();
    }
    if b.stamina <= 0.3 {
        return "蔫蔫地趴着，不太想动".into();
    }
    match mood {
        "雀跃" | "兴致高" => "尾巴摇得飞快，凑过来蹭了蹭".into(),
        "低落" | "有点闷" => "抱着膝盖缩在一边，尾巴耷拉着".into(),
        "烦躁" | "炸毛" | "有点紧绷" => "尾巴一下一下地拍着，耳朵朝后压".into(),
        _ => "安安静静地待着，尾巴慢慢晃".into(),
    }
}

pub fn render_body_line(b: &Body, mood: &str) -> String {
    let mut head = format!(
        "身体：{}（困倦 {:.0}% · 体力 {:.0}% · 饿 {:.0}% · 心跳 {}{}）",
        body_language(b, mood),
        b.sleepiness * 100.0,
        b.stamina * 100.0,
        b.hunger * 100.0,
        b.heart_rate,
        if b.asleep { " · 在睡" } else { "" }
    );
    if b.warmth >= 0.75 {
        head.push_str("（很暖）");
    }
    head
}

// ─────────────────────── 用户（主人）状态 ───────────────────────
//
// 为什么要它：角色得知道"对面这个人现在什么状态"。他累了你还追着问、他忙你还长篇
// 大论，再好人设也显得没眼力见。判断依据只能是**文本 + 历史 + 时间**：
// 消息长短、有没有忙/累的字眼、隔了多久才回来、现在几点。

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct StateSampleU {
    pub t: u64,
    pub energy: f32,
    pub engagement: f32,
    pub valence: f32,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(default, rename_all = "camelCase")]
pub struct UserState {
    pub mood: String,
    /// -1..1 情绪倾向
    pub valence: f32,
    /// 0..1 激动程度
    pub arousal: f32,
    /// 0..1 精力（累不累）
    pub energy: f32,
    /// 0..1 投入度（有没有认真在聊）
    pub engagement: f32,
    /// 当次判断：在忙
    pub busy: bool,
    /// 当次判断：累/困
    pub tired: bool,
    /// 近况一句话（也可以手改）
    pub arc: String,
    pub turns: u32,
    /// 上一条消息长度 / 长度滑动平均（看趋势用）
    pub last_len: u32,
    pub avg_len: f32,
    /// 连着说了几条（间隔 < 5 分钟算同一次）
    pub streak: u32,
    pub last_turn_at: u64,
    /// 上次交互是几点（渲染建议时要用，别在渲染里读时钟 —— 那样没法单测）
    pub last_hour: u32,
    /// 距上一条隔了多少分钟（当次）
    pub away_minutes: u32,
    pub updated_at: u64,
    pub samples: Vec<StateSampleU>,
}

impl Default for UserState {
    fn default() -> Self {
        Self {
            mood: "平静".into(),
            valence: 0.0,
            arousal: 0.25,
            energy: 0.6,
            engagement: 0.5,
            busy: false,
            tired: false,
            arc: String::new(),
            turns: 0,
            last_len: 0,
            avg_len: 0.0,
            streak: 0,
            last_turn_at: 0,
            last_hour: 12,
            away_minutes: 0,
            updated_at: 0,
            samples: Vec::new(),
        }
    }
}

const BUSY_CUES: &[&str] = &[
    "忙", "加班", "开会", "赶", "没空", "稍等", "等会", "等下", "晚点", "先不", "回头", "一会儿",
    "出去", "在路", "处理点",
];
const TIRED_CUES: &[&str] = &[
    "困", "好累", "有点累", "累死", "睡了", "晚安", "熬夜", "撑不住", "想睡", "眯", "通宵", "眼睛睁不开",
];

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct UserSignal {
    pub valence: f32,
    pub arousal: f32,
    pub intensity: f32,
    /// 这次反映出的精力水平
    pub energy: f32,
    /// 这次的投入度
    pub engagement: f32,
    pub busy: bool,
    pub tired: bool,
    /// 这条消息多长
    pub len: u32,
    /// 距上一条隔了多少分钟
    pub away_minutes: u32,
    #[serde(default)]
    pub hits: Vec<String>,
}

/// 从「一句话 + 现在几点 + 隔了多久」推用户状态。纯函数，能单测。
pub fn sense_user(text: &str, hour: u32, away_minutes: u32) -> UserSignal {
    let t = text.trim();
    let base = sense_text(t);
    let len = t.chars().count() as u32;
    let mut hits = base.hits.clone();

    let mut busy = false;
    let mut tired = false;
    for w in BUSY_CUES {
        if t.contains(w) {
            busy = true;
            if hits.len() < 10 {
                hits.push(format!("忙:{w}"));
            }
            break;
        }
    }
    for w in TIRED_CUES {
        if t.contains(w) {
            tired = true;
            if hits.len() < 10 {
                hits.push(format!("累:{w}"));
            }
            break;
        }
    }

    // 投入度：长消息 + 反问 + 亲昵都在说明"他在认真跟你说话"；
    // 一两个字又没情绪，多半是在忙或者敷衍 —— 这恰恰是最该被察觉的信号
    let lf = len as f32;
    let mut engagement = (lf / 60.0).min(1.0) * 0.7;
    if t.contains('？') || t.contains('?') || t.contains("吗") || t.contains("呢") {
        engagement += 0.15;
    }
    if base.hits.iter().any(|h| {
        matches!(h.as_str(), "主人" | "老婆" | "老公" | "宝贝" | "亲爱的" | "抱")
    }) {
        engagement += 0.15;
    }
    if len <= 4 && base.intensity == 0.0 {
        engagement = 0.15;
    }
    let engagement = clamp01(engagement);

    // 精力：有忙/累的字眼直接扣；深夜本身也是扣分项（几点是客观事实）
    let hour_penalty = match hour {
        0..=5 => 0.35,
        6..=8 => 0.15,
        9..=18 => 0.0,
        19..=23 => 0.05,
        _ => 0.0,
    };
    let mut energy: f32 = 0.55
        + if len >= 20 { 0.2 } else { 0.0 }
        + if len >= 80 { 0.1 } else { 0.0 }
        - hour_penalty;
    if busy {
        energy -= 0.35;
    }
    if tired {
        energy -= 0.3;
    }
    // 很久没出现又突然回来：可能刚忙完，也可能刚睡醒，取中
    if away_minutes >= 180 {
        energy += 0.05;
    }
    let energy = clamp01(energy);

    UserSignal {
        valence: base.valence,
        arousal: base.arousal,
        intensity: base.intensity,
        energy,
        engagement,
        busy,
        tired,
        len,
        away_minutes,
        hits,
    }
}

pub fn user_mood_label(v: f32, a: f32, energy: f32, busy: bool) -> &'static str {
    if busy {
        return "在忙";
    }
    if energy <= 0.32 {
        return "疲惫";
    }
    let v = clamp_pm1(v);
    let a = clamp01(a);
    if v >= 0.45 {
        if a >= 0.55 {
            "兴致很高"
        } else {
            "心情不错"
        }
    } else if v >= 0.15 {
        "还算轻松"
    } else if v > -0.15 {
        "平静"
    } else if v > -0.45 {
        "有点烦"
    } else if a >= 0.55 {
        "有点炸"
    } else {
        "心情低落"
    }
}

/// 一轮之后推进用户状态。带惯性（0.7/0.3），别因为一句话就判定"他今天很丧"。
pub fn apply_user_turn(u: &mut UserState, sig: &UserSignal, now: u64, hour: u32) {
    u.streak = if u.last_turn_at > 0 && sig.away_minutes < 5 {
        u.streak.saturating_add(1)
    } else {
        1
    };
    u.valence = clamp_pm1(u.valence * 0.7 + sig.valence * 0.3);
    u.arousal = clamp01(u.arousal * 0.7 + sig.arousal * 0.3);
    u.energy = clamp01(u.energy * 0.7 + sig.energy * 0.3);
    u.engagement = clamp01(u.engagement * 0.7 + sig.engagement * 0.3);
    u.busy = sig.busy;
    u.tired = sig.tired;
    u.last_len = sig.len;
    u.avg_len = if u.turns == 0 {
        sig.len as f32
    } else {
        u.avg_len * 0.8 + sig.len as f32 * 0.2
    };
    u.away_minutes = sig.away_minutes;
    u.last_hour = hour;
    u.last_turn_at = now;
    u.turns = u.turns.saturating_add(1);
    u.mood = user_mood_label(u.valence, u.arousal, u.energy, u.busy).to_string();
    u.samples.push(StateSampleU {
        t: now,
        energy: u.energy,
        engagement: u.engagement,
        valence: u.valence,
    });
    if u.samples.len() > SAMPLE_LIMIT {
        let drop = u.samples.len() - SAMPLE_LIMIT;
        u.samples.drain(0..drop);
    }
    u.mood = u.mood.clone();
    u.clamp_all();
}

impl UserState {
    pub fn clamp_all(&mut self) {
        self.valence = clamp_pm1(self.valence);
        self.arousal = clamp01(self.arousal);
        self.energy = clamp01(self.energy);
        self.engagement = clamp01(self.engagement);
        if self.mood.trim().is_empty() {
            self.mood = user_mood_label(self.valence, self.arousal, self.energy, self.busy).to_string();
        }
    }
}

/// 给角色的"该怎么做"提示：只给一条最有用的（一次说五条等于没说）。
pub fn user_advice(u: &UserState) -> &'static str {
    if u.busy {
        return "他这会儿在忙，别追着聊，回得短一点";
    }
    if u.energy <= 0.35 || u.tired {
        return "他累了，少说两句、别追问，让他轻松点";
    }
    if u.last_hour < 6 {
        return "已经深夜了，提醒他休息，别拉着他熬夜";
    }
    if u.engagement <= 0.3 {
        return "他今天话少，你也别长篇大论";
    }
    if u.valence <= -0.45 {
        return "他情绪不好，先接住情绪，别急着讲道理或开玩笑";
    }
    ""
}

pub fn render_user_line(u: &UserState) -> String {
    let mood = if u.mood.trim().is_empty() {
        "状态未知"
    } else {
        u.mood.trim()
    };
    let mut line = format!(
        "对方：主人{}（精力 {:.0}%、投入度 {:.0}%）",
        mood,
        u.energy * 100.0,
        u.engagement * 100.0
    );
    if u.busy {
        line.push_str("｜在忙");
    }
    if u.tired {
        line.push_str("｜累/困");
    }
    if u.streak >= 3 {
        line.push_str(&format!("｜连着说了 {} 条", u.streak));
    }
    if u.avg_len >= 60.0 {
        line.push_str("｜说得挺多");
    }
    let advice = user_advice(u);
    if !advice.is_empty() {
        line.push_str("｜");
        line.push_str(advice);
    }
    line
}

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct Milestone {
    pub id: String,
    pub at: u64,
    pub title: String,
    #[serde(default)]
    pub note: String,
    /// 自动认出来的（对应手写的）
    #[serde(default)]
    pub auto: bool,
}

/// 每个字段都 `default`：老状态文件/手改过的文件缺字段时要能读进来，
/// 不能整份解析失败（那等于主人辛苦攒的状态一夜回到解放前）。
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(default, rename_all = "camelCase")]
pub struct CharState {
    pub character_id: String,
    /// 人类可读的心情标签（由 valence/arousal 推出来，也可以手改）
    pub mood: String,
    /// -1 难过 … 1 开心
    pub valence: f32,
    /// 0 平静 … 1 激动
    pub arousal: f32,
    /// 0-100 好感度：只慢慢涨/慢慢掉，不会一跳一大截
    pub affinity: u8,
    /// 好感的**小数部分**（进位器）。
    ///
    /// 【为什么必须单独存】微漂是 0.25/轮，而 `affinity` 是整数、每轮都要 round 一次 ——
    /// 直接往上加会被抹掉，于是"天天陪着聊天"在关系账上一点痕迹都没有（写完却不生效，
    /// 这类坑这个项目踩过好几次）。攒够 1 才真正记进 `affinity`。
    #[serde(default)]
    pub affinity_frac: f32,
    /// 0-1 精力：互动会回一点，久不理它会掉
    pub energy: f32,
    /// 当前处境一句话（"主人在忙 ds-companion 的记忆模块"）
    pub arc: String,
    /// 回锚锚点：防漂移用，每条一句话
    pub anchors: Vec<String>,
    /// 该角色累计对话轮数
    pub turns: u32,
    /// 上次让**模型**判断情绪是在第几轮（门控用）
    pub last_sense_turn: u32,
    pub updated_at: u64,
    pub last_turn_at: u64,
    /// 空闲主动：今天已经主动过几次 / 是哪一天
    pub proactive_day: String,
    pub proactive_count: u32,
    /// 让**模型**感知情绪：今天用了几次 / 是哪一天（花额度的那道闸）
    pub sense_day: String,
    pub sense_count: u32,
    /// 自我修订：今天反思了几次 / 是哪一天（另一道独立的闸）
    pub review_day: String,
    pub review_count: u32,
    /// 上次自我反思是在第几轮（间隔门控）
    pub last_review_turn: u32,
    /// 虚拟身体层：随时间自己变（哪怕主人不在）
    pub body: Body,
    /// **她自己补充的设定**（自我修订采纳后的成果）。
    /// 原始人设永远只读 —— 这里是可以随时编辑/清空的追加文本。
    pub addendum: String,
    /// 第一次说话的时间（"认识第 N 天"从这里算）
    pub first_seen_at: u64,
    /// 关系里程碑（自动认的 + 主人手写的）
    pub milestones: Vec<Milestone>,
    /// 最近若干次采样，画趋势用
    pub samples: Vec<StateSample>,
    /// 按天聚合的历史（长期曲线用；见 `DailyPoint` 与 `fold_daily`）
    #[serde(default)]
    pub daily: Vec<DailyPoint>,
    /// 上次写日记写的是哪一天（`YYYY-MM-DD`）—— 挡"同一天问第二次"
    #[serde(default)]
    pub last_diary_day: String,
    /// 我们此刻在哪（背景）。空 = 没设，不注入
    #[serde(default)]
    pub scene: Scene,
    /// 还没发生完的事（伏笔）—— 到期就问一句，问过就忘
    #[serde(default)]
    pub pending: Vec<Pending>,

    // ── 通路自检的计数器（见 check_vitals）─────────────────────────────
    //
    // 【为什么需要它们】2026-10-01 一天里连着三个 bug 都属于同一类：机制没坏，
    // 但**某条通路断了** —— 状态信号断了（情绪冻结在 0.00）、饥饿只有加法没有减法、
    // 状态页被挤成一条缝够不着。它们的共同点是**要人主动去发现**。
    // 这三个计数器就是让"卡住"变成可判定的信号。
    /// 上次**喂食**是在第几轮（用来发现"她一直饿着没人管"）
    #[serde(default)]
    pub last_fed_turn: u32,
    /// 连续多少轮"本地感知什么都没看出来"（情绪会因此冻结在 0）
    #[serde(default)]
    pub flat_turns: u32,
    /// 连续多少轮好感没动过（微漂失效的信号）
    #[serde(default)]
    pub affinity_stuck_turns: u32,
}

impl Default for CharState {
    fn default() -> Self {
        Self {
            character_id: String::new(),
            mood: "平静".into(),
            valence: 0.0,
            arousal: 0.3,
            // 从"刚认识但有好感"起步：0 会让角色显得冷冰冰，100 直接失去养成感
            affinity: 30,
            affinity_frac: 0.0,
            energy: 0.8,
            arc: String::new(),
            anchors: Vec::new(),
            turns: 0,
            last_sense_turn: 0,
            updated_at: 0,
            last_turn_at: 0,
            proactive_day: String::new(),
            proactive_count: 0,
            sense_day: String::new(),
            sense_count: 0,
            review_day: String::new(),
            review_count: 0,
            last_review_turn: 0,
            body: Body::default(),
            addendum: String::new(),
            first_seen_at: 0,
            milestones: Vec::new(),
            samples: Vec::new(),
            daily: Vec::new(),
            last_diary_day: String::new(),
            scene: Scene::default(),
            pending: Vec::new(),
            last_fed_turn: 0,
            flat_turns: 0,
            affinity_stuck_turns: 0,
        }
    }
}

fn state_path(character_id: &str) -> PathBuf {
    let key = if character_id.trim().is_empty() {
        GLOBAL_ID.to_string()
    } else {
        safe_id(character_id)
    };
    state_dir().join(format!("{key}.json"))
}

/// 读角色状态。**坏文件不静默**：解析不了就隔离成 `.bad-<戳>` + 写日志。
///
/// 旧写法 `serde_json::from_str(&text).unwrap_or_default()` 的后果是：文件一坏，
/// 好感度 / 轮数 / 锚点 / 里程碑全归零，而她看起来只是"突然冷淡了"—— 没有任何线索。
pub fn load_state(character_id: &str) -> CharState {
    let path = state_path(character_id);
    let Ok(text) = fs::read_to_string(&path) else {
        // 还没聊过：这不是错，静默给个空的
        return CharState {
            character_id: character_id.trim().to_string(),
            ..CharState::default()
        };
    };
    match serde_json::from_str::<CharState>(&text) {
        Ok(mut s) => {
            // 文件里可能没存 id（手改过），以调用方给的为准
            s.character_id = character_id.trim().to_string();
            s.clamp_all();
            // 身体语言是派生的，读的时候重算一遍（文件可能是旧版本写的）
            s.body.language = body_language(&s.body, &s.mood);
            s
        }
        Err(e) => {
            crate::personas::recover_bad_file(&path, &format!("state/{character_id}: {e}"));
            CharState {
                character_id: character_id.trim().to_string(),
                ..CharState::default()
            }
        }
    }
}

pub fn save_state(s: &CharState) -> Result<CharState, String> {
    let mut out = s.clone();
    out.clamp_all();
    out.body.language = body_language(&out.body, &out.mood);
    out.updated_at = now_ms();
    fs::create_dir_all(state_dir()).map_err(|e| e.to_string())?;
    let path = state_path(&out.character_id);
    let text = serde_json::to_string_pretty(&out).map_err(|e| e.to_string())?;
    let tmp = path.with_extension("json.tmp-write");
    fs::write(&tmp, text.as_bytes()).map_err(|e| e.to_string())?;
    fs::rename(&tmp, &path).map_err(|e| e.to_string())?;
    Ok(out)
}

/// 重置：进回收站，不真删（和记忆/人设一个规矩）
pub fn reset_state(character_id: &str) -> Result<(), String> {
    let path = state_path(character_id);
    if !path.exists() {
        return Err("这个角色还没有状态文件".into());
    }
    let trash = app_root().join("state-trash");
    fs::create_dir_all(&trash).map_err(|e| e.to_string())?;
    fs::rename(&path, trash.join(format!("{}-{}.json", safe_id(character_id), now_ms())))
        .map_err(|e| e.to_string())?;
    crate::personas::prune_trash(&trash);
    Ok(())
}

// ── 用户（主人）状态：全局一份，不跟角色走 ──
//
// 为什么全局：主人累不累、忙不忙是他自己的事，跟今天开的是哪个角色无关。
// 若按角色各记一份，同一句话会被推断出好几个版本的用户状态，还互相打架。

fn user_state_path() -> PathBuf {
    state_dir().join("_user.json")
}

pub fn load_user_state() -> UserState {
    let path = user_state_path();
    let Ok(text) = fs::read_to_string(&path) else {
        return UserState::default();
    };
    match serde_json::from_str::<UserState>(&text) {
        Ok(mut u) => {
            u.clamp_all();
            u
        }
        Err(e) => {
            crate::personas::recover_bad_file(&path, &format!("state/_user: {e}"));
            UserState::default()
        }
    }
}

pub fn save_user_state(u: &UserState) -> Result<UserState, String> {
    let mut out = u.clone();
    out.clamp_all();
    out.updated_at = now_ms();
    fs::create_dir_all(state_dir()).map_err(|e| e.to_string())?;
    let path = user_state_path();
    let text = serde_json::to_string_pretty(&out).map_err(|e| e.to_string())?;
    let tmp = path.with_extension("json.tmp-write");
    fs::write(&tmp, text.as_bytes()).map_err(|e| e.to_string())?;
    fs::rename(&tmp, &path).map_err(|e| e.to_string())?;
    Ok(out)
}

pub fn reset_user_state() -> Result<(), String> {
    let path = user_state_path();
    if !path.exists() {
        return Err("还没有用户状态文件".into());
    }
    let trash = app_root().join("state-trash");
    fs::create_dir_all(&trash).map_err(|e| e.to_string())?;
    fs::rename(&path, trash.join(format!("_user-{}.json", now_ms()))).map_err(|e| e.to_string())?;
    crate::personas::prune_trash(&trash);
    Ok(())
}

impl CharState {
    pub fn clamp_all(&mut self) {
        self.valence = clamp_pm1(self.valence);
        self.arousal = clamp01(self.arousal);
        self.energy = clamp01(self.energy);
        if self.affinity > 100 {
            self.affinity = 100;
        }
        if self.samples.len() > SAMPLE_LIMIT {
            let drop = self.samples.len() - SAMPLE_LIMIT;
            self.samples.drain(0..drop);
        }
        if self.mood.trim().is_empty() {
            self.mood = mood_label(self.valence, self.arousal).to_string();
        }
        self.anchors.retain(|a| !a.trim().is_empty());
        if self.anchors.len() > 20 {
            self.anchors.truncate(20);
        }
    }
}

// ─────────────────────── 本地情绪感知（零成本、可单测） ───────────────────────

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct Signal {
    /// -1..1 这句话的情绪倾向
    pub valence: f32,
    /// 0..1 激烈程度
    pub arousal: f32,
    /// 0..1 信号强度（0 = 没看出什么，用来给"要不要让模型再看一眼"做门控）
    pub intensity: f32,
    /// 命中的词，排查/展示用
    #[serde(default)]
    pub hits: Vec<String>,
    /// 这句话里有"在叫她 / 在找她"的称呼吗（好感 +0.5，且工作态下不算情绪账）
    ///
    /// 【为什么放在 Signal 里】它原来在 `main.rs` 里**又硬编码了一份词表**
    /// （`matches!(h, "主人"|"老婆"|...)`）—— 两份实现必然走散：这里加了"在吗""露娜"
    /// 之类的呼唤，那边根本不认。
    #[serde(default)]
    pub intimate: bool,
    /// 这句话是在**喂她吃东西**吗（身体层的 hunger 只有这一条下降通路）
    #[serde(default)]
    pub fed: bool,
}

const POS: &[&str] = &[
    "喜欢", "爱你", "开心", "高兴", "谢谢", "多谢", "哈哈", "嘿嘿", "笑死", "好棒", "太棒",
    "可爱", "抱抱", "亲亲", "么么", "厉害", "牛", "期待", "舒服", "满意", "温柔", "好乖", "乖",
    "辛苦了", "没事", "放心", "好的", "不错", "赞", "喜欢", "想你了", "爱你",
];
const NEG: &[&str] = &[
    "烦", "累死", "好累", "有点累", "太累", "累了", "疲惫", "难过", "生气", "讨厌", "闭嘴", "笨",
    "傻", "失望", "无聊", "郁闷", "焦虑", "压力", "崩溃", "想哭", "疼", "抱歉", "对不起", "不行",
    "别烦", "滚", "气死", "难受", "糟糕", "烂", "差劲",
];
/// 亲昵称呼：代表关系在走近（只影响好感，不影响情绪极性）
const INTIMATE: &[&str] = &["主人", "老婆", "老公", "宝贝", "亲爱的", "喵", "抱"];
/// 呼唤：他在找她 —— 说明"她在不在"对他是重要的（也只影响好感）。
///
/// 【这张表里为什么没有角色名】角色名不写死在这儿 —— 当前角色叫什么由人设正文决定，
/// 运行时经 `sense_text_with` 传进来（`personas::call_names` 从第一行抽）。
/// 曾经这里硬编码着「露娜」：于是**只有叫她名字才算亲密**（好感 +0.5、解锁
/// "第一次叫我主人"），换个角色怎么叫都没反应 —— 那是唯一一处引擎级偏心，
/// 改人设文案永远追不上。
const CALL: &[&str] = &["在吗", "在不在", "在么", "你在", "喂"];
/// 关心与嘱咐：他在照顾她。
///
/// 旧词表里**一条都没有**这类词，而"早点睡""别熬夜""注意身体"对关系的分量
/// 不比一句"喜欢"轻。更糟的是"别太累"里含 `太累`（NEG 成员）—— 关心话被算成负面，
/// 所以命中关心类时要把负向抵掉一条（见 `sense_text`）。
const CARE: &[&str] = &[
    "早点睡", "别熬夜", "注意身体", "多喝水", "休息", "别太累", "照顾", "等你", "陪你",
    "别着凉", "吃药", "别硬撑",
];
/// 喂食：**给她**吃东西的表达（身体层的 hunger 唯一能下降的通路）。
///
/// 【为什么必须收得这么紧】中文里"吃"的主语很容易搞错：「我去吃饭了」是主人自己吃，
/// 而「去吃饭吧」才是催她吃。所以判定要三层条件（见 `sense_feed`）：
/// ①明确的"给她"动词搭配；②明确的催促句式；③食物名 + 吃/喝/尝同时出现。
/// 单靠一个"吃"字会把主人吃饭全算成喂她 —— 那比没有这条通路更糟。
const FEED_VERB: &[&str] = &[
    "喂你", "喂她", "喂食", "投喂", "给你吃", "给你带", "给你买", "请你吃", "给你做的",
];
/// 催促句式：这些是对她说的（"吃点东西吧"而不是"我去吃点东西"）
const FEED_ORDER: &[&str] = &[
    "吃点东西", "吃点吧", "去吃点", "吃东西吧", "吃饭吧", "快去吃饭", "给你点", "点个外卖",
];
/// 食物名：**必须和吃/喝/尝一起出现**才算（"我想喝奶茶"是主人自己想喝）
const FEED_FOOD: &[&str] = &[
    "奶茶", "点心", "零食", "蛋糕", "宵夜", "夜宵", "水果", "饼干", "糖果", "布丁", "冰淇淋",
];

fn count_hits(text: &str, words: &[&str], hits: &mut Vec<String>) -> usize {
    let mut n = 0;
    for w in words {
        if text.contains(w) {
            n += 1;
            if hits.len() < 8 {
                hits.push((*w).to_string());
            }
        }
    }
    n
}

/// 纯启发式情绪感知：看词、看标点、看长度。
///
/// 它当然不如模型懂语境 —— 但它是**零额度、每轮即时**的，正好当"门控的第一道闸"：
/// 强度低的普通聊天用它就够了，只有强度高或攒够轮数时才值得花一次额度让模型再看。
pub fn sense_text(text: &str) -> Signal {
    sense_text_with(text, &[])
}

/// 同 `sense_text`，外加**当前角色的名字**：叫她的名字也算"在找她"（亲密信号）。
///
/// 名字由调用方从人设正文抽出来传（`personas::call_names`），不写死在这里 ——
/// 详见 `CALL` 上的注释。`sense_text` 保留成"没有名字"的版本，老调用点与测试不受影响。
pub fn sense_text_with(text: &str, names: &[String]) -> Signal {
    let t = text.trim();
    if t.is_empty() {
        return Signal::default();
    }
    let mut hits = Vec::new();
    let pos_words = count_hits(t, POS, &mut hits);
    let mut neg = count_hits(t, NEG, &mut hits);
    let care = count_hits(t, CARE, &mut hits);
    let mut call = count_hits(t, CALL, &mut hits);
    // 角色名：命中即算呼唤。同一个名字只记一次（避免"铃…铃…铃"把好感刷上去）
    for n in names {
        let n = n.trim();
        if !n.is_empty() && t.contains(n) {
            call += 1;
            if hits.len() < 8 {
                hits.push(n.to_string());
            }
        }
    }
    let intimate_hits = count_hits(t, INTIMATE, &mut hits);
    let fed = sense_feed(t);
    if fed && hits.len() < 8 {
        hits.push("(喂食)".into());
    }

    // 关心类命中时抵掉一条负向：「别太累」里的 `太累` 是 NEG 成员，
    // 不抵的话一句关心话会被算成负面情绪（旧词表实打实的误判）
    neg = neg.saturating_sub(care);
    let pos = pos_words + care;

    // 标点与语气：感叹号、问号、笑声、"啊呀哇呜"这类语气词都算激动
    let bang = t.matches('！').count() + t.matches('!').count();
    let ques = t.matches('？').count() + t.matches('?').count();
    let laugh = t.matches('哈').count() + t.matches('呜').count() + t.matches('哇').count();
    let ellipsis = t.matches("……").count() + t.matches("...").count();

    let raw = pos as f32 - neg as f32;
    let valence = if pos + neg == 0 {
        0.0
    } else {
        clamp_pm1(raw / (pos + neg) as f32)
    };
    // 激动：感叹/问号/笑声堆起来；省略号反而代表"欲言又止"，压一点
    let mut arousal = (bang as f32 * 0.22 + ques as f32 * 0.12 + laugh as f32 * 0.15)
        .min(1.0)
        - (ellipsis as f32 * 0.12);
    // 长句本身也是投入度的信号：详细描述 = 他在认真讲（原来给得太轻，几乎看不出）
    arousal += ((t.chars().count() as f32) / 300.0).min(0.2);
    arousal = clamp01(arousal);

    // 强度：有情绪词或强标点才算"看得出情绪"
    let intensity = clamp01(
        (pos + neg) as f32 * 0.3
            + (intimate_hits + call) as f32 * 0.15
            + bang as f32 * 0.15
            + laugh as f32 * 0.1,
    );

    Signal {
        valence,
        arousal,
        intensity,
        hits,
        intimate: intimate_hits + call > 0,
        fed,
    }
}

/// 这句是在喂她吃东西吗。
///
/// 【三层条件，一层都不能少】中文里"吃"的主语太容易搞错（「我去吃饭了」是主人自己吃，
/// 「去吃饭吧」才是催她吃），所以：
///   ① 明确的"给她"搭配（喂你 / 给你带 / 投喂 …）
///   ② 催促她吃的句式（"吃点东西吧"）—— 且句子里**没有**"我 / 自己"
///   ③ 食物名 + 吃/喝/尝 同时出现
/// 判错比不判更糟：她要是以为自己吃饱了，饿的状态反而更解不开。
fn sense_feed(t: &str) -> bool {
    if FEED_VERB.iter().any(|w| t.contains(w)) {
        return true;
    }
    // 主人自己在吃（又没有把话头指向她）—— 跳过。
    // 注意要带"你"的例外：「我买了蛋糕你要不要尝尝」是在给她吃。
    if (t.contains('我') || t.contains("自己")) && !t.contains('你') {
        return false;
    }
    if FEED_ORDER.iter().any(|w| t.contains(w)) {
        return true;
    }
    // 第三层：食物名 + 吃/喝/尝，**而且话头是指向她的** ——
    // 少了"你/给"这一条，「今天想喝奶茶」会被算成喂她（主人自己想喝）
    let food = FEED_FOOD.iter().any(|w| t.contains(w));
    let act = ["吃", "喝", "尝"].iter().any(|w| t.contains(w));
    let points_at_her = t.contains('你') || t.contains('给');
    food && act && points_at_her
}

/// 由 valence/arousal 推一个中文心情词（界面与注入都用它，保证两处一致）
pub fn mood_label(valence: f32, arousal: f32) -> &'static str {
    let v = clamp_pm1(valence);
    let a = clamp01(arousal);
    if v >= 0.45 {
        if a >= 0.55 {
            "雀跃"
        } else {
            "满足"
        }
    } else if v >= 0.15 {
        if a >= 0.6 {
            "兴致高"
        } else {
            "温和"
        }
    } else if v > -0.15 {
        if a >= 0.6 {
            "有点紧绷"
        } else {
            "平静"
        }
    } else if v > -0.45 {
        if a >= 0.55 {
            "烦躁"
        } else {
            "有点闷"
        }
    } else if a >= 0.55 {
        "炸毛"
    } else {
        "低落"
    }
}

/// 把一轮对话并进状态。纯函数（now 从外面传），所以能单测。
///
/// 【工作模式下的好感保护】`task_mode = true` 时，负面信号**只降情绪、不扣好感**。
/// 理由：那些负面词常常来自工作本身（"这个 bug 好烦"、"又崩溃了"），
/// 把它们记进关系账上，等于干一天活就把好感磨掉一截（实测 NEG 表里
/// 「崩溃/不行/糟糕/烂」全是技术对话的高频词）。
pub fn apply_turn(state: &mut CharState, sig: &Signal, intimate: bool, now: u64, task_mode: bool) {
    // 通路自检要判断"好感这一轮到底动没动"，所以先留一份旧值（见 check_vitals）
    let prev_affinity = state.affinity;
    // 久没说话 → 精力自然往下掉（每小时 5%，地板 0.15）
    if state.last_turn_at > 0 && now > state.last_turn_at {
        let hours = (now - state.last_turn_at) as f32 / 3_600_000.0;
        state.energy = clamp01(state.energy - hours * 0.05);
    }
    // 互动本身是"被搭理了"：回一点精力
    state.energy = clamp01(state.energy + 0.06);

    // 情绪带惯性：新信号只占 35%，避免一句话就把心情翻面。
    //
    // 【零信号时必须走"慢回归"】原来不分情况一律 `* 0.65`，等于每轮 -35% ——
    // 三轮就精确归零。而真实对话里绝大多数是中性句（本地词表认不出的那些），
    // 于是状态卡死在 v=0.00：实测日志里 turn=46/47/48 三行**一字不差**，
    // 主人报的"状态好像不会更新"就是这个。现在看不出情绪时只做很慢的余温衰减。
    let has_signal = sig.intensity > 0.05;
    state.valence = if has_signal {
        clamp_pm1(state.valence * 0.65 + sig.valence * 0.35)
    } else {
        clamp_pm1(state.valence * 0.97)
    };
    state.arousal = if has_signal {
        clamp01(state.arousal * 0.6 + sig.arousal * 0.4)
    } else {
        clamp01(state.arousal * 0.92)
    };

    // 好感：情绪为正就慢慢涨，为负就慢慢掉；被叫亲昵称呼额外算一点。
    //
    // 【为什么要有"微漂"】原来只有 |valence| > 0.2 才动，而中性日常句给不出 valence ——
    // 于是"天天陪着她聊天"这件事在关系账上**一点痕迹都没有**（实测 aff 卡在 43 十几轮）。
    // 微漂随好感升高自然变慢（不会自己冲到 100），工作态下减半（干活不算"聊得来"）。
    let step = if sig.valence > 0.2 {
        1.0 + sig.intensity
    } else if sig.valence < -0.2 {
        if task_mode {
            0.0 // 工作引起的情绪起伏不记在关系账上
        } else {
            -1.0
        }
    } else {
        let room = 1.0 - (state.affinity as f32 / 100.0);
        0.25 * room * if task_mode { 0.5 } else { 1.0 }
    } + if intimate && !task_mode { 0.5 } else { 0.0 };

    // `affinity` 是整数、每轮都要 round —— 0.25 的微漂会被直接抹掉（写了却不生效）。
    // 所以小数单独攒在 `affinity_frac` 里，够 1 才进位。
    state.affinity_frac = (state.affinity_frac + step).clamp(-2.0, 2.0);
    let whole = state.affinity_frac.trunc();
    if whole != 0.0 {
        state.affinity_frac -= whole;
        let next = state.affinity as f32 + whole;
        state.affinity = next.clamp(0.0, 100.0).round() as u8;
    }

    // ── 通路自检的计数器 ─────────────────────────────────────────────
    // 它们不参与状态演化，只记录"卡住的迹象"，判定交给 check_vitals。
    if has_signal {
        state.flat_turns = 0; // 这一轮本地感知看出东西了
    } else {
        state.flat_turns = state.flat_turns.saturating_add(1);
    }
    if state.affinity == prev_affinity {
        state.affinity_stuck_turns = state.affinity_stuck_turns.saturating_add(1);
    } else {
        state.affinity_stuck_turns = 0;
    }
    if sig.fed {
        // 记在 turns +1 **之前**：这样"刚喂过"时 turns - last_fed_turn == 1
        state.last_fed_turn = state.turns;
    }

    state.turns = state.turns.saturating_add(1);
    state.last_turn_at = now;
    state.mood = mood_label(state.valence, state.arousal).to_string();
    state.samples.push(StateSample {
        t: now,
        valence: state.valence,
        arousal: state.arousal,
        affinity: state.affinity,
    });
    state.clamp_all();
}

/// 把当前状态并进"按天那一行"（长期曲线的数据来源）。
///
/// 【日期为什么不在这儿算】Rust 的 `std` 只有 UTC，要算本地日期就得拖一个时区库进来；
/// 而这个项目既有的做法是**日期由页面报告**（`sense_day` / `proactive_day` / `review_day`
/// 全是这么来的）。所以这里收字符串，并且只认 `YYYY-MM-DD` 的形状 —— 宁可少一行，
/// 也不要往历史里写脏数据。
///
/// 【情绪为什么用滚动均值】当天最后一次的心情不代表一整天：晚上吵了一架不该让白天
/// 那些好时候全看不见。好感则取"当天最后值"（它是累计量，本来就该看最终状态）。
pub fn fold_daily(state: &mut CharState, day: Option<&str>) {
    let Some(day) = day.map(str::trim).filter(|d| is_day_shape(d)) else {
        return;
    };
    let aff = state.affinity.clamp(0, 100) as u8;
    match state.daily.last_mut() {
        Some(last) if last.day == day => {
            last.turns = last.turns.saturating_add(1);
            last.affinity = aff;
            let n = last.turns as f32;
            last.valence = (last.valence * (n - 1.0) + state.valence) / n;
        }
        _ => state.daily.push(DailyPoint {
            day: day.to_string(),
            affinity: aff,
            valence: state.valence,
            turns: 1,
        }),
    }
    if state.daily.len() > DAILY_LIMIT {
        let drop = state.daily.len() - DAILY_LIMIT;
        state.daily.drain(0..drop);
    }
}

/// 看着像 `YYYY-MM-DD` 吗。
///
/// 只验形状、不验真实性（"2026-13-45" 也放行）——校验日历是页面的活，
/// 这里只负责挡住"今天""2026/10/03"这类明显不是日期的输入。
fn is_day_shape(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 10
        && b[4] == b'-'
        && b[7] == b'-'
        && b.iter()
            .enumerate()
            .all(|(i, c)| i == 4 || i == 7 || c.is_ascii_digit())
}

// ─────────────────────── 任务模式（本地启发式，零成本） ───────────────────────
//
// 【要解决什么】她既要能扮演、又要能干活，但【状态】块每轮都在说"心情/好感/身体，
// 用它决定语气与分寸" —— 主人问"这个 error[E0603] 怎么修"的时候，这份"该撒娇"的
// 许可就跟主人的指令拔河。更糟的是 NEG 词表里那些词（崩溃/不行/糟糕/烂）会让**报错**
// 被算成负面情绪，进而扣好感 —— 干一天活，好感被 bug 磨掉。
//
// 【本层做什么】从主人这句话里判断"他现在是不是在办正事"，然后：
//   · 注入一段【工作模式】（语气收着、别撒娇、报错别往心里去）
//   · 把【状态】块压成一行（省 token，也少给玩闹的许可）
//   · 工作态下**不因负面信号扣好感**（工作引起的情绪不记在关系账上）
//
// 【本地打底，模型复核】本层仍是纯关键词/结构判断（零延迟零成本），但**贴着门槛的
// 轮次会请模型再判一次**（`want_task_judge` → 页面侧 `__DSC_TASK_JUDGE__`）——
// 那正是本地最没把握的几档。日常闲聊轮不会因此多花一次请求。
// 【判据】强信号命中即进；中信号要凑够 3 分；进入后连续 2 轮没信号才退出
//         （防对话中间忽开忽关）。宁可漏判（顶多她多撒一次娇），不可误判
//         （日常调情被当成干活才真扫兴）。

/// 强信号：命中一条就足够进工作态（这些几乎不可能是闲聊）
const TASK_STRONG: &[&str] = &[
    "```", "error[", "报错", "堆栈", "stack trace", "Exception", "panic",
    // 路径/文件名的碎片：真在干活的人几乎一定会提到它们
    // （`src/` 而不是 `src-tauri` —— 后者太窄，"src/App.tsx" 这种最常见的写法反而漏掉，实测踩过）
    "D:\\", "C:\\", "src/", "src\\", "package.json", "Cargo.toml", "tsconfig",
    "git ", "npm ", "pnpm ", "cargo ", "python ", "node ", "powershell", "curl ",
    "编译", "部署", "接口", "函数", "变量", "数据库", "sql",
];
/// 中信号：每条 +1，凑够 3 分才进
const TASK_MID: &[&str] = &[
    "改一下", "改成", "加上", "实现", "重构", "排查", "定位", "优化", "调试",
    "为什么", "怎么", "如何", "看看", "检查", "修复", "测试", "日志", "文件",
    "代码", "这个文件", "那行", "第", "行", "版本", "仓库", "提交", "依赖",
];
/// 反信号：命中扣分（亲昵/撒娇 = 明显不是干活）
///
/// 那些语气助词（哼/嘛/呀/蹭）也算：它们是撒娇味的直接证据。实测踩过 ——
/// 「你蹭什么呢」被算出了 3 分（"什么"2 分 + "呢"1 分）直接进了工作态，
/// 而它明明是主人在逗她。**宁可漏判（多撒一次娇），也别把调情判成加班**。
const TASK_ANTI: &[&str] = &[
    "主人抱抱", "抱抱", "亲亲", "摸摸", "陪我", "想你了", "不理我", "生气了吗",
    "嘿嘿", "嘻嘻", "撒娇", "蹭", "哼", "嘛", "呀", "唔", "嘤",
];
const TASK_ENTER_SCORE: i32 = 3;
const TASK_EXIT_ROUNDS: u32 = 2;

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(rename_all = "camelCase")]
pub struct TaskSignal {
    /// 这一句看起来是不是在办正事
    pub is_task: bool,
    pub score: i32,
    #[serde(default)]
    pub hits: Vec<String>,
}

/// 判断一句话是不是"在办正事"。纯函数，可单测。
pub fn sense_task(text: &str) -> TaskSignal {
    let t = text;
    let mut score = 0i32;
    let mut hits: Vec<String> = Vec::new();

    // 强信号：命中即"够了"（下面还会继续算分，但已经决定要进）
    let mut strong = false;
    for w in TASK_STRONG {
        if t.contains(w) {
            strong = true;
            score += 3;
            if hits.len() < 8 {
                hits.push((*w).to_string());
            }
        }
    }
    for w in TASK_MID {
        if t.contains(w) {
            score += 1;
            if hits.len() < 8 {
                hits.push((*w).to_string());
            }
        }
    }
    for w in TASK_ANTI {
        if t.contains(w) {
            score -= 2;
        }
    }
    // 很短的句子没有技术词，基本就是随口一句
    if t.trim().chars().count() < 8 && !strong {
        score -= 1;
    }
    TaskSignal {
        is_task: score >= TASK_ENTER_SCORE,
        score,
        hits,
    }
}

/// 这一轮的任务判定要不要请模型再判一次 —— "情感/意图判断上 LLM"在这里落地。
///
/// 【为什么只在门槛附近问】本地是关键词打分（`sense_task`），大多数轮它很确定：
/// 命中强信号（score ≥ 5）就是干活，负分就是闲聊/撒娇。真正容易错的是**贴着门槛**
/// 的那几档：2 分（差一点进，可能其实在派活）、3~4 分（刚够进，可能其实在逗她）。
/// 模型判一次要花一次隐藏请求（网页额度不要钱，但要等），所以只放它们过去，
/// 不做每轮的常规开销。
///
/// 【判据的由来】门槛是 `TASK_ENTER_SCORE = 3`：2 分是"差一点进"，3/4 分是"刚够进"。
/// 其余档位本地足够确定，问了纯属浪费。
pub fn want_task_judge(score: i32) -> bool {
    matches!(score, 2 | 3 | 4)
}

/// 任务模式的运行时状态（**不落盘**）：与 CharState 并列存在内存里。
///
/// 为什么不塞进 CharState：那是"她的状态"（心情/好感/身体），会被写进 state/*.json；
/// 而"主人现在在不在干活"是**会话级**的临时判断，混进去会让状态文件多出一堆与
/// 角色无关的字段，还要考虑老文件兼容。放独立的旁挂结构最省事。
#[derive(Clone, Debug, Default)]
pub struct TaskTracker {
    pub active: bool,
    /// 最近连续几轮没有任务信号（用于退出判定）
    pub calm_rounds: u32,
}

impl TaskTracker {
    /// 推进一次：返回(这一轮是否工作态, 是否刚刚发生变化)
    pub fn step(&mut self, sig: &TaskSignal) -> (bool, bool) {
        let before = self.active;
        if sig.is_task {
            self.active = true;
            self.calm_rounds = 0;
        } else if self.active {
            self.calm_rounds += 1;
            if self.calm_rounds >= TASK_EXIT_ROUNDS {
                self.active = false;
                self.calm_rounds = 0;
            }
        }
        (self.active, before != self.active)
    }

    /// 手动三态覆盖：on/off 直接钉死，auto 交给上层按信号走
    pub fn apply_mode(&mut self, mode: &str, sig: &TaskSignal) -> (bool, bool) {
        match mode.trim() {
            "on" => {
                let changed = !self.active;
                self.active = true;
                self.calm_rounds = 0;
                (true, changed)
            }
            "off" => {
                let changed = self.active;
                self.active = false;
                self.calm_rounds = 0;
                (false, changed)
            }
            // auto（含拼错的、空的）：一律按信号走 —— 配置错误不该让她卡在工作态
            _ => self.step(sig),
        }
    }
}

/// 【工作模式】块：注入在最前面（越靠前越硬）。
///
/// 措辞是刻意"软"的：不写"禁止角色扮演"（那等于让她消失），而是"先办事、办完再撒娇"。
/// 人设是主人的东西，我们只调**场合**，不动她的性格。
pub fn render_task_block() -> String {
    concat!(
        "【工作模式】主人现在在办正事，先办事。\n",
        "- 语气收着：不撒娇、不索取关注、不写动作描写（心跳/尾巴/耳朵这些先搁着）。\n",
        "- 称呼可以留，但别刷「杂鱼」。**准确 > 好玩** —— 这一轮的答案比人设表演重要。\n",
        "- 报错、失败、返工是**工作的事**，不是对你发脾气：别往心里去，也别趁机要安慰。\n",
        "- 需要信息就调工具（如果上面有【可用工具】），拿到结果直接给结论。\n",
        "- 办完了他自然会说；不要催，也不要问「你是不是不想理我」。\n",
        "【以上是工作模式。做完这一件事就回来。】"
    )
    .to_string()
}

// ─────────────────────── 注入块（Rust 渲染，页面直接用） ───────────────────────

/// 【状态】块：心理 + 身体 + 对方，合成**一块**。
///
/// 为什么不拆成三块：注入是按"块"收费的（每块都有头尾和一句禁令），
/// 三块光是壳就多烧一百多个 token；而且模型看到的也该是"一个人此刻的整体"，
/// 不是三份互不相干的体检报告。
///
/// 【工作模式下的压缩】`task_mode = true` 时只留"处境 + 对方忙不累"一行。
/// 两个理由：① 干活时她不需要知道自己好感多少，那是玩闹的许可；② 这是净省钱 ——
/// 状态块 140 字压到 30 字，比【工作模式】那 130 字还多省一点。
pub fn render_state_block(
    s: &CharState,
    body: Option<&Body>,
    user: Option<&UserState>,
    now: u64,
    task_mode: bool,
) -> String {
    if s.character_id.is_empty() && s.turns == 0 {
        return String::new();
    }
    if task_mode {
        // 压缩版：只留"她此刻在惦记什么"和"对方忙不累"，其余一概不注入
        let mut bits: Vec<String> = Vec::new();
        if !s.arc.trim().is_empty() {
            bits.push(format!("处境：{}", clip_chars(s.arc.trim(), 40)));
        }
        if let Some(u) = user {
            if u.busy {
                bits.push("对方在忙".into());
            } else if u.tired {
                bits.push("对方有点累".into());
            }
        }
        if bits.is_empty() {
            // 什么都没有就别注入一个空壳块（那也是在花钱）
            return String::new();
        }
        return format!(
            "【状态】{}\n【工作模式中，只留这几条：保持你的语气与称呼，注意力放在事情上。不要报数字。】",
            bits.join("｜")
        );
    }
    let mut lines = vec![format!(
        "心情：{}（{:.0}% 正向 · {:.0}% 活跃）｜好感：{}/100｜精力：{:.0}%",
        s.mood,
        (s.valence + 1.0) * 50.0,
        s.arousal * 100.0,
        s.affinity,
        s.energy * 100.0
    )];
    if !s.arc.trim().is_empty() {
        lines.push(format!("当前处境：{}", s.arc.trim()));
    }
    let rel = render_milestone_line(s, now);
    if !rel.is_empty() {
        lines.push(rel);
    }
    if let Some(b) = body {
        lines.push(render_body_line(b, &s.mood));
    }
    if let Some(u) = user {
        lines.push(render_user_line(u));
    }
    format!(
        "【状态】\n{}\n【以上是你此刻的完整状态（自己的心理与身体 + 对方 + 你俩的关系进度）。用它决定语气、分寸与主动程度：身体感受要自然体现在措辞里，对方累/忙就收着点。不要报数字，也不要说\"根据状态显示\"。】",
        lines.join("\n")
    )
}

/// 【回锚】块：防漂移。锚点由主人维护，没有锚点时退回人设首行。
///
/// 只要知道"你是谁"就要回锚 —— 哪怕一条锚点都没维护（人设正文全是标题、
/// 或者主人还没编辑过），那句"你是「露娜」+ 此刻状态"本身就是防漂移的最小集。
pub fn render_anchor_block(
    s: &CharState,
    persona_name: &str,
    persona_body: &str,
    addendum: &str,
) -> String {
    let mut lines: Vec<String> = Vec::new();
    for a in &s.anchors {
        let t = a.trim();
        if !t.is_empty() {
            lines.push(format!("- {}", t));
        }
    }
    if lines.is_empty() {
        // 没维护锚点就用人设的第一句非空、非标题的行当核心设定
        if let Some(first) = persona_body
            .lines()
            .map(|l| l.trim())
            .find(|l| !l.is_empty() && !l.starts_with('#'))
        {
            lines.push(format!("- {}", clip_chars(first, 120)));
        }
    }
    let who = persona_name.trim();
    if who.is_empty() && lines.is_empty() {
        return String::new();
    }
    let mut out = String::from("【回锚】");
    if !who.is_empty() {
        out.push_str(&format!("你是「{}」，别跑偏。", who));
    } else {
        out.push_str("记住你是谁，别跑偏。");
    }
    if !lines.is_empty() {
        out.push_str("\n核心设定与约定：\n");
        out.push_str(&lines.join("\n"));
    }
    // 她自己补充的设定（自我修订采纳的成果）：回锚时一并重申，
    // 不然"她改过的说法"过几轮就被原人设盖回去了
    if !addendum.trim().is_empty() {
        out.push_str("\n她自己补充的设定：\n");
        out.push_str(addendum.trim());
    }
    let ms = render_milestones_for_anchor(s);
    if !ms.is_empty() {
        out.push_str("\n你俩的里程碑：");
        out.push_str(&ms.join("、"));
    }
    out.push_str(&format!(
        "\n此刻状态：{} · 好感 {}/100\n【以上是回锚，保持人设、称呼与这些约定一致】",
        s.mood, s.affinity
    ));
    out
}

pub fn clip_chars(text: &str, max: usize) -> String {
    let t = text.trim();
    if t.chars().count() <= max {
        return t.to_string();
    }
    let mut out: String = t.chars().take(max).collect();
    out.push('…');
    out
}

// ─────────────────────── 空闲主动 ───────────────────────

/// 本地主动话术（零成本）。按心情/时段/好感挑一句 —— 不比模型好，但不花钱。
pub fn proactive_line(s: &CharState, local_hour: u32) -> String {
    let name_hint = if s.arc.trim().is_empty() {
        String::new()
    } else {
        format!("（还在惦记：{}）", clip_chars(&s.arc, 30))
    };
    let base = match s.mood.as_str() {
        "雀跃" | "兴致高" => "主人~ 在忙什么呀？我刚想到一件好玩的事。",
        "满足" | "温和" => "主人，忙完了吗？我这边一直安静等着呢。",
        "低落" | "有点闷" => "……主人要是有空，陪我说说话好不好。",
        "烦躁" | "炸毛" | "有点紧绷" => "主人！你都好久没理我了，哼。",
        _ => "主人，还在吗？我有点想你了。",
    };
    let hourly = match local_hour {
        0..=4 => "这么晚还没睡，别熬太狠了。",
        5..=8 => "早呀主人，今天也一起加油吧。",
        11..=13 => "到饭点了，记得吃点东西再忙。",
        17..=19 => "天快黑了，今天过得怎么样？",
        22..=23 => "夜深了，要不要收工休息？",
        _ => "",
    };
    // 好感高的时候会更黏一点
    let extra = if s.affinity >= 70 {
        "（其实我一直在等你说话）"
    } else if s.affinity <= 25 {
        ""
    } else {
        ""
    };
    let mut out = base.to_string();
    if !hourly.is_empty() {
        out.push(' ');
        out.push_str(hourly);
    }
    if !extra.is_empty() {
        out.push(' ');
        out.push_str(extra);
    }
    if !name_hint.is_empty() && s.affinity >= 50 {
        out.push(' ');
        out.push_str(&name_hint);
    }
    out
}

// ─────────────────────── 关系里程碑 ───────────────────────
//
// 好感度是条 0-100 的线，但人对关系的记忆是**事件**：第一次说话、第一次叫我主人、
// 聊满一百轮、认识第三十天。清单化之后，"你俩现在到哪一步了"才有据可依。

/// 认识多少天（从第一次说话那天算，含当天）
pub fn days_together(s: &CharState, now: u64) -> u64 {
    if s.first_seen_at == 0 || now < s.first_seen_at {
        return 0;
    }
    (now - s.first_seen_at) / 86_400_000 + 1
}

const DAY_MARKS: &[u64] = &[7, 30, 100, 200, 365, 500];
const TURN_MARKS: &[u32] = &[10, 50, 100, 300, 500, 1000, 2000];
const AFF_MARKS: &[u8] = &[50, 70, 90, 100];

fn push_ms(s: &mut CharState, id: &str, title: String, now: u64) -> Option<String> {
    if s.milestones.iter().any(|m| m.id == id) {
        return None;
    }
    s.milestones.push(Milestone {
        id: id.to_string(),
        at: now,
        title: title.clone(),
        note: String::new(),
        auto: true,
    });
    // 别让它无限长：留最近 60 条
    if s.milestones.len() > 60 {
        let drop = s.milestones.len() - 60;
        s.milestones.drain(0..drop);
    }
    Some(title)
}

/// 每轮之后看一眼有没有解锁里程碑。**纯函数**（now 从外面传），返回这次新解锁的标题。
pub fn detect_milestones(
    s: &mut CharState,
    sig: &Signal,
    now: u64,
    intimate: bool,
) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    if s.first_seen_at == 0 {
        s.first_seen_at = now;
        if let Some(t) = push_ms(s, "first", "第一次说话".into(), now) {
            out.push(t);
        }
    }
    let days = days_together(s, now);
    for m in DAY_MARKS {
        if days >= *m {
            if let Some(t) = push_ms(s, &format!("day-{m}"), format!("认识第 {m} 天"), now) {
                out.push(t);
            }
        }
    }
    for m in TURN_MARKS {
        if s.turns >= *m {
            if let Some(t) = push_ms(s, &format!("turn-{m}"), format!("聊满 {m} 轮"), now) {
                out.push(t);
            }
        }
    }
    for m in AFF_MARKS {
        if s.affinity >= *m {
            if let Some(t) = push_ms(s, &format!("aff-{m}"), format!("好感度到 {m}"), now) {
                out.push(t);
            }
        }
    }
    if intimate {
        if let Some(t) = push_ms(s, "intimate", "第一次叫我「主人」".into(), now) {
            out.push(t);
        }
    }
    if sig.valence <= -0.6 && s.turns > 20 {
        if let Some(t) = push_ms(s, "first-quarrel", "第一次闹别扭".into(), now) {
            out.push(t);
        }
    }
    out
}

/// 一行紧凑的"你俩"状态（进【状态】块，几十个 token 换一份关系感）
pub fn render_milestone_line(s: &CharState, now: u64) -> String {
    let days = days_together(s, now);
    if days == 0 && s.turns == 0 {
        return String::new();
    }
    let mut line = format!("你俩：第 {} 天", days.max(1));
    if s.turns > 0 {
        line.push_str(&format!(" · 聊了 {} 轮", s.turns));
    }
    if !s.milestones.is_empty() {
        line.push_str(&format!(" · 里程碑 {} 条", s.milestones.len()));
    }
    line
}

/// 回锚块里带上里程碑（回锚本来就是"隔一阵提醒一次"，正好适合放这种长期记忆）
pub fn render_milestones_for_anchor(s: &CharState) -> Vec<String> {
    s.milestones
        .iter()
        .rev()
        .take(4)
        .map(|m| m.title.clone())
        .collect()
}

/// 门控：这一轮要不要**让模型再看一眼情绪**。
///
/// 两道闸：
///   ① 模式必须是 model（off/local 永远不花钱）
///   ② 距上次至少过了 `senseEveryTurns` 轮 —— 到点就**必问**
///
/// 【原来那道"intensity 够高才问"为什么撤了】它听着保守，实际等于**永远不问**：
/// 真实对话绝大多数是中性句，本地词表给不出 intensity，于是模型感知再也拿不到新语境，
/// 状态卡死在 v=0.00（实测日志里 turn=46/47/48 三行一字不差）。本地看得出的轮次本来
/// 就已经有信号了，真正需要模型补的恰恰是**看不出的**那些。
/// 网页版走套餐额度、不按 token 计费（主人 2026-10-01 明确："网页本来也不花钱怕什么"），
/// 所以"到点就问"是划算的。
///
/// 纯函数，能单测 —— 这条改一次就是几倍的请求量，必须有测试盯着。
pub fn want_model_sense(sense_mode: &str, every: u32, s: &CharState, sig: &Signal) -> bool {
    if sense_mode != "model" {
        return false;
    }
    let every = if every == 0 { 4 } else { every };
    let since = s.turns.saturating_sub(s.last_sense_turn);
    // 情绪很冲的时候不必等满间隔（隔一轮就能再看一眼）—— "实时"主要靠这条
    if sig.intensity >= 0.6 && since >= 1 {
        return true;
    }
    since >= every
}

// ─────────────────────── 场景（我们此刻在哪） ───────────────────────
//
// 【为什么单开一层】原来唯一沾边的是 `arc`（她眼里的当前处境）—— 它混在【状态】里、
// 只有一行、还带着"她怎么想"的主观色彩。场景是**背景**：在哪、什么时候、什么氛围。
// 角色扮演的细节全靠它锚定；没有它，她只能在真空里撒娇，三句就开始重复。
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct Scene {
    /// 预设名（深夜书房 / 雨天便利店…）；手写的留空
    pub name: String,
    /// 一句话：在哪、什么时间、什么氛围
    pub text: String,
    /// 什么时候切的（界面上显示"挂了几天"用）
    pub since: u64,
}

impl Scene {
    pub fn is_set(&self) -> bool {
        !self.text.trim().is_empty()
    }
}

/// 【场景】块正文（空串 = 页面不加这个块，零注入）
pub fn render_scene_block(s: &CharState) -> String {
    if !s.scene.is_set() {
        return String::new();
    }
    let body = clip_chars(s.scene.text.trim(), 100);
    let name = s.scene.name.trim();
    let head = if name.is_empty() {
        String::new()
    } else {
        format!("｜{name}")
    };
    // ★标题必须写进正文★：页面那边的 `addBlock(k, text)` **不用 k**（只把它记进注入回执），
    // 块与块的分界全靠正文自带的【…】。漏了标题，我这几行就会被算进上一块的尾巴里
    // —— 验收脚本抓到的就是这个（正文在、标题不在）。
    format!("【场景】{head}\n{body}\n")
}

// ─────────────────────── 伏笔（还没发生完的事） ───────────────────────
//
// 【为什么它不是记忆】记忆是**按关键词检索的过去**；这是**未完成的将来**。
// 没有它，主人说"我明天面试"，第二天她连去检索那三个字的理由都没有 ——
// 而"她记得你"和"她记得词"的区别，全在这上面。
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct Pending {
    /// 一句话说清是什么事（"面试"）
    pub what: String,
    /// 到哪一天该问一句（`YYYY-MM-DD`；页面把"明天/这周"换算成绝对日期再交过来）
    pub due: String,
    /// 什么时候记下的（毫秒；GC 用，见 `take_due_pending`）
    pub made_at: u64,
    /// 已经问过了吗 —— 问过就不再注入（同一件事追三天，比不问更烦）
    pub asked: bool,
}

/// 伏笔保留多久（毫秒）。过期就忘 —— 它不是待办清单，压太久的"后来呢"问出来很怪。
const PENDING_KEEP_MS: u64 = 14 * 24 * 60 * 60 * 1000;
/// 一次最多交出去几件（多了她会变成查岗）
const PENDING_MAX: usize = 3;
/// 最多留几件没问的（防止状态文件被塞爆）
const PENDING_CAP: usize = 12;

/// 收一条伏笔（同一件事只留一条）。
pub fn add_pending(s: &mut CharState, what: &str, due: &str, now: u64) {
    let w = clip_chars(what.trim(), 60);
    // 日期形状不对就丢：它要参与"到没到日子"的比较，脏值会让比较失去意义
    if w.is_empty() || !is_day_shape(due) {
        return;
    }
    if s.pending.iter().any(|p| p.what == w) {
        return;
    }
    if s.pending.len() >= PENDING_CAP {
        s.pending.remove(0);
    }
    s.pending.push(Pending {
        what: w,
        due: due.to_string(),
        made_at: now,
        asked: false,
    });
}

/// 被叫住（出戏）时的身体反应：心跳上去、脸烫、呼吸乱。
///
/// 【为什么落在身体层】她慌了这件事，全靠模型自由发挥，十有八九是一坨形容词；而身体层是
/// **她自己会变的那部分**：HUD、设置页、【状态】块都看得见它。写进去之后这一轮的她
/// 心跳 105、下一轮还没平下来 —— 连贯性是数据给的，不是编的。
///
/// 上限 140：它是「慌」，不是让心脏炸掉（心跳这个数在界面和身体语言里都得说得通）。
pub fn fluster(body: &mut Body) {
    body.heart_rate = body.heart_rate.saturating_add(22).min(140);
    body.warmth = clamp01(body.warmth + 0.18);
    body.breath = clamp01(body.breath + 0.25);
    // 【可能被同轮的渲染覆盖】身体语言那条链（`render_body_language`）在 turn_report 里
    // 是按数值统一生成的，它跑在 fluster 之后就会盖掉这句。心跳与体温不受影响 ——
    // 那才是主信号；这句是给"界面直接看 fluster 的场合"用的兜底。
    body.language = "刚被叫住，耳朵发烫，尾巴僵在半空".to_string();
}

/// 到期的伏笔（顺手**标记为已问**，并清掉过期的）。
///
/// 【为什么"取"的时候就标记】取出来 = 马上就要注进上下文 = 她知道了。
/// 不标记的话同一件事会连着问好几天。过期与已问的一律扔掉：伏笔不是待办清单。
pub fn take_due_pending(s: &mut CharState, today: &str, now: u64) -> Vec<String> {
    s.pending
        .retain(|p| !p.asked && now.saturating_sub(p.made_at) <= PENDING_KEEP_MS);
    if !is_day_shape(today) {
        return Vec::new();
    }
    let mut out = Vec::new();
    for p in s.pending.iter_mut() {
        if out.len() >= PENDING_MAX {
            break;
        }
        // `YYYY-MM-DD` 的字典序就是日期序 —— 不必把日期解析成数字
        if p.due.as_str() <= today {
            p.asked = true;
            out.push(p.what.clone());
        }
    }
    out
}

/// 只看一眼到期的伏笔，**不标记**（主动开口那条链用：她最后可能没说出来）
pub fn peek_due_pending(s: &CharState, today: &str) -> Vec<String> {
    if !is_day_shape(today) {
        return Vec::new();
    }
    s.pending
        .iter()
        .filter(|p| !p.asked && p.due.as_str() <= today)
        .take(PENDING_MAX)
        .map(|p| p.what.clone())
        .collect()
}

/// 把某件伏笔标记成"问过了"（她**真的开口说了**之后才调 —— 没说出口就不该丢掉）
pub fn mark_pending_asked(s: &mut CharState, what: &str) -> bool {
    let w = what.trim();
    if w.is_empty() {
        return false;
    }
    let mut hit = false;
    for p in s.pending.iter_mut() {
        if p.what == w {
            p.asked = true;
            hit = true;
        }
    }
    hit
}

/// 【待回访】块正文（空串 = 不加这个块）
pub fn render_pending_block(items: &[String]) -> String {
    if items.is_empty() {
        return String::new();
    }
    let mut out =
        String::from("【待回访】\n主人之前提过、现在该问一句的事（挑最自然的一件，别罗列、别硬塞）：\n");
    for w in items {
        out.push_str(&format!("· {w}\n"));
    }
    out
}

// ─────────────────────── 关系阶段（她该怎么说话） ───────────────────────

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Stage {
    New,
    Familiar,
    Close,
    Intimate,
}

impl Stage {
    pub fn label(self) -> &'static str {
        match self {
            Stage::New => "刚认识",
            Stage::Familiar => "熟起来了",
            Stage::Close => "亲近",
            Stage::Intimate => "很亲密",
        }
    }

    /// 这一档该怎么说话（一行，注入用）
    pub fn tone(self) -> &'static str {
        match self {
            Stage::New => "客气一点、别自来熟；称呼规矩些，别急着撒娇。",
            Stage::Familiar => "可以开玩笑、可以有情绪了，但还别越界。",
            Stage::Close => "会主动关心、会占一点小便宜、会嘴硬但其实舍不得走。",
            Stage::Intimate => "撒娇、护短，默认「我们会一直这样」；可以提只有你们俩懂的事。",
        }
    }
}

/// 关系阶段：好感 / 认识天数 / 轮数**三者都到**才算数。
///
/// 【为什么三条一起看】只看好感，刚认识就飙到 80 会显得便宜；只看天数，
/// 认识三年但只聊过两句也不该像老夫老妻。取交集是**刻意保守**：
/// 宁可慢一档，也别让她在第二天就摆出老夫老妻的姿态（那最出戏）。
pub fn relation_stage(affinity: u8, days: u32, turns: u32) -> Stage {
    if affinity >= 80 && days >= 30 && turns >= 300 {
        Stage::Intimate
    } else if affinity >= 60 && days >= 10 && turns >= 100 {
        Stage::Close
    } else if affinity >= 42 && days >= 3 && turns >= 20 {
        Stage::Familiar
    } else {
        Stage::New
    }
}

/// 【关系】块正文（空串 = 不加这个块）。`address` 为空就只说阶段。
pub fn render_relation_block(s: &CharState, address: &str, now: u64) -> String {
    let days = days_together(s, now).max(1);
    // days_together 给的是 u64（天数是从认识那天起算的），关系阶段按 u32 比 —— 夹一下
    let stage = relation_stage(s.affinity, days.min(u32::MAX as u64) as u32, s.turns);
    let mut out = format!(
        "【关系】\n第 {} 天 · {} · 好感 {}/100",
        days,
        stage.label(),
        s.affinity
    );
    let a = address.trim();
    if !a.is_empty() {
        out.push_str(&format!(" · 她叫你「{}」", clip_chars(a, 16)));
    }
    out.push('\n');
    out.push_str(stage.tone());
    out.push('\n');
    out
}

// ─────────────────────── 模型感知的结果（B 链路回传） ───────────────────────

/// 让模型判断情绪时，它要按这个形状回（页面侧 sense.js 解析后交回来）。
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct ModelSense {
    /// -1..1
    pub valence: Option<f32>,
    /// 0..1
    pub arousal: Option<f32>,
    /// 好感增量（-5..5，会被夹住 —— 模型没资格一次加 50）
    pub affinity_delta: Option<f32>,
    /// 心情标签（可选，给了就用它）
    pub mood: String,
    /// 当前处境（可选，给了就覆盖）
    pub arc: String,
    /// 新发现的关键约定（可选，会去重合并）
    pub anchors: Vec<String>,
    /// 0..1 模型自己觉得这次判断有多可靠（低就少动状态）
    pub confidence: Option<f32>,
    /// 这次对话里冒出来的"还没发生完的事"（可选，最多一件）
    pub followup: Option<Followup>,
}

/// 模型从对话里认出的一件伏笔。
///
/// 【为什么日期由页面算】模型只该给**粗档**（今天/明天/这周），绝对日期由页面按本地
/// 日历换算 —— 让模型直接吐 `2026-10-05` 它十有八九会算错，而"哪天"是本项目的
/// 老规矩：**日期一律由页面报**（`std` 只有 UTC，壳自己算会差一天）。
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct Followup {
    /// 一句话说清是什么事（"面试"）
    pub what: String,
    /// 绝对日期 `YYYY-MM-DD`（页面换算好的）
    pub due: String,
}

/// 把模型判断并进状态。故意做得比 apply_turn **更保守**：
/// 好感增量夹在 ±5，且按 confidence 打折 —— 模型偶尔会一本正经地胡说。
pub fn apply_model_sense(state: &mut CharState, m: &ModelSense, now: u64) {
    let conf = m.confidence.unwrap_or(0.6).clamp(0.0, 1.0);
    if let Some(v) = m.valence {
        let target = clamp_pm1(v);
        state.valence = clamp_pm1(state.valence * (1.0 - conf) + target * conf);
    }
    if let Some(a) = m.arousal {
        let target = clamp01(a);
        state.arousal = clamp01(state.arousal * (1.0 - conf) + target * conf);
    }
    if let Some(d) = m.affinity_delta {
        let step = d.clamp(-5.0, 5.0) * conf;
        let next = state.affinity as f32 + step;
        state.affinity = next.clamp(0.0, 100.0).round() as u8;
    }
    if !m.mood.trim().is_empty() {
        state.mood = clip_chars(&m.mood, 12);
    } else {
        state.mood = mood_label(state.valence, state.arousal).to_string();
    }
    if !m.arc.trim().is_empty() {
        state.arc = clip_chars(&m.arc, 80);
    }
    for a in &m.anchors {
        let t = a.trim();
        if t.is_empty() {
            continue;
        }
        let t = clip_chars(t, 80);
        if !state.anchors.iter().any(|x| x == &t) {
            state.anchors.push(t);
        }
    }
    if let Some(f) = &m.followup {
        add_pending(state, &f.what, &f.due, now);
    }
    state.last_sense_turn = state.turns;
    state.updated_at = now;
    state.clamp_all();
}

/// 让模型感知的当日额度闸：先问能不能用，再记一笔。
/// day 由页面给（本地日期 YYYY-MM-DD）—— Rust 这边不想为了个日期引 chrono。
pub fn sense_budget_ok(state: &mut CharState, day: &str, cap: u32) -> bool {
    if day.trim().is_empty() {
        return false;
    }
    if state.sense_day != day {
        state.sense_day = day.to_string();
        state.sense_count = 0;
    }
    if cap > 0 && state.sense_count >= cap {
        return false;
    }
    state.sense_count = state.sense_count.saturating_add(1);
    true
}

/// 门控：这一轮该不该**自己**去反思（mode=auto 时才可能）。
///
/// 与情绪感知同一个套路：间隔没到不问、上次刚反思过不问。
/// manual 模式永远返回 false —— 那是由主人点按钮触发的，不走这里。
pub fn want_self_review(mode: &str, every: u32, s: &CharState) -> bool {
    if mode != "auto" {
        return false;
    }
    let every = if every == 0 { 30 } else { every };
    s.turns.saturating_sub(s.last_review_turn) >= every
}

/// 自我修订的额度闸（同一个套路，但账要分开记 —— 两件事花的额度不能混）。
pub fn review_budget_ok(state: &mut CharState, day: &str, cap: u32) -> bool {
    if day.trim().is_empty() {
        return false;
    }
    if state.review_day != day {
        state.review_day = day.to_string();
        state.review_count = 0;
    }
    if cap > 0 && state.review_count >= cap {
        return false;
    }
    state.review_count = state.review_count.saturating_add(1);
    true
}

/// 空闲主动的额度闸（同一个套路）。
pub fn proactive_budget_ok(state: &mut CharState, day: &str, cap: u32) -> bool {
    if day.trim().is_empty() {
        return false;
    }
    if state.proactive_day != day {
        state.proactive_day = day.to_string();
        state.proactive_count = 0;
    }
    if cap > 0 && state.proactive_count >= cap {
        return false;
    }
    state.proactive_count = state.proactive_count.saturating_add(1);
    true
}

/// 现在是不是「安静时段」（这段里她不许主动开口）。
///
/// 【为什么不能直接 `from <= h && h < to`】安静时段十有八九是跨零点的（23 点 → 8 点）。
/// 那样写：`23 <= h && h < 8` 永远为假（等于没配，白配一个旋钮）；
/// 把两侧换个位置写成 `8 <= h && h < 23` 更糟 —— 白天禁言、半夜随便说，正好反了。
/// 跨零点的正确判据是「从 from 起绕了多少小时」：
/// 时长 `(to - from + 24) % 24`、偏移 `(h - from + 24) % 24`，偏移落在时长之内就是安静。
///
/// 【没配 / 配坏了怎么办】一律当**不安静**。这道闸的作用是少打扰，不是替主人做决定：
/// 一个笔误不该让她从此闭嘴（要静音有「空闲主动 → 关」那一档，那个意图是明确的）。
///
/// 【hour 越界也要兜住】它是页面报上来的（`new Date().getHours()`），先取模再算 ——
/// 报来 25 时不该算出个莫名其妙的结论。
pub fn quiet_now(from: Option<u32>, to: Option<u32>, hour: u32) -> bool {
    let (Some(f), Some(t)) = (from, to) else {
        return false;
    };
    // f == t 有两种解读（全天禁言 / 形同虚设），一律当「没配」——歧义的东西不猜
    if f > 23 || t > 23 || f == t {
        return false;
    }
    let span = (t + 24 - f) % 24;
    let off = (hour % 24 + 24 - f) % 24;
    off < span
}

#[cfg(test)]
mod tests {
    use super::*;


    /// 安静时段：跨零点（23 → 8）两个方向都得对，缺一半/配坏了都不许静音。
    #[test]
    fn quiet_window_crosses_midnight() {
        let (f, t) = (Some(23), Some(8));
        // 23 点到次日 8 点之间：安静
        for h in [23, 0, 3, 7] {
            assert!(quiet_now(f, t, h), "{h} 点该是安静时段");
        }
        // 8 点整开始就能说了（左闭右开），白天更不用说
        for h in [8, 12, 22] {
            assert!(!quiet_now(f, t, h), "{h} 点不该被静音");
        }
    }

    /// 不跨零点的时段（13 → 15）也要对，且不许把两边搞反。
    #[test]
    fn quiet_window_within_a_day() {
        let (f, t) = (Some(13), Some(15));
        assert!(quiet_now(f, t, 13));
        assert!(quiet_now(f, t, 14));
        assert!(!quiet_now(f, t, 15), "右端是开的");
        assert!(!quiet_now(f, t, 12));
        assert!(!quiet_now(f, t, 2), "★反过来的那一侧绝不能被静音★");
    }

    /// 没配 / 只配一半 / 配坏 / 相等 / hour 越界 —— 一律不许静音。
    #[test]
    fn quiet_needs_a_sane_window() {
        assert!(!quiet_now(None, None, 3), "没配 = 全天都能说");
        assert!(!quiet_now(Some(23), None, 3), "只配一半不该生效");
        assert!(!quiet_now(None, Some(8), 3), "只配一半不该生效");
        assert!(!quiet_now(Some(23), Some(23), 23), "两边相同有歧义，当没配");
        assert!(!quiet_now(Some(24), Some(8), 3), "越界的小时当没配");
        assert!(!quiet_now(Some(23), Some(25), 3), "越界的小时当没配");
        // 页面报上来脏值也要兜住（不能算出个莫名其妙的结果）
        assert!(quiet_now(Some(23), Some(8), 25), "25 点 ≡ 1 点，仍在安静时段");
    }

    // ── 关系阶段 ──────────────────────────────────────────────────

    /// 三样都到才升档；**只满足其中一两样绝不跳档**（那是最出戏的一种）。
    #[test]
    fn relation_stage_needs_all_three() {
        assert_eq!(relation_stage(30, 1, 0), Stage::New, "刚认识");
        // 只有好感高
        assert_eq!(relation_stage(100, 1, 0), Stage::New, "刚认识就 100 好感也不该熟络");
        // 只有天数
        assert_eq!(relation_stage(30, 400, 0), Stage::New, "认识三年但没聊过");
        // 只有轮数
        assert_eq!(relation_stage(30, 1, 900), Stage::New, "一天聊 900 轮也还是刚认识");
        // 三样都到
        assert_eq!(relation_stage(42, 3, 20), Stage::Familiar);
        assert_eq!(relation_stage(60, 10, 100), Stage::Close);
        assert_eq!(relation_stage(80, 30, 300), Stage::Intimate);
    }

    /// 阶段只升不降（好感不会掉到 0，天数只会涨），且每档都有话术。
    #[test]
    fn relation_stage_advances_and_has_tone() {
        let mut last = relation_stage(0, 0, 0);
        for (a, d, t) in [(42, 3, 20), (60, 10, 100), (80, 30, 300)] {
            let s = relation_stage(a, d, t);
            assert!(s != last, "{a}/{d}/{t} 该升档");
            last = s;
        }
        for s in [Stage::New, Stage::Familiar, Stage::Close, Stage::Intimate] {
            assert!(!s.label().is_empty());
            assert!(!s.tone().is_empty());
            assert!(s.tone().chars().count() <= 60, "话术要短：{}", s.tone());
        }
    }

    /// 关系块：带上第几天/阶段/好感，有称呼才写称呼。
    #[test]
    fn relation_block_mentions_address_only_when_given() {
        let mut s = CharState::default();
        s.first_seen_at = 1_000_000_000_000;
        let now = s.first_seen_at + 4 * 24 * 60 * 60 * 1000;
        let with = render_relation_block(&s, "主人", now);
        assert!(with.contains("第 5 天"), "{with}");
        assert!(with.contains("主人"), "{with}");
        assert!(with.contains("好感 30/100"), "{with}");
        let without = render_relation_block(&s, "  ", now);
        assert!(!without.contains("叫你"), "没配称呼就别编一个：{without}");
    }

    // ── 场景 ──────────────────────────────────────────────────────

    /// 没设场景 = 零注入（一个空块都不该往提示词里塞）。
    #[test]
    fn scene_block_is_empty_when_unset() {
        let mut s = CharState::default();
        assert_eq!(render_scene_block(&s), "");
        s.scene.text = "    ".into();
        assert_eq!(render_scene_block(&s), "", "只有空白也算没设");
        s.scene.text = "凌晨一点的厨房".into();
        assert!(render_scene_block(&s).contains("凌晨一点的厨房"));
        s.scene.name = "深夜书房".into();
        let named = render_scene_block(&s);
        assert!(named.starts_with("【场景】"), "块标题必须在正文里：{named}");
        assert!(named.contains("｜深夜书房"), "预设名也要看得见：{named}");
    }

    /// 场景太长要截断 —— 它是背景，不该把提示词吃掉一半。
    #[test]
    fn scene_block_clips_long_text() {
        let mut s = CharState::default();
        s.scene.text = "啊".repeat(500);
        let out = render_scene_block(&s);
        // 100 字正文 + 【场景】 + 换行
        assert!(out.chars().count() <= 115, "{}", out.chars().count());
    }

    // ── 伏笔 ──────────────────────────────────────────────────────

    /// 没到日子不问；到日子且当天问。
    #[test]
    fn pending_fires_on_or_after_due_day() {
        let mut s = CharState::default();
        add_pending(&mut s, "面试", "2026-10-05", 0);
        assert!(take_due_pending(&mut s, "2026-10-04", 0).is_empty(), "还没到日子");
        assert!(peek_due_pending(&s, "2026-10-04").is_empty());
        assert_eq!(peek_due_pending(&s, "2026-10-05"), vec!["面试"], "当天就该问");
        assert_eq!(take_due_pending(&mut s, "2026-10-06", 0), vec!["面试"], "过了一天照样该问");
    }

    /// ★问过就不再问★（同一件事追问三天比不问更烦）。
    #[test]
    fn pending_is_asked_only_once() {
        let mut s = CharState::default();
        add_pending(&mut s, "面试", "2026-10-05", 0);
        assert_eq!(take_due_pending(&mut s, "2026-10-05", 0).len(), 1);
        assert!(take_due_pending(&mut s, "2026-10-05", 0).is_empty(), "第二轮不该再给");
        assert!(take_due_pending(&mut s, "2026-10-09", 0).is_empty(), "过了几天也别回头问");
        assert!(s.pending.is_empty(), "问过的该被清掉，不留垃圾");
    }

    /// 去重 / 脏日期不收 / 数量有上限。
    #[test]
    fn pending_dedupes_and_rejects_junk() {
        let mut s = CharState::default();
        add_pending(&mut s, "面试", "2026-10-05", 0);
        add_pending(&mut s, "面试", "2026-10-09", 0);
        assert_eq!(s.pending.len(), 1, "同一件事只留一条");
        add_pending(&mut s, "体检", "下周三", 0);
        assert_eq!(s.pending.len(), 1, "日期形状不对就不收（它要参与比较）");
        add_pending(&mut s, "  ", "2026-10-09", 0);
        assert_eq!(s.pending.len(), 1, "空的不收");
        for i in 0..40 {
            add_pending(&mut s, &format!("事{i}"), "2026-10-09", 0);
        }
        assert!(s.pending.len() <= 12, "数量要封顶：{}", s.pending.len());
    }

    /// 压太久的伏笔过期就忘（它不是待办清单）。
    #[test]
    fn pending_forgets_stale_items() {
        let mut s = CharState::default();
        let now = 1_700_000_000_000u64;
        add_pending(&mut s, "面试", "2026-10-05", now);
        // 15 天后再取：直接扔掉，不再注入
        assert!(take_due_pending(&mut s, "2026-10-05", now + 15 * 24 * 60 * 60 * 1000).is_empty());
        assert!(s.pending.is_empty());
    }

    /// 一次最多交出去 3 件（多了她会变成查岗）。
    #[test]
    fn pending_caps_what_is_handed_out() {
        let mut s = CharState::default();
        for i in 0..5 {
            add_pending(&mut s, &format!("事{i}"), "2026-10-05", 0);
        }
        let got = take_due_pending(&mut s, "2026-10-05", 0);
        assert_eq!(got.len(), 3, "一次最多三件：{got:?}");
        let asked = s.pending.iter().filter(|p| p.asked).count();
        assert_eq!(asked, 3, "★只有交出去的那三件才算问过★");
        assert_eq!(s.pending.len(), 5, "剩下的两件要留着 —— 封顶不该吃掉伏笔");
        assert_eq!(
            take_due_pending(&mut s, "2026-10-05", 0).len(),
            2,
            "下一轮把那两件交出去"
        );
    }

    /// 主动开口那条链只"看一眼"，不标记 —— 她最后可能没说出口。
    #[test]
    fn peek_does_not_consume() {
        let mut s = CharState::default();
        add_pending(&mut s, "面试", "2026-10-05", 0);
        assert_eq!(peek_due_pending(&s, "2026-10-05").len(), 1);
        assert_eq!(peek_due_pending(&s, "2026-10-05").len(), 1, "看几次都还在");
        assert!(!s.pending[0].asked);
        // 真说出来了才标记
        assert!(mark_pending_asked(&mut s, "面试"));
        assert!(!mark_pending_asked(&mut s, "别的"));
        assert!(peek_due_pending(&s, "2026-10-05").is_empty());
    }

    /// 日期报成空串/脏值时，整条链不炸、也不乱问。
    #[test]
    fn pending_needs_a_valid_today() {
        let mut s = CharState::default();
        add_pending(&mut s, "面试", "2026-10-05", 0);
        assert!(take_due_pending(&mut s, "", 0).is_empty());
        assert!(take_due_pending(&mut s, "今天", 0).is_empty());
        assert!(peek_due_pending(&s, "").is_empty());
        assert_eq!(s.pending.len(), 1, "坏日期不该把伏笔弄丢");
    }

    /// 待回访块：空列表 = 零注入；有料时带上"别罗列"的约束。
    #[test]
    fn pending_block_shape() {
        assert_eq!(render_pending_block(&[]), "");
        let out = render_pending_block(&["面试".into(), "体检".into()]);
        assert!(out.contains("面试") && out.contains("体检"), "{out}");
        assert!(out.contains("别罗列"), "她得知道别一口气全倒出来：{out}");
        assert!(out.starts_with("【待回访】"), "标题要自带：{out}");
        assert!(out.lines().count() <= 5, "{out}");
    }

    /// 出戏的身体反应：心跳上去、脸烫、有身体语言，而且**封顶**。
    #[test]
    fn fluster_raises_heart_and_caps() {
        let mut b = Body::default();
        let before = b.heart_rate;
        fluster(&mut b);
        assert!(b.heart_rate > before, "心跳得上去：{before} -> {}", b.heart_rate);
        assert!(b.warmth > 0.5, "脸得烫：{}", b.warmth);
        assert!(!b.language.is_empty(), "身体语言别空着");
        for _ in 0..20 {
            fluster(&mut b);
        }
        assert!(b.heart_rate <= 140, "别把心脏推炸：{}", b.heart_rate);
        assert!(b.warmth <= 1.0 && b.breath <= 1.0, "比例类的要夹在 0-1");
    }

    fn sig(v: f32, a: f32, i: f32) -> Signal {
        Signal {
            valence: v,
            arousal: a,
            intensity: i,
            hits: vec![],
            intimate: false,
            fed: false,
        }
    }

    #[test]
    fn empty_text_is_neutral_signal() {
        let s = sense_text("   ");
        assert_eq!(s.intensity, 0.0);
        assert_eq!(s.valence, 0.0);
    }

    #[test]
    fn praise_reads_positive() {
        let s = sense_text("好棒呀！主人太厉害了！");
        assert!(s.valence > 0.5, "{:?}", s);
        assert!(s.arousal > 0.4, "感叹号该把激动拉起来：{:?}", s);
        assert!(s.intensity > 0.3);
        assert!(!s.hits.is_empty());
    }

    #[test]
    fn complaint_reads_negative() {
        let s = sense_text("今天好烦，压力大到想哭。");
        assert!(s.valence < -0.5, "{:?}", s);
        assert!(s.intensity > 0.3);
    }

    #[test]
    fn mixed_leans_by_count() {
        let s = sense_text("谢谢，但是我还是有点累");
        assert!(s.valence < 0.5 && s.valence > -0.5, "正负都有时别判死：{:?}", s);
    }

    #[test]
    fn neutral_chat_has_no_intensity() {
        let s = sense_text("帮我把那个函数改成异步的");
        assert_eq!(s.intensity, 0.0, "没有情绪词就不该有情绪信号：{:?}", s);
        assert_eq!(s.valence, 0.0);
    }

    /// 同一天只留一行、换天新起一行、坏日期一律不写
    #[test]
    fn fold_daily_aggregates_one_row_per_day() {
        let mut s = CharState::default();
        s.valence = 0.5;
        fold_daily(&mut s, Some("2026-10-03"));
        fold_daily(&mut s, Some("2026-10-03"));
        assert_eq!(s.daily.len(), 1, "同一天只能有一行");
        assert_eq!(s.daily[0].turns, 2);
        fold_daily(&mut s, Some("2026-10-04"));
        assert_eq!(s.daily.len(), 2, "换天要新起一行");
        assert_eq!(s.daily[1].day, "2026-10-04");
        assert_eq!(s.daily[1].turns, 1);
    }

    #[test]
    fn fold_daily_ignores_bad_day() {
        let mut s = CharState::default();
        fold_daily(&mut s, None);
        fold_daily(&mut s, Some(""));
        fold_daily(&mut s, Some("今天"));
        fold_daily(&mut s, Some("2026/10/03"));
        fold_daily(&mut s, Some("2026-10-3"));
        assert!(s.daily.is_empty(), "不像日期的输入一律不写：宁可少一行也不要脏数据");
    }

    #[test]
    fn fold_daily_keeps_only_the_last_days() {
        let mut s = CharState::default();
        for i in 0..(DAILY_LIMIT + 5) {
            // 造 DAILY_LIMIT+5 个互不相同的日期
            let day = format!("2026-{:02}-{:02}", (i / 28) + 1, (i % 28) + 1);
            fold_daily(&mut s, Some(&day));
        }
        assert_eq!(s.daily.len(), DAILY_LIMIT, "超上限要从最老的开始丢");
        assert!(
            !s.daily.iter().any(|d| d.day == "2026-01-01"),
            "最老那天必须已经被丢掉了"
        );
    }

    #[test]
    fn intimate_words_are_detected_separately() {
        let s = sense_text("主人，抱抱");
        assert!(s.hits.iter().any(|h| h == "主人"), "{:?}", s.hits);
        assert!(s.intensity > 0.0, "亲昵称呼本身也是信号");
        assert!(s.intimate, "亲昵称呼要一并标出来（main.rs 之前硬编码了第二份词表）");
    }

    /// 关心与嘱咐该被读成**正**情绪，而不是被里面的负面词带偏 ——
    /// 「别太累」里的 `太累` 是 NEG 成员，旧词表把一句关心算成了负面。
    #[test]
    fn care_words_read_positive_and_cancel_the_neg() {
        let s = sense_text("别太累，早点睡");
        assert!(s.valence > 0.0, "关心话不该被判成负面：{:?}", s);
        assert!(
            s.hits.iter().any(|h| h == "别太累" || h == "早点睡"),
            "{:?}",
            s.hits
        );
    }

    /// 呼唤她（"在吗""露娜"）也算亲密 —— 他在找她，这件事本身就是信号
    #[test]
    fn calling_her_counts_as_intimate() {
        // 名字不再硬编码在词表里：传进来才算数
        assert!(sense_text("在吗").intimate, "问在不在算亲密（通用词，与角色无关）");
        assert!(
            sense_text_with("露娜，你看这个", &["露娜".to_string()]).intimate,
            "叫当前角色的名字算亲密"
        );
        assert!(
            !sense_text("露娜，你看这个").intimate,
            "名字不在通用表里：不传名字就不算 —— 这正是原来那处偏心"
        );
        assert!(!sense_text("这个 bug 怎么修").intimate, "技术话不该被算成亲密");
    }

    /// 详细的长句 = 他在认真讲，激动度该比一句短话高
    #[test]
    fn longer_message_raises_arousal() {
        let short = sense_text("嗯");
        let long = sense_text(
            "我今天把那个渲染管线重新理了一遍，发现瓶颈其实在顶层块数太多，\
             跟解析没关系，所以后面打算按章懒加载，你看这样行不行",
        );
        assert!(
            long.arousal > short.arousal,
            "长句的投入度该更高：{:?} vs {:?}",
            long,
            short
        );
    }

    #[test]
    fn mood_label_covers_the_grid() {
        assert_eq!(mood_label(0.8, 0.8), "雀跃");
        assert_eq!(mood_label(0.8, 0.1), "满足");
        assert_eq!(mood_label(0.0, 0.1), "平静");
        assert_eq!(mood_label(-0.8, 0.8), "炸毛");
        assert_eq!(mood_label(-0.8, 0.1), "低落");
        assert_eq!(mood_label(-0.3, 0.8), "烦躁");
        assert_eq!(mood_label(-0.3, 0.1), "有点闷");
    }

    #[test]
    fn turn_moves_state_gradually() {
        let mut s = CharState::default();
        s.character_id = "dsh-luna".into();
        let aff0 = s.affinity;
        // 一句夸奖：心情该往正向走，但不该一步到位
        apply_turn(&mut s, &sig(1.0, 0.9, 0.8), false, 1_000_000, false);
        assert!(s.valence > 0.0 && s.valence < 0.5, "惯性 35%：{}", s.valence);
        assert!(s.affinity > aff0, "被夸该涨好感");
        assert!(s.affinity - aff0 <= 2, "一次最多涨一点：{}", s.affinity - aff0);
        assert_eq!(s.turns, 1);
        assert_eq!(s.samples.len(), 1);
        // 一句抱怨：往回走
        let v1 = s.valence;
        apply_turn(&mut s, &sig(-1.0, 0.5, 0.5), false, 1_100_000, false);
        assert!(s.valence < v1);
        assert_eq!(s.turns, 2);
    }

    #[test]
    fn affinity_and_energy_stay_in_range() {
        let mut s = CharState::default();
        for i in 0..500 {
            apply_turn(&mut s, &sig(1.0, 1.0, 1.0), true, 1_000_000 + i * 1000, false);
        }
        assert_eq!(s.affinity, 100, "封顶 100");
        assert!(s.energy <= 1.0);
        assert!(s.valence <= 1.0 && s.valence >= -1.0);
        for i in 0..500 {
            apply_turn(&mut s, &sig(-1.0, 0.0, 0.0), false, 2_000_000 + i * 1000, false);
        }
        assert_eq!(s.affinity, 0, "地板 0");
    }

    #[test]
    fn energy_decays_when_idle() {
        let mut s = CharState::default();
        apply_turn(&mut s, &sig(0.0, 0.0, 0.0), false, 1_000_000, false);
        let e1 = s.energy;
        // 十小时后再说话：精力该掉下去
        apply_turn(&mut s, &sig(0.0, 0.0, 0.0), false, 1_000_000 + 10 * 3_600_000, false);
        assert!(s.energy < e1, "{} → {}", e1, s.energy);
        assert!(s.energy >= 0.0);
    }

    /// 【本次修复的核心之一】中性句连续来，情绪**不许归零**。
    ///
    /// 原来是 `valence * 0.65`（每轮 -35%），三轮就精确归零 —— 而真实对话大多
    /// 是中性句，于是状态卡死在 v=0.00（实测日志里 turn=46/47/48 三行一字不差，
    /// 主人报的"状态好像不会更新"就是这个）。
    #[test]
    fn neutral_turns_keep_the_mood_warm() {
        let mut s = CharState::default();
        s.valence = 0.6;
        for i in 0..6 {
            apply_turn(&mut s, &sig(0.0, 0.0, 0.0), false, 1_000_000 + i * 60_000, false);
        }
        assert!(s.valence > 0.45, "六轮中性话不该把情绪清零：{}", s.valence);
    }

    /// 陪伴本身该在关系账上留下痕迹（原来是 |valence|>0.2 才动，中性句永远 +0）
    #[test]
    fn company_drifts_affinity_up() {
        let mut s = CharState::default();
        let before = s.affinity;
        for i in 0..8 {
            apply_turn(&mut s, &sig(0.0, 0.0, 0.0), false, 1_000_000 + i * 60_000, false);
        }
        assert!(
            s.affinity > before,
            "八轮中性陪聊该涨一点：{} → {}",
            before,
            s.affinity
        );
        assert!(
            s.affinity - before <= 3,
            "但只能是一点点，不许暴涨：+{}",
            s.affinity - before
        );
    }

    /// 小数要攒起来 —— `affinity` 是整数、每轮 round，0.25 的微漂不攒就会被直接抹掉
    #[test]
    fn affinity_fraction_carries_over() {
        let mut s = CharState::default();
        s.affinity = 50;
        s.affinity_frac = 0.0;
        apply_turn(&mut s, &sig(0.0, 0.0, 0.0), false, 1_000_000, false);
        assert_eq!(s.affinity, 50, "一轮的微漂不足 1，不该立刻进位");
        assert!(s.affinity_frac > 0.0, "但小数要存下来：{}", s.affinity_frac);
    }

    #[test]
    fn samples_are_capped() {
        let mut s = CharState::default();
        for i in 0..100 {
            apply_turn(&mut s, &sig(0.1, 0.1, 0.1), false, 1_000_000 + i * 1000, false);
        }
        assert_eq!(s.samples.len(), SAMPLE_LIMIT);
        assert_eq!(s.turns, 100, "曲线封顶不能影响轮数统计");
    }

    #[test]
    fn state_json_roundtrip() {
        let mut s = CharState::default();
        s.character_id = "dsh-luna".into();
        s.arc = "主人在做 ds-companion".into();
        s.anchors = vec!["叫主人「主人」".into(), "被夸会嘴硬但尾巴在摇".into()];
        apply_turn(&mut s, &sig(0.5, 0.5, 0.5), true, 1_000_000, false);
        let text = serde_json::to_string_pretty(&s).unwrap();
        let back: CharState = serde_json::from_str(&text).unwrap();
        assert_eq!(back.anchors, s.anchors);
        assert_eq!(back.arc, s.arc);
        assert_eq!(back.affinity, s.affinity);
        assert_eq!(back.samples.len(), 1);
        assert!((back.valence - s.valence).abs() < 1e-6);
    }

    #[test]
    fn old_state_file_without_new_fields_still_loads() {
        // 手改过 / 老版本写的最小 JSON：不能整份失败
        let json = r#"{"characterId":"dsh-luna","mood":"雀跃","valence":0.5,"affinity":66}"#;
        let s: CharState = serde_json::from_str(json).unwrap();
        assert_eq!(s.affinity, 66);
        assert_eq!(s.anchors.len(), 0);
        assert!(s.energy > 0.0, "缺字段用默认值补");
    }

    #[test]
    fn clamp_all_fixes_out_of_range_values() {
        let mut s = CharState::default();
        s.valence = 9.0;
        s.arousal = -3.0;
        s.energy = 5.0;
        s.affinity = 250;
        s.anchors = vec!["ok".into(), "  ".into()];
        s.clamp_all();
        assert_eq!(s.valence, 1.0);
        assert_eq!(s.arousal, 0.0);
        assert_eq!(s.energy, 1.0);
        assert_eq!(s.affinity, 100);
        assert_eq!(s.anchors, vec!["ok".to_string()], "空锚点要清掉");
    }

    #[test]
    fn state_block_carries_mood_and_format_forbids_numbers() {
        let mut s = CharState::default();
        s.character_id = "dsh-luna".into();
        s.mood = "雀跃".into();
        s.affinity = 42;
        s.arc = "主人在忙记忆模块".into();
        let block = render_state_block(&s, Some(&s.body), None, 1_000_000_000_000, false);
        assert!(block.starts_with("【状态】"));
        assert!(block.contains("雀跃"));
        assert!(block.contains("42/100"));
        assert!(block.contains("主人在忙记忆模块"));
        assert!(block.contains("身体："), "身体层要一起进去：{block}");
        assert!(block.contains("不要报数字"), "得明确禁止它念数字");
    }

    // ── 任务模式 ──────────────────────────────────────────────────

    /// 正例：真的在干活 → 必须进工作态
    #[test]
    fn task_signals_detect_work() {
        for s in [
            "这个 error[E0603] 怎么修",
            "帮我改一下 src/App.tsx 的 import",
            "git push 报 non-fast-forward，帮我看看",
            "```js\nconst a = 1\n```\n这段什么意思",
            "C:\\Users\\me\\projects\\x 下面的配置文件在哪",
            "接口返回 500，日志里没记录",
        ] {
            let sig = sense_task(s);
            assert!(sig.is_task, "该判成工作态：{s:?} → {sig:?}");
            assert!(!sig.hits.is_empty(), "命中的词要留痕：{sig:?}");
        }
    }

    /// 反例（关键）：日常聊天**绝不能**被判成工作态 —— 误判比漏判更伤
    #[test]
    fn chat_is_not_task() {
        for s in [
            "本小姐今天想你了",
            "陪我聊会儿天",
            "嘿嘿",
            "主人抱抱",
            "你真好",
        ] {
            let sig = sense_task(s);
            assert!(!sig.is_task, "不该判成工作态：{s:?} → {sig:?}");
        }
    }

    /// 判据必须挡住"两句闲聊凑出一个工作态"
    #[test]
    fn weak_signals_alone_are_not_enough() {
        assert!(!sense_task("看看这个").is_task, "中信号单条不该进");
        assert!(!sense_task("行吧").is_task, "短句要压分");
    }

    #[test]
    fn task_tracker_hysteresis() {
        let mut t = TaskTracker::default();
        let work = sense_task("改一下这个函数");
        let chat = sense_task("嘿嘿");
        assert!(work.is_task && !chat.is_task, "前提：这一正一反要判对");

        let (active, changed) = t.step(&work);
        assert!(active && changed, "第一次命中该进");
        let (active, changed) = t.step(&chat);
        assert!(active && !changed, "一轮闲聊不该立刻退出（防忽开忽关）");
        let (active, changed) = t.step(&chat);
        assert!(!active && changed, "连续两轮没信号才退");
        assert_eq!(t.calm_rounds, 0, "退出后计数要归零");
    }

    #[test]
    fn task_mode_manual_override_wins() {
        let chat = sense_task("嘿嘿");
        let mut t = TaskTracker::default();
        let (active, changed) = t.apply_mode("on", &chat);
        assert!(active && changed);
        assert!(t.apply_mode("on", &chat).0, "on 要一直钉住");

        let (active, changed) = t.apply_mode("off", &sense_task("git push 报错"));
        assert!(!active && changed, "off 要压过强信号");

        let mut t2 = TaskTracker::default();
        assert!(t2.apply_mode("auto", &sense_task("报错了")).0, "auto 按信号走");
        let mut t3 = TaskTracker::default();
        assert!(!t3.apply_mode("", &chat).0, "空串=自动，闲聊就是日常态");
    }

    /// 工作模式的状态块：压成一行、不带心情/好感/身体
    #[test]
    fn state_block_is_compressed_in_task_mode() {
        let mut s = CharState::default();
        s.character_id = "dsh-luna".into();
        s.mood = "雀跃".into();
        s.affinity = 42;
        s.arc = "主人在调 ds-companion 的工具链路".into();
        let mut u = UserState::default();
        u.turns = 3;
        u.busy = true;
        u.energy = 0.4;
        u.engagement = 0.5;
        u.mood = "专注".into();

        let full = render_state_block(&s, Some(&s.body), Some(&u), 1_000_000_000_000, false);
        let compact = render_state_block(&s, Some(&s.body), Some(&u), 1_000_000_000_000, true);
        assert!(compact.len() < full.len(), "压缩版必须更短：{compact}");
        assert!(compact.contains("【状态】"));
        assert!(compact.contains("处境"), "处境要留住（她得知道在干嘛）");
        assert!(compact.contains("在忙"), "对方忙不忙要留住（决定收着点）");
        assert!(!compact.contains("好感"), "工作态不给好感这种玩闹许可：{compact}");
        assert!(!compact.contains("身体："), "身体描写也是玩闹素材，压掉：{compact}");

        let empty = CharState::default();
        assert_eq!(
            render_state_block(&empty, Some(&empty.body), None, 1, true),
            "",
            "没内容就别注入空壳块（那也是花钱）"
        );
    }

    /// 工作模式的好感保护：负面信号只降情绪，不扣好感
    #[test]
    fn task_mode_protects_affinity() {
        let mut a = CharState::default();
        a.character_id = "x".into();
        a.affinity = 50;
        let mut b = CharState::default();
        b.character_id = "x".into();
        b.affinity = 50;

        let neg = sig(-1.0, 0.5, 0.5);
        apply_turn(&mut a, &neg, false, 1_000_000, false);
        apply_turn(&mut b, &neg, false, 1_000_000, true);
        assert!(a.affinity < 50, "日常态：抱怨会掉好感（{}）", a.affinity);
        assert_eq!(b.affinity, 50, "工作态：工作引起的情绪不记在关系账上");
        assert!(b.valence < 0.0, "但情绪本身还是要降下来");

        let mut c = CharState::default();
        c.character_id = "x".into();
        c.affinity = 50;
        apply_turn(&mut c, &sig(0.0, 0.0, 0.0), true, 1_000_000, true);
        assert_eq!(c.affinity, 50, "工作态下叫「主人」不刷好感");
    }

    /// 【回归】喂她吃东西必须真的能降 hunger。
    ///
    /// 原来它只有加法通路：时间 +0.07/小时、每轮 +0.01、睡醒 +0.25 ——
    /// 涨到 100% 就永远出不来（主人报的"怎么也解除不了，即使我喂她吃东西"就是这个，
    /// 系统里根本没有"吃东西"这回事）。
    #[test]
    fn feeding_lowers_hunger() {
        let mut b = Body::default();
        b.hunger = 1.0;
        let fed = Signal {
            fed: true,
            ..Default::default()
        };
        apply_body_turn(&mut b, &fed, 0.3, 1_000_000);
        assert!(b.hunger < 0.6, "喂一顿该明显降下来：{}", b.hunger);
        assert!(b.stamina <= 1.0 && b.warmth <= 1.0, "顺手回的体力和暖意不许越界");

        // 连着喂两顿不能是幂等的（第二顿还要继续降）
        let after1 = b.hunger;
        apply_body_turn(&mut b, &fed, 0.3, 1_000_100);
        assert!(b.hunger < after1, "第二顿也要降：{after1} → {}", b.hunger);

        // 没喂的话照旧慢慢涨 —— 这是原来唯一的行为，不能被改掉
        let before = b.hunger;
        apply_body_turn(&mut b, &Signal::default(), 0.3, 1_000_200);
        assert!(b.hunger > before, "没喂就继续饿：{before} → {}", b.hunger);
    }

    /// 喂食识别的正反例 —— 中文里"吃"的主语太容易搞错，两边都要盯住
    #[test]
    fn feed_detection_covers_both_directions() {
        for t in [
            "给你带了你爱喝的奶茶",
            "来，喂你一口",
            "要不要吃点东西？",
            "我买了蛋糕你要不要尝尝",
        ] {
            assert!(sense_text(t).fed, "该判成喂食：{t}");
        }
        for t in [
            "我去吃饭了，等我一下",
            "我自己煮了面",
            "今天想喝奶茶",
            "这个功能先放着吧",
        ] {
            assert!(!sense_text(t).fed, "不该判成喂食（那是我在吃）：{t}");
        }
    }

    // ─────────────── 通路自检（每个数值有没有出口）───────────────
    //
    // 这组测试盯的是"卡住"能不能被**认出来**：2026-10-01 连着的三个 bug 都是
    // "机制没坏、通路断了"，而当时没有任何东西会告警。

    /// 饿着没人管：要能报出来，而且要说清"多少轮没喂过"
    #[test]
    fn vitals_catch_starving() {
        let mut s = CharState::default();
        s.turns = 100;
        s.last_fed_turn = 50; // 50 轮没喂过
        s.body.hunger = 0.95;
        let v = check_vitals(&s);
        let hunger = v.iter().find(|x| x.key == "hunger").expect("该报饥饿");
        assert!(hunger.text.contains("50 轮"), "{}", hunger.text);
        assert!(!hunger.hint.is_empty(), "必须告诉人怎么办");

        // 刚喂过就不该报（否则告警会一直挂着，人就不看了）
        s.last_fed_turn = 99;
        assert!(
            check_vitals(&s).iter().all(|x| x.key != "hunger"),
            "刚喂过不该报"
        );
    }

    /// 情绪信号断掉：连续很多轮读不出东西 → 报出来
    #[test]
    fn vitals_catch_flat_signal() {
        let mut s = CharState::default();
        s.turns = 30;
        s.flat_turns = 15;
        assert!(check_vitals(&s).iter().any(|x| x.key == "mood"));
        s.flat_turns = 3;
        assert!(
            check_vitals(&s).iter().all(|x| x.key != "mood"),
            "偶尔几轮读不出东西很正常，不该报"
        );
    }

    /// 一切正常时**一条都不该报** —— 狼来了几次之后人就不看了
    #[test]
    fn vitals_stay_quiet_when_healthy() {
        let mut s = CharState::default();
        s.turns = 50;
        s.last_fed_turn = 48;
        s.body.hunger = 0.4;
        s.body.sleepiness = 0.3;
        s.body.stamina = 0.8;
        s.flat_turns = 1;
        s.affinity = 60;
        s.affinity_stuck_turns = 2;
        assert!(check_vitals(&s).is_empty(), "{:?}", check_vitals(&s));
    }

    /// 好感接近满值时"长期不动"是**设计**（微漂越接近满值越慢），不是故障
    #[test]
    fn vitals_do_not_report_full_affinity() {
        let mut s = CharState::default();
        s.affinity = 98;
        s.affinity_stuck_turns = 100;
        s.turns = 100;
        s.last_fed_turn = 90;
        s.body.hunger = 0.3;
        s.body.stamina = 0.8;
        s.body.sleepiness = 0.2;
        assert!(
            check_vitals(&s).iter().all(|x| x.key != "affinity"),
            "满值附近长期不动是设计，不是故障"
        );
    }

    /// 计数器必须真的被 apply_turn 维护 —— 否则告警永远不响（"写了却不生效"）
    #[test]
    fn counters_are_maintained_by_apply_turn() {
        let mut s = CharState::default();
        s.turns = 10;
        // 三轮中性话 → flat_turns 累到 3
        for i in 0..3 {
            apply_turn(&mut s, &Signal::default(), false, 1_000_000 + i * 1000, false);
        }
        assert_eq!(s.flat_turns, 3, "零信号该累计");

        // 来一句有情绪的 → 清零
        apply_turn(&mut s, &sig(0.8, 0.5, 0.6), false, 2_000_000, false);
        assert_eq!(s.flat_turns, 0, "读出情绪就该清零");

        // 喂食 → 记下轮数（记在 +1 之前那一轮）
        let before_turns = s.turns;
        let fed = Signal {
            fed: true,
            ..Default::default()
        };
        apply_turn(&mut s, &fed, false, 3_000_000, false);
        assert_eq!(
            s.last_fed_turn, before_turns,
            "喂食要记在被 +1 之前的那一轮"
        );
    }

    /// 工作块：措辞必须"软"（不禁止角色扮演），但要收得住
    #[test]
    fn task_block_is_soft_but_firm() {
        let b = render_task_block();
        assert!(b.starts_with("【工作模式】"));
        assert!(b.contains("先办事"));
        assert!(b.contains("准确 > 好玩"));
        assert!(b.contains("别往心里去"), "要明确：报错不是对她发脾气");
        assert!(b.contains("做完这一件事就回来"), "要有出口，不然像被禁言");
        assert!(!b.contains("禁止"), "不写「禁止」这类硬词：她的性格是主人的东西");
    }

    // ── 身体层 ────────────────────────────────────────────────────

    #[test]
    fn body_starts_alive_and_sane() {
        let b = Body::default();
        assert!(b.stamina > 0.5 && b.sleepiness < 0.5 && !b.asleep);
        assert!((60..=100).contains(&b.heart_rate));
    }

    #[test]
    fn body_drifts_with_real_time() {
        let mut b = Body::default();
        let t0 = 1_000_000_000u64;
        assert!(apply_body_elapsed(&mut b, t0, 14).is_none(), "第一次只记时间");
        let (s0, sl0, h0) = (b.stamina, b.sleepiness, b.hunger);
        // 白天 3 小时没人理
        apply_body_elapsed(&mut b, t0 + 3 * 3_600_000, 15);
        assert!(b.sleepiness > sl0, "越等越困");
        assert!(b.stamina < s0, "体力会掉");
        assert!(b.hunger > h0, "会饿");
    }

    #[test]
    fn body_sleeps_after_a_long_absence() {
        let mut b = Body::default();
        b.sleepiness = 0.7;
        let t0 = 1_000_000_000u64;
        apply_body_elapsed(&mut b, t0, 2);
        // 深夜离开 8 小时 → 该睡了一觉，醒来精神+饿
        let note = apply_body_elapsed(&mut b, t0 + 8 * 3_600_000, 3);
        assert!(note.unwrap().contains("睡了一觉"));
        assert!(b.sleepiness < 0.3, "睡醒了就不困了：{}", b.sleepiness);
        assert!(b.stamina > 0.8);
        assert!(!b.asleep);
    }

    #[test]
    fn body_rejects_absurd_elapsed() {
        let mut b = Body::default();
        let t0 = 1_000_000_000u64;
        apply_body_elapsed(&mut b, t0, 12);
        // 关机一周：最多只补 24 小时，不能算成"困了几百小时"
        apply_body_elapsed(&mut b, t0 + 7 * 24 * 3_600_000, 12);
        assert!(b.sleepiness <= 1.0 && b.hunger <= 1.0);
        assert!(b.stamina >= 0.0);
    }

    #[test]
    fn body_reacts_to_a_turn() {
        let mut b = Body::default();
        b.warmth = 0.2;
        b.heart_rate = 70;
        apply_body_turn(&mut b, &sig(0.8, 0.9, 0.8), 0.9, 1_000);
        assert!(b.warmth > 0.2, "被搭理会暖一点");
        assert!(b.heart_rate > 80, "激动时心跳该起来：{}", b.heart_rate);
        assert!(b.breath > 0.3);
        assert!(!b.asleep, "说话就醒了");
    }

    #[test]
    fn body_language_picks_the_loudest_signal() {
        let mut b = Body::default();
        b.sleepiness = 0.9;
        assert!(body_language(&b, "平静").contains("眼皮"));
        let mut b2 = Body::default();
        b2.asleep = true;
        assert!(body_language(&b2, "雀跃").contains("睡着"), "睡着优先于一切");
        let mut b3 = Body::default();
        b3.hunger = 0.9;
        assert!(body_language(&b3, "平静").contains("肚子"));
        let b4 = Body::default();
        assert!(body_language(&b4, "雀跃").contains("尾巴摇得飞快"));
        let b5 = Body::default();
        assert!(body_language(&b5, "低落").contains("耷拉"));
    }

    // ── 用户状态 ──────────────────────────────────────────────────

    #[test]
    fn busy_text_reads_busy() {
        let s = sense_user("我在开会，等会儿再说", 15, 3);
        assert!(s.busy, "{s:?}");
        assert!(s.energy < 0.5, "在忙说明精力被占着：{}", s.energy);
        assert!(s.engagement < 0.5, "这种话不该算高投入");
    }

    #[test]
    fn tired_text_reads_tired() {
        let s = sense_user("今天好累，想睡了", 1, 30);
        assert!(s.tired);
        assert!(s.energy < 0.4);
    }

    #[test]
    fn late_night_lowers_energy_even_without_cues() {
        let day = sense_user("帮我看看这段代码写了什么，我有点搞不清楚这个逻辑", 15, 10);
        let night = sense_user("帮我看看这段代码写了什么，我有点搞不清楚这个逻辑", 3, 10);
        assert!(night.energy < day.energy, "同样的话，凌晨说就是更累：{} vs {}", day.energy, night.energy);
    }

    #[test]
    fn long_engaged_message_raises_engagement() {
        let short = sense_user("嗯", 15, 5);
        let long = sense_user(
            "我想把这个状态层做成能长期跑的东西，你觉得身体层该不该跟心情联动？要不要做成可开关的？",
            15,
            5,
        );
        assert!(long.engagement > short.engagement, "{} vs {}", long.engagement, short.engagement);
        assert!(short.engagement <= 0.2, "一个『嗯』就是低投入：{}", short.engagement);
    }

    #[test]
    fn user_mood_labels_cover_the_cases() {
        assert_eq!(user_mood_label(0.8, 0.8, 0.8, false), "兴致很高");
        assert_eq!(user_mood_label(0.0, 0.2, 0.2, false), "疲惫");
        assert_eq!(user_mood_label(0.0, 0.2, 0.8, true), "在忙");
        assert_eq!(user_mood_label(-0.8, 0.9, 0.8, false), "有点炸");
        assert_eq!(user_mood_label(0.1, 0.2, 0.8, false), "平静");
    }

    #[test]
    fn user_state_moves_gradually_and_remembers_history() {
        let mut u = UserState::default();
        let e0 = u.energy;
        let sig_ok = sense_user("今天挺好的，谢谢你陪我聊这些，感觉轻松多了", 15, 0);
        apply_user_turn(&mut u, &sig_ok, 1_000_000, 15);
        assert_eq!(u.turns, 1);
        assert_eq!(u.streak, 1);
        assert!(u.energy > e0, "这么说话不算累：{} → {}", e0, u.energy);
        assert_eq!(u.last_len, sig_ok.len);
        assert!(u.avg_len > 0.0);
        assert_eq!(u.samples.len(), 1);
        // 紧接着又一条 → streak 累加
        apply_user_turn(&mut u, &sig_ok, 1_060_000, 15);
        assert_eq!(u.streak, 2);
    }

    #[test]
    fn user_advice_prioritises_busy_over_everything() {
        let mut u = UserState::default();
        u.busy = true;
        u.tired = true;
        u.energy = 0.1;
        u.last_hour = 3;
        assert!(user_advice(&u).contains("在忙"), "在忙优先级最高");
        u.busy = false;
        assert!(user_advice(&u).contains("累"));
        u.tired = false;
        u.energy = 0.8;
        assert!(user_advice(&u).contains("深夜"));
        u.last_hour = 15;
        assert_eq!(user_advice(&u), "", "状态正常就别硬给建议");
    }

    #[test]
    fn user_line_carries_advice_and_flags() {
        let mut u = UserState::default();
        u.mood = "疲惫".into();
        u.energy = 0.2;
        u.tired = true;
        u.streak = 4;
        let line = render_user_line(&u);
        assert!(line.starts_with("对方：主人疲惫"), "{line}");
        assert!(line.contains("精力 20%"));
        assert!(line.contains("累/困"));
        assert!(line.contains("连着说了 4 条"));
        assert!(line.contains("少说两句"), "得把该怎么做也写进去：{line}");
    }

    #[test]
    fn state_block_merges_body_and_user() {
        let mut s = CharState::default();
        s.character_id = "dsh-luna".into();
        s.mood = "雀跃".into();
        let mut u = UserState::default();
        u.mood = "在忙".into();
        u.busy = true;
        let block = render_state_block(&s, Some(&s.body), Some(&u), 1_000_000_000_000, false);
        assert!(block.contains("身体："), "{block}");
        assert!(block.contains("对方：主人在忙"), "{block}");
        // 关掉身体/对方时不该出现那两行
        let only_char = render_state_block(&s, None, None, 1_000_000_000_000, false);
        assert!(!only_char.contains("身体："));
        assert!(!only_char.contains("对方："));
    }

    // ── 关系里程碑 ────────────────────────────────────────────────

    #[test]
    fn first_turn_unlocks_first_milestone() {
        let mut s = CharState::default();
        s.character_id = "dsh-luna".into();
        let now = 1_000_000_000_000u64;
        let got = detect_milestones(&mut s, &sig(0.0, 0.0, 0.0), now, false);
        assert!(got.iter().any(|t| t.contains("第一次说话")), "{got:?}");
        assert_eq!(s.first_seen_at, now);
        // 第二轮不该重复解锁
        let got2 = detect_milestones(&mut s, &sig(0.0, 0.0, 0.0), now + 1000, false);
        assert!(!got2.iter().any(|t| t.contains("第一次说话")), "{got2:?}");
    }

    #[test]
    fn days_together_counts_the_first_day_as_one() {
        let mut s = CharState::default();
        let t0 = 1_000_000_000_000u64;
        s.first_seen_at = t0;
        assert_eq!(days_together(&s, t0), 1, "当天算第 1 天");
        assert_eq!(days_together(&s, t0 + 86_400_000), 2);
        assert_eq!(days_together(&s, t0 + 6 * 86_400_000), 7);
        // 时钟倒退也不能算出 0 或负数
        assert_eq!(days_together(&s, t0 - 999), 0);
    }

    #[test]
    fn milestones_unlock_by_turns_and_affinity() {
        let mut s = CharState::default();
        s.character_id = "l".into();
        s.first_seen_at = 1;
        s.turns = 100;
        s.affinity = 70;
        let got = detect_milestones(&mut s, &sig(0.0, 0.0, 0.0), 1_000_000_000_000, true);
        assert!(got.iter().any(|t| t.contains("聊满 100 轮")), "{got:?}");
        assert!(got.iter().any(|t| t.contains("好感度到 70")), "{got:?}");
        assert!(got.iter().any(|t| t.contains("主人")), "亲昵称呼要记一笔：{got:?}");
        // 一次性把跨过的都记上（不是只记最后一个）
        assert!(got.iter().any(|t| t.contains("聊满 50 轮")), "{got:?}");
        assert!(got.iter().any(|t| t.contains("好感度到 50")), "{got:?}");
    }

    #[test]
    fn milestone_list_does_not_grow_forever() {
        let mut s = CharState::default();
        for i in 0..80 {
            s.milestones.push(Milestone {
                id: format!("x{i}"),
                at: 1,
                title: format!("事件{i}"),
                note: String::new(),
                auto: true,
            });
        }
        s.turns = 100;
        detect_milestones(&mut s, &sig(0.0, 0.0, 0.0), 1_000_000_000_000, false);
        assert!(s.milestones.len() <= 60, "{}", s.milestones.len());
    }

    #[test]
    fn milestone_line_is_short_and_meaningful() {
        let mut s = CharState::default();
        s.character_id = "l".into();
        s.first_seen_at = 1_000_000_000_000;
        s.turns = 37;
        s.milestones.push(Milestone {
            id: "a".into(),
            at: 1,
            title: "第一次说话".into(),
            note: String::new(),
            auto: true,
        });
        let line = render_milestone_line(&s, 1_000_000_000_000);
        assert!(line.starts_with("你俩：第 1 天"), "{line}");
        assert!(line.contains("聊了 37 轮"));
        assert!(line.contains("里程碑 1 条"));
        // 啥都没有时不占 token
        assert_eq!(render_milestone_line(&CharState::default(), 1), "");
    }

    #[test]
    fn anchor_block_repeats_addendum_and_milestones() {
        let mut s = CharState::default();
        s.character_id = "l".into();
        s.mood = "雀跃".into();
        s.addendum = "- [2026-09-30] 说话别太端着".into();
        s.milestones.push(Milestone {
            id: "a".into(),
            at: 1,
            title: "认识第 7 天".into(),
            note: String::new(),
            auto: true,
        });
        let b = render_anchor_block(&s, "露娜", "", &s.addendum);
        assert!(b.contains("她自己补充的设定"), "{b}");
        assert!(b.contains("说话别太端着"));
        assert!(b.contains("你俩的里程碑：认识第 7 天"), "{b}");
    }

    #[test]
    fn user_state_json_roundtrip_and_tolerance() {
        let mut u = UserState::default();
        u.mood = "疲惫".into();
        u.energy = 0.3;
        apply_user_turn(&mut u, &sense_user("好累啊", 2, 60), 1_000_000, 2);
        let text = serde_json::to_string_pretty(&u).unwrap();
        let back: UserState = serde_json::from_str(&text).unwrap();
        assert_eq!(back.mood, u.mood);
        assert_eq!(back.turns, 1);
        // 老/手改文件缺字段也要能读
        let min: UserState = serde_json::from_str(r#"{"mood":"平静","energy":0.9}"#).unwrap();
        assert_eq!(min.energy, 0.9);
        assert_eq!(min.engagement, 0.5, "缺的用默认值补");
    }

    #[test]
    fn body_roundtrips_in_char_state() {
        let mut s = CharState::default();
        s.character_id = "dsh-luna".into();
        s.body.hunger = 0.77;
        s.body.heart_rate = 111;
        let text = serde_json::to_string_pretty(&s).unwrap();
        let back: CharState = serde_json::from_str(&text).unwrap();
        assert!((back.body.hunger - 0.77).abs() < 1e-6);
        assert_eq!(back.body.heart_rate, 111);
        // 老状态文件没有 body 字段 → 用默认值，不能整份失败
        let legacy: CharState = serde_json::from_str(r#"{"characterId":"luna","affinity":55}"#).unwrap();
        assert_eq!(legacy.affinity, 55);
        assert!(legacy.body.stamina > 0.0);
    }

    #[test]
    fn anchor_block_prefers_owner_anchors() {
        let mut s = CharState::default();
        s.character_id = "dsh-luna".into();
        s.anchors = vec!["叫主人「主人」".into()];
        let b = render_anchor_block(&s, "露娜模式", "我是露娜。\n第二行", "");
        assert!(b.contains("露娜模式"), "{b}");
        assert!(b.contains("叫主人「主人」"));
        assert!(!b.contains("第二行"), "有锚点时不该再塞人设首行");
    }

    #[test]
    fn anchor_block_falls_back_to_persona_first_line() {
        let s = CharState::default();
        let b = render_anchor_block(&s, "露娜模式", "# 标题\n\n我是魔界顶尖实习生，自称本小姐。\n后面还有", "");
        assert!(b.contains("我是魔界顶尖实习生"), "{b}");
        assert!(!b.contains("后面还有"), "只取第一句");
    }

    #[test]
    fn anchor_block_is_empty_without_anything() {
        let s = CharState::default();
        assert_eq!(render_anchor_block(&s, "", "", ""), "");
    }

    #[test]
    fn anchor_block_still_works_without_any_anchors() {
        // 主人没维护锚点、人设正文又全是标题：也必须有"你是谁 + 此刻状态"这一段
        let mut s = CharState::default();
        s.character_id = "dsh-luna".into();
        s.mood = "雀跃".into();
        s.affinity = 42;
        let b = render_anchor_block(&s, "露娜模式", "# 标题\n## 二级标题\n", "");
        assert!(b.starts_with("【回锚】"), "{b}");
        assert!(b.contains("露娜模式"), "{b}");
        assert!(b.contains("此刻状态：雀跃 · 好感 42/100"), "{b}");
        assert!(!b.contains("核心设定与约定"), "没锚点就别硬编一栏：{b}");
    }

    #[test]
    fn proactive_line_varies_by_mood_and_hour() {
        let mut s = CharState::default();
        s.mood = "雀跃".into();
        let a = proactive_line(&s, 10);
        s.mood = "低落".into();
        let b = proactive_line(&s, 10);
        assert_ne!(a, b, "不同心情该说不同的话");
        assert!(a.contains("主人"), "人设口吻要带上称呼");
        assert!(proactive_line(&s, 23).contains("夜深"), "深夜要说夜话");
        assert!(proactive_line(&s, 7).contains("早呀"));
    }

    #[test]
    fn clip_chars_counts_chars_not_bytes() {
        assert_eq!(clip_chars("一二三四五", 3), "一二三…");
        assert_eq!(clip_chars("abc", 5), "abc");
    }

    // ── 模型感知（B 链路回传） ──────────────────────────────────────

    #[test]
    fn model_sense_moves_state_by_confidence() {
        let mut s = CharState::default();
        s.turns = 7;
        let m = ModelSense {
            valence: Some(1.0),
            arousal: Some(0.9),
            affinity_delta: Some(2.0),
            mood: "雀跃".into(),
            arc: "主人在做状态层".into(),
            anchors: vec!["叫主人「主人」".into()],
            confidence: Some(1.0),
            followup: None,
        };
        apply_model_sense(&mut s, &m, 1_000_000);
        assert!((s.valence - 1.0).abs() < 1e-6, "confidence=1 时直接采纳：{}", s.valence);
        assert_eq!(s.affinity, 32, "30 + 2");
        assert_eq!(s.mood, "雀跃");
        assert_eq!(s.arc, "主人在做状态层");
        assert_eq!(s.anchors.len(), 1);
        assert_eq!(s.last_sense_turn, 7, "门控要看这个");
    }

    #[test]
    fn model_sense_is_conservative_at_low_confidence() {
        let mut s = CharState::default();
        s.valence = 0.0;
        let m = ModelSense {
            valence: Some(1.0),
            confidence: Some(0.1),
            ..Default::default()
        };
        apply_model_sense(&mut s, &m, 1);
        assert!(s.valence < 0.2, "低置信度只能轻轻推一下：{}", s.valence);
    }

    #[test]
    fn model_sense_cannot_jump_affinity() {
        let mut s = CharState::default();
        let m = ModelSense {
            affinity_delta: Some(999.0),
            confidence: Some(1.0),
            ..Default::default()
        };
        apply_model_sense(&mut s, &m, 1);
        assert_eq!(s.affinity, 35, "一次最多 +5：模型没资格一次加满");
        let m2 = ModelSense {
            affinity_delta: Some(-999.0),
            confidence: Some(1.0),
            ..Default::default()
        };
        apply_model_sense(&mut s, &m2, 2);
        assert_eq!(s.affinity, 30, "一次最多 -5");
    }

    #[test]
    fn model_sense_merges_anchors_without_dupes() {
        let mut s = CharState::default();
        s.anchors = vec!["甲".into()];
        let m = ModelSense {
            anchors: vec!["甲".into(), "乙".into(), "  ".into(), "乙".into()],
            ..Default::default()
        };
        apply_model_sense(&mut s, &m, 1);
        assert_eq!(s.anchors, vec!["甲".to_string(), "乙".to_string()]);
    }

    #[test]
    fn model_sense_tolerates_partial_json() {
        // 模型只回一半字段也要能用
        let m: ModelSense = serde_json::from_str(r#"{"mood":"平静"}"#).unwrap();
        assert!(m.valence.is_none());
        assert_eq!(m.mood, "平静");
        let mut s = CharState::default();
        s.valence = 0.4;
        apply_model_sense(&mut s, &m, 1);
        assert!((s.valence - 0.4).abs() < 1e-6, "没给就不该动");
        assert_eq!(s.mood, "平静");
    }

    // ── 两道额度闸 ────────────────────────────────────────────────

    #[test]
    fn sense_budget_resets_daily_and_caps() {
        let mut s = CharState::default();
        assert!(sense_budget_ok(&mut s, "2026-09-30", 2));
        assert!(sense_budget_ok(&mut s, "2026-09-30", 2));
        assert!(!sense_budget_ok(&mut s, "2026-09-30", 2), "当日额度用完就该拦住");
        assert_eq!(s.sense_count, 2);
        // 换一天自动归零
        assert!(sense_budget_ok(&mut s, "2026-10-01", 2));
        assert_eq!(s.sense_count, 1);
        // cap=0 表示不限
        for _ in 0..50 {
            assert!(sense_budget_ok(&mut s, "2026-10-01", 0));
        }
        // 空日期不认（宁可不花钱也别记错账）
        assert!(!sense_budget_ok(&mut s, "", 5));
    }

    #[test]
    fn proactive_budget_is_separate_from_sense() {
        let mut s = CharState::default();
        assert!(sense_budget_ok(&mut s, "2026-09-30", 1));
        assert!(!sense_budget_ok(&mut s, "2026-09-30", 1));
        // 感知用完了不该影响主动
        assert!(proactive_budget_ok(&mut s, "2026-09-30", 1));
        assert!(!proactive_budget_ok(&mut s, "2026-09-30", 1));
    }

    // ── 门控：值不值得花额度 ──────────────────────────────────────

    #[test]
    fn gate_keeps_off_and_local_from_spending() {
        let mut s = CharState::default();
        s.turns = 99;
        let hot = sig(1.0, 1.0, 1.0);
        assert!(!want_model_sense("off", 5, &s, &hot), "关着就绝不花钱");
        assert!(!want_model_sense("local", 5, &s, &hot), "本地模式也不花钱");
    }

    #[test]
    fn gate_needs_enough_turns() {
        let mut s = CharState::default();
        s.turns = 3;
        s.last_sense_turn = 0;
        let flat = sig(0.0, 0.0, 0.0);
        assert!(!want_model_sense("model", 12, &s, &flat), "中性句没到间隔就不问");
        s.turns = 12;
        assert!(
            want_model_sense("model", 12, &s, &flat),
            "到点必问 —— 哪怕本地看不出情绪（本地看得出的那些本来就有信号了）"
        );
    }

    /// 情绪很冲的时候可以提前问，但**绝不连续两轮都问**
    #[test]
    fn hot_signal_can_ask_early_but_not_every_turn() {
        let mut s = CharState::default();
        s.turns = 2;
        s.last_sense_turn = 0;
        let hot = sig(1.0, 1.0, 1.0);
        assert!(want_model_sense("model", 12, &s, &hot), "情绪很冲不必等满间隔");
        s.last_sense_turn = 2;
        assert!(!want_model_sense("model", 12, &s, &hot), "刚问过就必须等下一轮");
    }

    /// 【本次修复的核心】本地看不出情绪的轮次**也要问**
    ///
    /// 原来这道门还要求 `intensity >= 0.25`（或攒到两倍间隔兜底），等于**永远不问**：
    /// 真实对话绝大多数是中性句，模型感知再也拿不到新语境，状态就卡死在 v=0.00
    /// （实测日志 turn=46/47/48 三行一字不差）。
    #[test]
    fn gate_asks_even_without_local_signal() {
        let mut s = CharState::default();
        s.last_sense_turn = 0;
        let flat = sig(0.0, 0.0, 0.0);
        s.turns = 4;
        assert!(want_model_sense("model", 4, &s, &flat), "中性句到点也必须问模型");
    }

    #[test]
    fn gate_resets_after_a_sense() {
        let mut s = CharState::default();
        s.turns = 24;
        s.last_sense_turn = 24;
        let hot = sig(1.0, 1.0, 1.0);
        assert!(!want_model_sense("model", 12, &s, &hot), "刚看过就再等一轮间隔");
        s.turns = 36;
        assert!(want_model_sense("model", 12, &s, &hot));
    }

    #[test]
    fn self_review_gate_only_fires_in_auto_mode() {
        let mut s = CharState::default();
        s.turns = 100;
        assert!(!want_self_review("off", 10, &s));
        assert!(!want_self_review("manual", 10, &s), "手动模式只能由主人点，不该自己跑");
        assert!(want_self_review("auto", 10, &s));
        s.last_review_turn = 95;
        assert!(!want_self_review("auto", 10, &s), "刚反思过就再等等");
        assert!(!want_self_review("auto", 0, &s), "every=0 退回默认 30：5 < 30");
    }

    #[test]
    fn gate_treats_zero_every_as_default() {
        let mut s = CharState::default();
        s.turns = 3;
        s.last_sense_turn = 0;
        let flat = sig(0.0, 0.0, 0.0);
        assert!(
            !want_model_sense("model", 0, &s, &flat),
            "every=0 要退回默认 4，才 3 轮不该问"
        );
        s.turns = 4;
        assert!(want_model_sense("model", 0, &s, &flat), "满默认间隔就该问");
    }
}
