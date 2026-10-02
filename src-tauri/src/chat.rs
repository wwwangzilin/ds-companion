//! 对话留档：每一轮落成按天分的 Markdown。
//!
//! 为什么必须落盘（三个需求其实都要它）：
//!   ① 页面里的 transcript 只活在内存、最多 12 轮 —— 刷新一下"没有可整理的对话"
//!   ② 记忆条目要能溯源：这条是从哪天哪段话里抽出来的
//!   ③ **自我修订**要有"最近的对话"可读 —— 她反思自己，凭的就是这个
//!
//! 落点：%APPDATA%\ds-companion\chats\YYYY-MM-DD.md
//! 格式刻意做成人类可读的聊天记录（也方便丢进 git / 自己翻）：
//!
//! ```text
//! # 2026-09-30
//!
//! ## 21:03 · 露娜模式 · a1b2c3d4
//! **主人**：今天想喝冰美式
//! **露娜**：喵~ 记下了，不加糖对吧
//! ```
//!
//! 【时间从页面传】Rust 这边不引 chrono，本地日期/时分由页面给 ——
//! 时区这种事只有浏览器最清楚。

use std::fs;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use crate::personas::app_root;
use crate::state::clip_chars;

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct Turn {
    /// 毫秒时间戳
    pub at: u64,
    /// 本地日期 YYYY-MM-DD（页面给）
    pub day: String,
    /// 本地时分 HH:MM（页面给）
    pub clock: String,
    /// 角色名（展示用）
    pub character: String,
    pub character_id: String,
    pub session: String,
    pub user: String,
    pub assistant: String,
}

pub fn chat_dir() -> PathBuf {
    app_root().join("chats")
}

pub fn ensure_dir() -> std::io::Result<()> {
    fs::create_dir_all(chat_dir())
}

fn day_path(day: &str) -> PathBuf {
    chat_dir().join(format!("{}.md", safe_day(day)))
}

/// 日期只允许数字和短横线 —— 文件名是拼出来的，不能让别人塞路径进来
pub fn safe_day(day: &str) -> String {
    let cleaned: String = day
        .chars()
        .filter(|c| c.is_ascii_digit() || *c == '-')
        .take(10)
        .collect();
    if cleaned.len() == 10 {
        cleaned
    } else {
        "unknown".to_string()
    }
}

pub fn render_block(t: &Turn) -> String {
    format!(
        "## {} · {} · {}\n**主人**：{}\n**{}**：{}\n",
        if t.clock.trim().is_empty() { "--:--" } else { t.clock.trim() },
        if t.character.trim().is_empty() { "角色" } else { t.character.trim() },
        clip_chars(&t.session, 12),
        t.user.trim(),
        if t.character.trim().is_empty() { "她" } else { t.character.trim() },
        t.assistant.trim()
    )
}

/// 追加一轮。文件不存在就带上 `# 日期` 头。
pub fn append_turn(t: &Turn) -> Result<(), String> {
    ensure_dir().map_err(|e| e.to_string())?;
    let path = day_path(&t.day);
    let fresh = !path.exists();
    let mut text = String::new();
    if fresh {
        text.push_str(&format!("# {}\n\n", safe_day(&t.day)));
    }
    text.push_str(&render_block(t));
    use std::io::Write;
    let mut f = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| e.to_string())?;
    f.write_all(text.as_bytes()).map_err(|e| e.to_string())
}

/// 解析一天的记录（纯函数，能单测）。
pub fn parse_day(text: &str) -> Vec<Turn> {
    let mut out: Vec<Turn> = Vec::new();
    let mut cur: Option<Turn> = None;
    for line in text.lines() {
        if let Some(rest) = line.strip_prefix("## ") {
            if let Some(t) = cur.take() {
                out.push(t);
            }
            // "21:03 · 露娜模式 · a1b2c3d4"
            let parts: Vec<&str> = rest.split('·').map(|s| s.trim()).collect();
            let mut t = Turn::default();
            if let Some(c) = parts.first() {
                t.clock = (*c).to_string();
            }
            if let Some(c) = parts.get(1) {
                t.character = (*c).to_string();
            }
            if let Some(c) = parts.get(2) {
                t.session = (*c).to_string();
            }
            cur = Some(t);
            continue;
        }
        let Some(t) = cur.as_mut() else { continue };
        if let Some(rest) = line.strip_prefix("**主人**：") {
            t.user = rest.trim().to_string();
        } else if let Some(idx) = line.find("**：") {
            // **<角色名>**：...
            if line.starts_with("**") {
                let _ = idx;
                if let Some(rest) = line.splitn(2, "**：").nth(1) {
                    t.assistant = rest.trim().to_string();
                }
            }
        }
    }
    if let Some(t) = cur.take() {
        out.push(t);
    }
    out
}

/// 有记录的日子，新的在前
pub fn days() -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let Ok(entries) = fs::read_dir(chat_dir()) else {
        return out;
    };
    for e in entries.flatten() {
        let p = e.path();
        if p.extension().and_then(|x| x.to_str()) != Some("md") {
            continue;
        }
        if let Some(stem) = p.file_stem().and_then(|x| x.to_str()) {
            out.push(stem.to_string());
        }
    }
    out.sort();
    out.reverse();
    out
}

pub fn read_day(day: &str) -> Vec<Turn> {
    fs::read_to_string(day_path(day))
        .map(|t| parse_day(&t))
        .unwrap_or_default()
}

/// 最近若干轮（从最新的日子往回凑）。自我反思与"刷新后仍能整理"都靠它。
pub fn recent(limit: usize) -> Vec<Turn> {
    let mut acc: Vec<Turn> = Vec::new();
    for d in days() {
        let mut turns = read_day(&d);
        // 日子是从新往旧读的：把这一天的接在前面
        turns.extend(acc);
        acc = turns;
        if acc.len() >= limit {
            break;
        }
    }
    if acc.len() > limit {
        let drop = acc.len() - limit;
        acc.drain(0..drop);
    }
    acc
}

/// 渲染成给模型看的一段对话（自我反思 / 整理都用同一个格式）
pub fn render_for_model(turns: &[Turn], user_clip: usize, assist_clip: usize) -> String {
    let mut parts: Vec<String> = Vec::new();
    for t in turns {
        parts.push(format!(
            "主人：{}\n{}：{}",
            clip_chars(&t.user, user_clip),
            if t.character.trim().is_empty() { "她" } else { t.character.trim() },
            clip_chars(&t.assistant, assist_clip)
        ));
    }
    parts.join("\n\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn turn(clock: &str, user: &str, assistant: &str) -> Turn {
        Turn {
            at: 1,
            day: "2026-09-30".into(),
            clock: clock.into(),
            character: "露娜模式".into(),
            character_id: "dsh-luna".into(),
            session: "a1b2c3d4".into(),
            user: user.into(),
            assistant: assistant.into(),
        }
    }

    #[test]
    fn day_filename_is_sanitised() {
        assert_eq!(safe_day("2026-09-30"), "2026-09-30");
        assert_eq!(safe_day("../../etc/passwd"), "unknown", "不许拼路径出去");
        assert_eq!(safe_day("2026/09/30"), "unknown");
        assert_eq!(safe_day(""), "unknown");
    }

    #[test]
    fn block_renders_speakers() {
        let b = render_block(&turn("21:03", "今天想喝冰美式", "喵~ 不加糖对吧"));
        assert!(b.starts_with("## 21:03 · 露娜模式 · a1b2c3d4"));
        assert!(b.contains("**主人**：今天想喝冰美式"));
        assert!(b.contains("**露娜模式**：喵~ 不加糖对吧"));
    }

    #[test]
    fn parse_roundtrips_what_render_writes() {
        let t1 = turn("21:03", "今天想喝冰美式", "喵~ 不加糖对吧");
        let t2 = turn("21:07", "晚上还要加班", "别太拼了");
        let text = format!(
            "# 2026-09-30\n\n{}{}",
            render_block(&t1),
            render_block(&t2)
        );
        let back = parse_day(&text);
        assert_eq!(back.len(), 2);
        assert_eq!(back[0].clock, "21:03");
        assert_eq!(back[0].character, "露娜模式");
        assert_eq!(back[0].session, "a1b2c3d4");
        assert_eq!(back[0].user, "今天想喝冰美式");
        assert_eq!(back[0].assistant, "喵~ 不加糖对吧");
        assert_eq!(back[1].user, "晚上还要加班");
        assert_eq!(back[1].assistant, "别太拼了");
    }

    #[test]
    fn parse_tolerates_other_character_names() {
        let text = "## 09:10 · 三千代 · s1\n**主人**：早\n**三千代**：早呀\n";
        let back = parse_day(text);
        assert_eq!(back.len(), 1);
        assert_eq!(back[0].assistant, "早呀");
    }

    #[test]
    fn parse_ignores_garbage_lines() {
        let text = "# 2026-09-30\n\n随便写点什么\n## 10:00 · 露娜 · s\n**主人**：a\n**露娜**：b\n乱七八糟\n";
        let back = parse_day(text);
        assert_eq!(back.len(), 1);
        assert_eq!(back[0].assistant, "b");
    }

    #[test]
    fn model_view_carries_both_sides() {
        let turns = vec![turn("21:03", "想问个事", "你说")];
        let s = render_for_model(&turns, 100, 100);
        assert!(s.contains("主人：想问个事"));
        assert!(s.contains("露娜模式：你说"));
    }

    #[test]
    fn model_view_clips_long_sides() {
        let long = "字".repeat(500);
        let turns = vec![turn("21:03", &long, &long)];
        let s = render_for_model(&turns, 20, 20);
        assert!(s.len() < 200, "要截断，不然反思的 prompt 会爆：{}", s.len());
    }
}
