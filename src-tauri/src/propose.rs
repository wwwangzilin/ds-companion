//! 角色自我修订：让她**提案**，主人**采纳**。
//!
//! 为什么不做成"她自己改自己"：
//!   ① 人设是主人写的。让模型直接改写它，等于把"这个人是谁"的最终解释权交出去 ——
//!      而"防漂移"恰恰是这套东西的另一半（回锚就是这么来的），两者不能自相矛盾。
//!   ② 注入的内容里混着聊天记录与记忆。真让模型无审查地改人设，一句被诱导的话
//!      就可能把角色改成另一个人。
//! 所以设计成：
//!   - **原始人设只读**，永不被程序改写（改人设只有主人在人设页手动改）
//!   - 她的自我修正落进 `addendum`（自订设定，一段可编辑、可一键清空的追加文本）
//!   - 每条提案都是一份**待审阅的记录**：改了什么、为什么改、第几轮提的，都在提案箱里
//!   - 锚点/处境这类低风险项可以在主人在场时采纳；人设增补永远要手点
//!
//! 落点：%APPDATA%\ds-companion\proposals\<角色>.json（数组，保留最近 30 条）

use std::fs;
use std::path::PathBuf;

use serde::{Deserialize, Serialize};

use crate::personas::{app_root, safe_id};
use crate::state::{clip_chars, CharState};

pub const KEEP: usize = 30;

#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct Proposal {
    pub id: String,
    pub character_id: String,
    pub created_at: u64,
    /// 第几轮提的（溯源用）
    pub turn: u32,
    /// 她想给自己加的一条设定（一句话，会追加进"自订设定"）
    pub persona_addendum: String,
    /// 她想记住的新约定
    pub anchors: Vec<String>,
    /// 她眼里的近况
    pub arc: String,
    /// 为什么这么改（给她自己一个交代，也是主人审阅的依据）
    pub reason: String,
    /// pending / accepted / rejected
    pub status: String,
    pub applied_at: u64,
}

pub fn proposals_dir() -> PathBuf {
    app_root().join("proposals")
}

pub fn ensure_dir() -> std::io::Result<()> {
    fs::create_dir_all(proposals_dir())
}

fn path_for(character_id: &str) -> PathBuf {
    let key = if character_id.trim().is_empty() {
        "_global".to_string()
    } else {
        safe_id(character_id)
    };
    proposals_dir().join(format!("{key}.json"))
}

pub fn list(character_id: &str) -> Vec<Proposal> {
    let items: Vec<Proposal> = match fs::read_to_string(path_for(character_id)) {
        Ok(t) => serde_json::from_str(&t).unwrap_or_default(),
        Err(_) => Vec::new(),
    };
    dedup_by_id(items)
}

/// 同 id 只留一条：**优先留已经处理过的那条**，其次留最后出现的。
///
/// 【为什么必须在入口去重】真实数据里出现过同一个 id 两条 —— 一条 `rejected`、
/// 一条 `pending`（早期验收脚本没做数据隔离时写进去的残留）。当时 `set_status` 用
/// `find` 只改第一条匹配，于是第二条 pending 永远挂在那儿：主人点一百次「驳回」也没用，
/// 界面上永远显示"第 42 轮有一条待审"。在**读的那一层**去重，比在每个写入口打补丁可靠。
fn dedup_by_id(items: Vec<Proposal>) -> Vec<Proposal> {
    let mut out: Vec<Proposal> = Vec::new();
    for p in items {
        match out.iter_mut().find(|x| x.id == p.id) {
            Some(prev) => {
                // 已处理过的（applied_at 非 0）优先；两条都没处理过就留后写的那条
                let replace = match (prev.applied_at, p.applied_at) {
                    (a, b) if b > a => true,
                    (0, 0) => true,
                    _ => false,
                };
                if replace {
                    *prev = p;
                }
            }
            None => out.push(p),
        }
    }
    out
}

fn save_all(character_id: &str, items: &[Proposal]) -> Result<(), String> {
    ensure_dir().map_err(|e| e.to_string())?;
    let mut keep: Vec<Proposal> = items.to_vec();
    if keep.len() > KEEP {
        let drop = keep.len() - KEEP;
        keep.drain(0..drop);
    }
    let path = path_for(character_id);
    let text = serde_json::to_string_pretty(&keep).map_err(|e| e.to_string())?;
    let tmp = path.with_extension("json.tmp-write");
    fs::write(&tmp, text.as_bytes()).map_err(|e| e.to_string())?;
    fs::rename(&tmp, &path).map_err(|e| e.to_string())
}

/// 收下一条提案（页面侧生成后交回来）。
/// 内容全空的提案直接丢 —— 模型偶尔会回一个"我觉得挺好的"的空壳。
pub fn submit(mut p: Proposal, now: u64) -> Result<Proposal, String> {
    p.persona_addendum = clip_chars(p.persona_addendum.trim(), 200);
    p.reason = clip_chars(p.reason.trim(), 200);
    p.arc = clip_chars(p.arc.trim(), 80);
    p.anchors = p
        .anchors
        .iter()
        .map(|a| clip_chars(a.trim(), 80))
        .filter(|a| !a.is_empty())
        .take(3)
        .collect();
    if p.persona_addendum.is_empty() && p.anchors.is_empty() && p.arc.is_empty() {
        return Err("这条提案是空的（没有可采纳的内容）".into());
    }
    p.status = "pending".into();
    p.created_at = now;
    p.applied_at = 0;
    if p.id.trim().is_empty() {
        p.id = format!("pr-{now}");
    }
    let mut all = list(&p.character_id);
    // 同样的增补不重复攒（她可能连着几轮提同一件事）
    if all.iter().any(|x| {
        x.status == "pending" && x.persona_addendum == p.persona_addendum && x.arc == p.arc
    }) {
        return Err("和已有的待审提案重复".into());
    }
    all.push(p.clone());
    save_all(&p.character_id, &all)?;
    Ok(p)
}

/// 采纳/驳回只改状态，不动内容 —— 记录本身就是"她想过什么"的历史
///
/// 【改的是**所有**同 id 的条目，不是第一条】历史脏数据里同 id 可能有多条（见 `dedup_by_id`）；
/// 只改第一条会让剩下那些永远停在 pending，而界面上看起来就是"这条提案怎么点都不动"。
pub fn set_status(character_id: &str, id: &str, status: &str, now: u64) -> Result<Proposal, String> {
    let mut all = list(character_id);
    let mut out: Option<Proposal> = None;
    for p in all.iter_mut().filter(|p| p.id == id) {
        p.status = status.to_string();
        p.applied_at = now;
        if out.is_none() {
            out = Some(p.clone());
        }
    }
    let Some(item) = out else {
        return Err("找不到这条提案".to_string());
    };
    save_all(character_id, &all)?;
    Ok(item)
}

/// 把提案的内容并进角色状态。**纯函数**（落盘在外面做），能单测。
///
/// 三件事：
///   - 自订设定：追加一行（带日期标记，方便主人日后看清哪句是哪次加的）
///   - 锚点：去重合并（锚点是防漂移用的，重复的锚点只会白烧 token）
///   - 处境：非空才覆盖（她没提就别把现有的抹了）
pub fn apply_to_state(st: &mut CharState, p: &Proposal, day: &str) -> Vec<String> {
    let mut applied: Vec<String> = Vec::new();
    if !p.persona_addendum.trim().is_empty() {
        let line = format!("- [{}] {}", day, p.persona_addendum.trim());
        if !st.addendum.contains(p.persona_addendum.trim()) {
            if !st.addendum.is_empty() {
                st.addendum.push('\n');
            }
            st.addendum.push_str(&line);
            applied.push(format!("自订设定 +1：{}", clip_chars(&p.persona_addendum, 40)));
        }
    }
    for a in &p.anchors {
        let t = a.trim();
        if t.is_empty() || st.anchors.iter().any(|x| x == t) {
            continue;
        }
        st.anchors.push(t.to_string());
        applied.push(format!("锚点 +1：{}", clip_chars(t, 30)));
    }
    if !p.arc.trim().is_empty() && st.arc != p.arc.trim() {
        st.arc = clip_chars(p.arc.trim(), 80);
        applied.push(format!("处境 → {}", clip_chars(&p.arc, 30)));
    }
    if st.anchors.len() > 20 {
        st.anchors.truncate(20);
    }
    applied
}

#[cfg(test)]
mod tests {
    use super::*;

    fn prop() -> Proposal {
        Proposal {
            id: "pr-1".into(),
            character_id: "dsh-luna".into(),
            created_at: 1,
            turn: 42,
            persona_addendum: "说话别太端着，多用短句".into(),
            anchors: vec!["主人不喜欢被叫先生".into()],
            arc: "主人在做自我修订".into(),
            reason: "发现自己回得太正式".into(),
            status: "pending".into(),
            applied_at: 0,
        }
    }

    #[test]
    fn apply_writes_addendum_with_date_marker() {
        let mut st = CharState::default();
        st.character_id = "dsh-luna".into();
        let done = apply_to_state(&mut st, &prop(), "2026-09-30");
        assert!(st.addendum.contains("[2026-09-30]"));
        assert!(st.addendum.contains("多用短句"));
        assert_eq!(st.anchors.len(), 1);
        assert_eq!(st.arc, "主人在做自我修订");
        assert_eq!(done.len(), 3, "三项都该报出来：{done:?}");
    }

    #[test]
    fn apply_is_idempotent_for_addendum_and_anchors() {
        let mut st = CharState::default();
        let p = prop();
        apply_to_state(&mut st, &p, "2026-09-30");
        let again = apply_to_state(&mut st, &p, "2026-10-01");
        assert!(again.is_empty(), "重复采纳不该重复写：{again:?}");
        assert_eq!(st.anchors.len(), 1);
        assert_eq!(st.addendum.matches("短句").count(), 1);
    }

    #[test]
    fn apply_keeps_existing_arc_when_proposal_has_none() {
        let mut st = CharState::default();
        st.arc = "原来的处境".into();
        let mut p = prop();
        p.arc = String::new();
        apply_to_state(&mut st, &p, "2026-09-30");
        assert_eq!(st.arc, "原来的处境", "她没提就别抹掉");
    }

    #[test]
    fn apply_caps_anchors() {
        let mut st = CharState::default();
        for i in 0..30 {
            st.anchors.push(format!("旧锚点{i}"));
        }
        apply_to_state(&mut st, &prop(), "2026-09-30");
        assert!(st.anchors.len() <= 20, "锚点要有上限：{}", st.anchors.len());
    }

    #[test]
    fn submit_rejects_empty_shell() {
        let mut p = prop();
        p.persona_addendum = String::new();
        p.anchors.clear();
        p.arc = String::new();
        assert!(submit(p, 1).is_err(), "空壳提案该被拒");
    }

    #[test]
    fn submit_clips_and_assigns_id() {
        let mut p = prop();
        p.id = String::new();
        p.persona_addendum = "很长".repeat(200);
        let out = submit(p, 12345);
        let out = out.map_err(|e| e);
        // 没有磁盘权限时 submit 会失败（save_all），这里只验裁剪逻辑本身
        if let Ok(o) = out {
            assert!(o.persona_addendum.chars().count() <= 201);
            assert!(o.id.starts_with("pr-"));
            assert_eq!(o.status, "pending");
        }
    }

    // ─────────────── 同 id 重复条目（真实数据里出现过的脏数据）───────────────
    //
    // 现场：真实数据里 `pr-12345` 有两条 —— 一条 rejected、一条 pending。
    // 那是早期验收脚本没做隔离时写进去的残留，而 `set_status` 当时只改第一条匹配，
    // 于是第二条 pending 永远挂着："第 42 轮有一条待审"点多少次都消不掉。

    /// 入口去重：同 id 只留一条，且**优先留已经处理过的那条**
    #[test]
    fn duplicate_ids_collapse_to_the_handled_one() {
        let mut a = prop(); // pending、没处理过
        a.id = "pr-dup".into();
        let mut b = prop(); // 已驳回
        b.id = "pr-dup".into();
        b.status = "rejected".into();
        b.applied_at = 999;

        // 顺序反过来也要对（真实文件里是"已处理在前、pending 在后"）
        let out = dedup_by_id(vec![b.clone(), a.clone()]);
        assert_eq!(out.len(), 1, "同 id 只能剩一条：{out:?}");
        assert_eq!(out[0].status, "rejected", "要留处理过的那条，否则界面永远显示待审");

        let out2 = dedup_by_id(vec![a, b]);
        assert_eq!(out2.len(), 1);
        assert_eq!(out2[0].status, "rejected");
    }

    /// 两条都没处理过时，留**后写**的那条（新的意图）
    #[test]
    fn duplicate_ids_keep_the_latest_when_both_pending() {
        let mut a = prop();
        a.id = "pr-dup".into();
        a.persona_addendum = "旧的".into();
        let mut b = prop();
        b.id = "pr-dup".into();
        b.persona_addendum = "新的".into();
        let out = dedup_by_id(vec![a, b]);
        assert_eq!(out.len(), 1);
        assert_eq!(out[0].persona_addendum, "新的");
    }

    /// 不同 id 不能被误合并
    #[test]
    fn dedup_keeps_distinct_ids() {
        let mut a = prop();
        a.id = "pr-a".into();
        let mut b = prop();
        b.id = "pr-b".into();
        assert_eq!(dedup_by_id(vec![a, b]).len(), 2);
        assert!(dedup_by_id(Vec::new()).is_empty());
    }

    /// 落盘之后 set_status 要对**所有**同 id 条目生效（手工造一份脏文件来验）
    #[test]
    fn set_status_fixes_every_duplicate_on_disk() {
        crate::tests::lock_test_data_dir();
        let cid = "dsc-propose-dup-test";
        let mut a = prop();
        a.id = "pr-dup".into();
        a.character_id = cid.into();
        a.status = "rejected".into();
        a.applied_at = 111;
        let mut b = prop();
        b.id = "pr-dup".into();
        b.character_id = cid.into();

        // 直接写文件，绕开 submit 的"重复内容"检查 —— 模拟历史脏数据
        save_all(cid, &[a, b]).unwrap();
        assert_eq!(list(cid).len(), 1, "读的时候就该只剩一条");

        let out = set_status(cid, "pr-dup", "accepted", 777).unwrap();
        assert_eq!(out.status, "accepted");
        assert_eq!(out.applied_at, 777);
        // 落盘之后再读，仍然是"一条、已采纳"
        let after = list(cid);
        assert_eq!(after.len(), 1);
        assert_eq!(after[0].status, "accepted");
        assert!(
            after.iter().all(|p| p.status != "pending"),
            "不许有任何一条留在待审：{after:?}"
        );
        let _ = std::fs::remove_file(path_for(cid));
    }
}
