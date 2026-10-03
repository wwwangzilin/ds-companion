//! 她自己的日记。
//!
//! 【为什么要它】日报（`digest.rs`）是**给主人看的客观摘要**：轮数、额度、心情均值。
//! 日记是**她**写的：第一人称、主观、只写她记得住的那一件事 —— 两者的区别就像
//! 「考勤表」和「日记本」。
//!
//! 【三条边界，都不许松】
//!   1. **一天一个 `.md`**（`diary/<角色 id>/YYYY-MM-DD.md`），主人随时能翻；
//!   2. **不进记忆库**：日记是她的私人物品。塞进检索既污染记忆，又会让「她写过的字」
//!      变成下一轮的事实来源 —— 越写越像在照镜子；
//!   3. **不注入回对话**：注入 = 每轮都多烧 token，而且她会开始为了被看见而表演写日记。
//!
//! 【谁决定写哪天】Rust 只负责「今天还没写过 → 把上一篇该写的那天和素材给页面」，
//! 实际那一段话由页面侧走隐藏链让模型写（见 `sense.js` 的 `__DSC_DIARY__`）。

use crate::state::DailyPoint;
use std::path::PathBuf;

/// 日记根目录（跟着数据目录走 —— `DSC_DATA_DIR` 隔离时自动隔离）
pub fn diary_root() -> PathBuf {
    crate::personas::app_root().join("diary")
}

/// 某个角色的日记目录
pub fn diary_dir(character_id: &str) -> PathBuf {
    let id = crate::personas::safe_id(character_id);
    let id = if id.is_empty() { "default".to_string() } else { id };
    diary_root().join(id)
}

/// 日期必须是 `YYYY-MM-DD` 形状。
///
/// 【为什么这条不能省】文件名是拿它拼出来的 —— 放一个 `../../evil` 过去，
/// 日记就写到数据目录外面了。宁可拒掉一个奇怪的日子，也不要路径穿越。
pub fn day_ok(day: &str) -> bool {
    let b = day.as_bytes();
    b.len() == 10
        && b[4] == b'-'
        && b[7] == b'-'
        && b.iter()
            .enumerate()
            .all(|(i, c)| i == 4 || i == 7 || c.is_ascii_digit())
}

fn day_path(character_id: &str, day: &str) -> PathBuf {
    diary_dir(character_id).join(format!("{day}.md"))
}

/// 从按天聚合的历史里挑出「这次该写哪一天」。
///
/// 【为什么单独一个纯函数】这段判断错起来是安静的：挑错一天就是「昨天写了两遍」
/// 或者「永远不写」，而它内联在命令里时没法测（命令要真读写状态文件）。
///
/// 规则就三条：
///   1. **今天不写** —— 今天还没过完，没什么可回顾的（真日记也是第二天写昨天）；
///   2. 取**最近**那个不是今天、且日期形状合法的日子；中间断过几天也能自动对上
///      （写的是「上一个有记录的日子」，不是死板的「昨天」）；
///   3. 那天已经写过就**什么都不做**（不往前追）：往前追会让一个漏写的日子
///      把更早的日子反复重写。
///
/// 另外 `today` 必须是个合法日期：不知道今天就没法判断「这天过完没有」，
/// 宁可这一轮不写。
pub fn pick_day<'a>(
    daily: &'a [DailyPoint],
    today: &str,
    last_written: &str,
) -> Option<&'a DailyPoint> {
    if !day_ok(today) {
        return None;
    }
    let pick = daily
        .iter()
        .rev()
        .find(|d| d.day != today && day_ok(&d.day))?;
    if pick.day == last_written {
        return None;
    }
    Some(pick)
}

/// 写一天的日记，返回写到的路径。
///
/// 【已存在怎么办】**不覆盖**：一天一篇是「她的记录」，第二次写就接在末尾。
/// 正常走不到这条路（`last_diary_day` 挡着同一天问第二次），留着是为了
/// 「手动重写」之类的情况不丢旧内容。
///
/// 【为什么走临时文件 + rename】写一半被打断不能留个残缺的日记 ——
/// 这个项目在 `.quill-meta.json` 上踩过同一类问题。
pub fn save_day(character_id: &str, day: &str, text: &str) -> Result<PathBuf, String> {
    if !day_ok(day) {
        return Err(format!("日期得是 YYYY-MM-DD 的样子：{day}"));
    }
    let body = text.trim();
    if body.is_empty() {
        return Err("日记是空的，不写".into());
    }
    let dir = diary_dir(character_id);
    std::fs::create_dir_all(&dir).map_err(|e| format!("建不了日记目录：{e}"))?;
    let path = day_path(character_id, day);
    let mut out = String::new();
    if path.exists() {
        let old = std::fs::read_to_string(&path).unwrap_or_default();
        out.push_str(old.trim_end());
        out.push_str("\n\n---\n\n");
    } else {
        // 标题只在第一次写时加：追加那次不该再插一个标题
        out.push_str(&format!("# {day}\n\n"));
    }
    out.push_str(body);
    out.push('\n');
    let tmp = path.with_extension("md.tmp-write");
    std::fs::write(&tmp, out.as_bytes()).map_err(|e| format!("写不进去：{e}"))?;
    std::fs::rename(&tmp, &path).map_err(|e| format!("换名失败：{e}"))?;
    Ok(path)
}

/// 读某天的日记（设置页要能翻）
pub fn read_day(character_id: &str, day: &str) -> Option<String> {
    if !day_ok(day) {
        return None;
    }
    std::fs::read_to_string(day_path(character_id, day)).ok()
}

/// 有日记的日子（新的在前）
pub fn days(character_id: &str) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    let Ok(entries) = std::fs::read_dir(diary_dir(character_id)) else {
        return out;
    };
    for e in entries.flatten() {
        let p = e.path();
        if p.extension().and_then(|x| x.to_str()) != Some("md") {
            continue;
        }
        if let Some(stem) = p.file_stem().and_then(|x| x.to_str()) {
            if day_ok(stem) {
                out.push(stem.to_string());
            }
        }
    }
    out.sort();
    out.reverse();
    out
}

/// 设置页那一栏用的一天：哪天 + 她写了多少字。
///
/// 【为什么不把正文一起带上】列表要的是"有哪些天"，正文点开再取一次 ——
/// 攒到几十天时没必要每次都把全部正文塞进 IPC（Quill 那边在这上面吃过亏：
/// MB 级文本经 IPC JSON 化能到 1.3 秒）。
#[derive(serde::Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct DiaryDay {
    pub day: String,
    /// 正文多少字（**不含标题行** —— 标题是文件名重复一遍，不该算成她写的）
    pub chars: usize,
}

/// 正文部分：掐掉第一行的 `# 日期` 与首尾空白。
///
/// 【为什么要它】文件里那行标题是给"用记事本直接打开也看得懂"用的，而设置页已经把
/// 日期摆在旁边了 —— 再把 `# 2026-10-01` 原样显示出来就只是难看（验收脚本抓到的）。
///
/// 【为什么只此一处】文件布局由这里一个人说了算：`body_chars`（列表里那个"N 字"）
/// 和设置页显示的正文本必须是同一段裁法，否则"72 字"和眼睛看到的内容对不上。
pub fn body_of(text: &str) -> &str {
    let t = text.trim();
    match t.strip_prefix("# ") {
        Some(rest) => rest.splitn(2, '\n').nth(1).unwrap_or("").trim(),
        None => t,
    }
}

/// 数正文（用同一段裁剪，见 `body_of`）。
fn body_chars(text: &str) -> usize {
    body_of(text).chars().count()
}

/// 有日记的日子 + 每天多少字（设置页「她的日记」）。
pub fn list(character_id: &str) -> Vec<DiaryDay> {
    days(character_id)
        .into_iter()
        .map(|day| {
            let chars = read_day(character_id, &day)
                .map(|t| body_chars(&t))
                .unwrap_or(0);
            DiaryDay { day, chars }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// 日期形状不对必须直接拒 —— 文件名由它拼出来，放过去就是路径穿越。
    ///
    /// 【只测纯逻辑，不碰文件】写盘那一层要隔离数据目录才能测，而
    /// `set_app_root_override` 是 `OnceLock`（一个进程只设得了一次）——
    /// 在这里设了会连带影响同进程里别的模块的测试。所以这里只验「拦不拦得住」，
    /// 真正的落盘留给真机（设置页翻一次日记就验证了）。
    #[test]
    fn refuses_bad_day() {
        assert!(save_day("c", "../../evil", "x").is_err(), "路径穿越要拒");
        assert!(save_day("c", "2026/10/03", "x").is_err());
        assert!(save_day("c", "今天", "x").is_err());
        assert!(save_day("c", "2026-10-3", "x").is_err(), "补零不能省");
        assert!(save_day("c", "", "x").is_err());
    }

    #[test]
    fn refuses_empty_text() {
        assert!(save_day("c", "2026-10-03", "   \n ").is_err(), "空日记不写");
    }

    #[test]
    fn day_shape_accepts_real_days() {
        assert!(day_ok("2026-10-03"));
        assert!(day_ok("1999-01-01"));
    }

    fn pt(day: &str, turns: u32) -> DailyPoint {
        DailyPoint {
            day: day.to_string(),
            affinity: 80,
            valence: 0.2,
            turns,
        }
    }

    /// 写的是**最近**那个不是今天的日子（不是"昨天"——中间断过几天也对得上）。
    #[test]
    fn pick_day_takes_latest_not_today() {
        let daily = vec![pt("2026-09-28", 3), pt("2026-10-01", 7), pt("2026-10-03", 12)];
        let got = pick_day(&daily, "2026-10-03", "").expect("该挑到 10-01");
        assert_eq!(got.day, "2026-10-01");
        assert_eq!(got.turns, 7);
    }

    /// 只有今天有记录 → 不写（今天还没过完）。
    #[test]
    fn pick_day_nothing_when_only_today() {
        let daily = vec![pt("2026-10-03", 5)];
        assert!(pick_day(&daily, "2026-10-03", "").is_none());
        assert!(pick_day(&[], "2026-10-03", "").is_none());
    }

    /// 那天写过了 → 什么都不做，**不往前追**（否则漏一天会连锁重写更早的日子）。
    #[test]
    fn pick_day_stops_after_written() {
        let daily = vec![pt("2026-10-01", 3), pt("2026-10-02", 4)];
        assert!(pick_day(&daily, "2026-10-03", "2026-10-02").is_none());
        // 写的是 10-01：10-02 还没写，照样挑 10-02
        assert_eq!(pick_day(&daily, "2026-10-03", "2026-10-01").unwrap().day, "2026-10-02");
    }

    /// 形状不对的日子直接跳过（状态文件是可以手改的，别让它决定写哪个文件名）。
    #[test]
    fn pick_day_skips_malformed() {
        let daily = vec![pt("2026-10-01", 3), pt("../../evil", 9), pt("2026/10/02", 4)];
        assert_eq!(pick_day(&daily, "2026-10-03", "").unwrap().day, "2026-10-01");
    }

    /// 数的是正文：标题行是文件名重复一遍，不该算成她写的字。
    ///
    /// 【为什么拿字面量比，而不是写个数字】第一版就是硬编码的期望值，而我数错了 ——
    /// 断言红了一次才发现是断言错、不是代码错。拿"应该等于的那段字"对比，
    /// 读的人一眼能自己数，也不会因为我手抖就冤枉代码。
    #[test]
    fn body_chars_skips_title() {
        assert_eq!(
            body_chars("# 2026-10-02\n\n他今天很烦。\n"),
            "他今天很烦。".chars().count(),
            "标题行不该算进去",
        );
        // 追加过的（中间有条分隔线）：连着分隔线一起算，反正它真在文件里
        assert_eq!(
            body_chars("# 2026-10-02\n\n甲\n\n---\n\n乙\n"),
            "甲\n\n---\n\n乙".chars().count(),
        );
        // 没有标题行的一律照数（手写进去的文件也不会被算少）
        assert_eq!(
            body_chars("没有标题的一行\n"),
            "没有标题的一行".chars().count(),
        );
        assert_eq!(body_chars("  \n "), 0, "全空白 = 0 字");
        assert_eq!(body_chars("# 2026-10-02\n"), 0, "只有标题 = 0 字");
    }

    /// 设置页拿到的是**正文**，不是整份文件（那个 `# 日期` 只是给记事本看的）。
    #[test]
    fn body_of_drops_the_title_line() {
        assert_eq!(body_of("# 2026-10-02\n\n他今天很烦。\n"), "他今天很烦。");
        assert_eq!(body_of("没有标题\n"), "没有标题", "手写的文件照样能读");
        assert_eq!(body_of("# 2026-10-02\n"), "", "只有标题就是空的");
        assert_eq!(body_of("  \n"), "");
    }

    /// 今天不知道 → 不写（判断不了"这天过完没有"）。
    #[test]
    fn pick_day_needs_valid_today() {
        let daily = vec![pt("2026-10-02", 4)];
        assert!(pick_day(&daily, "", "").is_none());
        assert!(pick_day(&daily, "今天", "").is_none());
    }
}
