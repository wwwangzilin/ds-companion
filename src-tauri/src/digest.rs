//! 「她今天怎么样」：把散在几个文件里的"今天"拼成一段人话。
//!
//! 【为什么值得单独一层】她的状态、聊天留档、记忆、工具额度本来就各躺各的 ——
//! 想知道"今天怎么样"，主人得挨个页面翻。日报做的事就是**把这一天合成一句话**。
//!
//! 【"今天"是哪一天，绝对不要自己算】`std` 只给 UTC，而本机是 UTC+8 ——
//! 壳自己算会在每天下午 4 点前把"今天"算成昨天。所以日期一律取**页面报来的**那个：
//! chat 留档的 `day`、`state` 的 `sense_day` / `proactive_day` / `review_day`、
//! 工具额度记的 day（见 `tools::quota_used_today`）。它们才是同一个时区里的"今天"。
//!
//! 【为什么把"该说的话"做成纯函数】日报的价值全在**措辞**：她饿着要提"可以喂她一顿"、
//! 前天主动过不能算成今天。这些判断放在纯函数里才能一条条测（真机上这些数字天天在变，
//! 靠手测根本覆盖不到）。

use serde::Serialize;

use crate::state::CharState;

/// 日报里的一张数字卡
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Stat {
    pub key: String,
    pub label: String,
    pub value: String,
    /// 补充说明（界面上的小字），可以是空的
    pub hint: String,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Digest {
    pub day: String,
    pub name: String,
    /// 一句话头条（托盘 tooltip / 页面标题都用它）
    pub headline: String,
    /// 人话要点，每行一句
    pub lines: Vec<String>,
    pub stats: Vec<Stat>,
}

/// build 需要的外部事实。都在命令层读好再传进来 —— 这样 build 是纯函数，测起来不用碰盘。
pub struct Extras {
    /// 今天聊了几轮（来自聊天留档，那是页面按本地日期写的）
    pub turns_today: usize,
    /// 今天用了几次工具（调用方已经按 day 对齐过）
    pub tool_used: u32,
    pub tool_cap: u32,
    pub mem_total: usize,
    pub mem_own: usize,
    pub now_ms: u64,
}

fn stat(key: &str, label: &str, value: String, hint: String) -> Stat {
    Stat {
        key: key.to_string(),
        label: label.to_string(),
        value,
        hint,
    }
}

/// 认识第几天（从第一次说话算起）。
///
/// 没有时间戳（老状态文件）或者时间倒流时，一律算第 1 天 —— 悄悄给个大数字
/// 比"显示不出来"更糟。
fn days_together(first_seen_at: u64, now: u64) -> u64 {
    if first_seen_at == 0 || now <= first_seen_at {
        return 1;
    }
    (now - first_seen_at) / 86_400_000 + 1
}

/// `YYYY-MM-DD` 形状检查。**候选日期里混进空串/垃圾时必须能识别出来** ——
/// 那几个 `*_day` 字段在没跑过对应功能时就是空的，直接 `max()` 会把空串当最大。
fn looks_like_day(s: &str) -> bool {
    let b = s.as_bytes();
    b.len() == 10
        && b[4] == b'-'
        && b[7] == b'-'
        && s.chars()
            .all(|c| c.is_ascii_digit() || c == '-')
        && s.chars().filter(|c| c.is_ascii_digit()).count() == 8
}

/// 从几个候选里挑"最近的一天"。
///
/// `YYYY-MM-DD` 的字典序就是时间序，所以直接比字符串 —— 不需要解析日期，也就不会
/// 因为时区/闰月之类的事算错。全都不是日期时返回空串（调用方据此说"还没有记录"）。
pub fn latest_day(cands: &[&str]) -> String {
    cands
        .iter()
        .map(|s| s.trim())
        .filter(|s| looks_like_day(s))
        .max()
        .unwrap_or("")
        .to_string()
}

pub fn build(day: &str, name: &str, st: &CharState, x: &Extras) -> Digest {
    let mood = {
        let m = st.mood.trim();
        if m.is_empty() {
            "—".to_string()
        } else {
            m.to_string()
        }
    };
    let hunger = st.body.hunger;
    let energy = st.energy;
    let days = days_together(st.first_seen_at, x.now_ms);

    // 三个计数器只在 *_day 与 day 一致时才算数 —— 否则会把"前天主动过 2 次"当今天的。
    // 这三个日期字段本来就是为这件事存的（当初就是为了防"跨天不清零"或"乱清"）。
    let proactive = if st.proactive_day == day { st.proactive_count } else { 0 };
    let sense = if st.sense_day == day { st.sense_count } else { 0 };
    let review = if st.review_day == day { st.review_count } else { 0 };

    let headline = if x.turns_today == 0 {
        format!(
            "{name}：今天还没说上话（心情 {mood}，好感 {}/100）",
            st.affinity
        )
    } else {
        format!(
            "{name}：今天聊了 {} 轮，心情 {mood}，好感 {}/100",
            x.turns_today, st.affinity
        )
    };

    let mut lines: Vec<String> = Vec::new();
    if x.turns_today == 0 {
        lines.push("今天还没聊过 —— 她一个人在后台待着（身体层照旧在走）。".into());
    } else {
        lines.push(format!("陪主人聊了 {} 轮。", x.turns_today));
    }
    lines.push(format!("心情「{mood}」，好感 {}/100。", st.affinity));
    if hunger >= 0.7 {
        lines.push(format!(
            "有点饿（饿 {:.0}%）—— 可以喂她一顿。",
            hunger * 100.0
        ));
    } else {
        lines.push(format!(
            "不饿（{:.0}%），精力 {:.0}%。",
            hunger * 100.0,
            energy * 100.0
        ));
    }
    let mut acts: Vec<String> = Vec::new();
    if proactive > 0 {
        acts.push(format!("主动开口 {proactive} 次"));
    }
    if sense > 0 {
        acts.push(format!("让模型感知情绪 {sense} 次"));
    }
    if review > 0 {
        acts.push(format!("自我反思 {review} 次"));
    }
    if x.tool_used > 0 {
        acts.push(format!("动手干活 {} 次", x.tool_used));
    }
    if !acts.is_empty() {
        lines.push(format!("今天她{}。", acts.join("、")));
    }
    lines.push(format!(
        "认识第 {days} 天（记忆库里 {} 条，其中 {} 条是她的）。",
        x.mem_total, x.mem_own
    ));
    if let Some(m) = st.milestones.last() {
        if !m.title.trim().is_empty() {
            lines.push(format!("最近一个里程碑：{}", m.title.trim()));
        }
    }

    let stats = vec![
        stat(
            "turns",
            "今天聊了",
            format!("{} 轮", x.turns_today),
            String::new(),
        ),
        stat("mood", "心情", mood, format!("好感 {}/100", st.affinity)),
        stat(
            "hunger",
            "饿",
            format!("{:.0}%", hunger * 100.0),
            if hunger >= 0.7 { "该喂了" } else { "" }.to_string(),
        ),
        stat("energy", "精力", format!("{:.0}%", energy * 100.0), String::new()),
        stat(
            "tools",
            "工具",
            format!("{}/{}", x.tool_used, x.tool_cap),
            String::new(),
        ),
        stat(
            "memory",
            "记忆",
            format!("{} 条", x.mem_own),
            format!("库里共 {}", x.mem_total),
        ),
        stat("days", "认识", format!("第 {days} 天"), String::new()),
    ];

    Digest {
        day: day.to_string(),
        name: name.to_string(),
        headline,
        lines,
        stats,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::state::{CharState, Milestone};

    fn st_ok() -> CharState {
        let mut st = CharState::default();
        st.character_id = "dsh-luna".into();
        st.mood = "有点得意".into();
        st.affinity = 81;
        st.energy = 0.65;
        st.body.hunger = 0.3;
        // 认识 10 天前
        st.first_seen_at = 10 * 86_400_000;
        st
    }

    fn extras(turns: usize, used: u32) -> Extras {
        Extras {
            turns_today: turns,
            tool_used: used,
            tool_cap: 20,
            mem_total: 40,
            mem_own: 12,
            // first_seen_at 是 10 天前、现在是 20 天那个点 —— 差 10 天 → "第 11 天"
            now_ms: 20 * 86_400_000,
        }
    }

    #[test]
    fn digest_talks_about_today() {
        let d = build("2026-10-01", "露娜", &st_ok(), &extras(18, 3));
        assert!(d.headline.contains("今天聊了 18 轮"), "{}", d.headline);
        assert!(d.headline.contains("露娜"), "{}", d.headline);
        assert!(d.headline.contains("81/100"), "{}", d.headline);
        let all = d.lines.join("\n");
        assert!(all.contains("陪主人聊了 18 轮"), "{all}");
        assert!(all.contains("有点得意"), "{all}");
        assert!(all.contains("动手干活 3 次"), "{all}");
        assert!(all.contains("第 11 天"), "认识天数要从 first_seen_at 算：{all}");
        // 数字卡片要齐
        assert_eq!(d.stats.len(), 7, "{:?}", d.stats);
        assert!(d.stats.iter().any(|s| s.key == "tools" && s.value == "3/20"));
    }

    /// 今天还没聊：措辞要变，但数字照给（不能报错、也不能空白）
    #[test]
    fn digest_handles_a_quiet_day() {
        let d = build("2026-10-01", "露娜", &st_ok(), &extras(0, 0));
        assert!(d.headline.contains("还没说上话"), "{}", d.headline);
        assert!(d.lines[0].contains("还没聊过"), "{:?}", d.lines);
        assert!(
            !d.lines.join("\n").contains("动手干活"),
            "没干活就别提：{:?}",
            d.lines
        );
    }

    /// 饿着的时候要主动说"可以喂她一顿"（这正是主人当天想做的那件事）
    #[test]
    fn digest_nags_when_hungry() {
        let mut st = st_ok();
        st.body.hunger = 0.92;
        let d = build("2026-10-01", "露娜", &st, &extras(5, 0));
        assert!(d.lines.join("\n").contains("可以喂她一顿"), "{:?}", d.lines);
        let h = d.stats.iter().find(|s| s.key == "hunger").unwrap();
        assert_eq!(h.value, "92%");
        assert_eq!(h.hint, "该喂了");
    }

    /// 跨天的计数器不能被算成今天的 —— 这是 `*_day` 字段存在的唯一理由
    #[test]
    fn digest_ignores_yesterdays_counters() {
        let mut st = st_ok();
        st.proactive_day = "2026-09-30".into();
        st.proactive_count = 3;
        st.sense_day = "2026-09-30".into();
        st.sense_count = 9;
        st.review_day = "2026-10-01".into();
        st.review_count = 1;
        let d = build("2026-10-01", "露娜", &st, &extras(5, 0));
        let all = d.lines.join("\n");
        assert!(!all.contains("主动开口"), "前天的不能算今天：{all}");
        assert!(!all.contains("感知情绪"), "前天的不能算今天：{all}");
        assert!(all.contains("自我反思 1 次"), "今天的要算：{all}");
    }

    /// 里程碑与"心情空着"这两处容易出丑的地方
    #[test]
    fn digest_shows_milestone_and_survives_empty_mood() {
        let mut st = st_ok();
        st.mood = "  ".into();
        st.milestones.push(Milestone {
            id: "m1".into(),
            at: 1,
            title: "第一次一起把工具跑通".into(),
            note: String::new(),
            auto: true,
        });
        let d = build("2026-10-01", "露娜", &st, &extras(3, 0));
        let all = d.lines.join("\n");
        assert!(all.contains("第一次一起把工具跑通"), "{all}");
        assert!(d.headline.contains('—'), "心情空着要显示占位符：{}", d.headline);

        // 空标题的里程碑不该冒出来
        st.milestones.push(Milestone::default());
        let d2 = build("2026-10-01", "露娜", &st, &extras(3, 0));
        assert!(
            !d2.lines.join("\n").contains("里程碑：\n"),
            "{:?}",
            d2.lines
        );
    }

    /// 挑"最近的一天"：混进空串/垃圾时不能被当成日期
    #[test]
    fn latest_day_skips_junk() {
        assert_eq!(latest_day(&["", "  ", "2026-09-30", "2026-10-01"]), "2026-10-01");
        assert_eq!(latest_day(&["2026-09-30", "2026-09-30"]), "2026-09-30");
        assert_eq!(latest_day(&["", "not-a-day", "2026-1-1"]), "", "不像日期的一律不算");
        assert_eq!(latest_day(&[]), "");
        assert_eq!(latest_day(&["2026-10-01 "]), "2026-10-01", "两侧空白要能容忍");
    }

    #[test]
    fn days_together_is_sane() {
        assert_eq!(days_together(0, 999_999), 1, "没记过就是第 1 天");
        assert_eq!(days_together(1000, 500), 1, "时间倒流也不许给负数天");
        assert_eq!(days_together(1_000, 1_000), 1);
        assert_eq!(days_together(1_000, 1_000 + 86_400_000), 2);
    }
}
