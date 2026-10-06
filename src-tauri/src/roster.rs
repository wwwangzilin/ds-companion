//! 「同住」层：这台机器上不止她一个。
//!
//! 【它解决什么】主人有五个人设，但切过去等于换一个人 —— 彼此**不存在**。而她们其实
//! 是轮流陪着同一个人：露娜不在的时候，娘在。这一层把"还有谁在、她刚才在干嘛"记下来，
//! 注入时给**别的**角色看。
//!
//! 【为什么不是记忆】记忆是"发生过什么事实"、按关键词检索；这是**当下的在场**，
//! 几十小时就过期，而且必须是**别人的**那一条（自己那行要排除掉）。
//!
//! 【为什么块尾写"可以提也可以不提"】这一层的用法是**背景**，不是提示她去演对手戏。
//! 她要真提了，那句话才会让人愣一下；每轮都提就变成了播报。

use serde::{Deserialize, Serialize};

/// 一条"在场"记录
#[derive(Serialize, Deserialize, Clone, Debug, Default)]
#[serde(default, rename_all = "camelCase")]
pub struct Peer {
    pub id: String,
    pub name: String,
    /// 最后一次露面（毫秒）
    pub at: u64,
    /// 她当时手上在做什么
    pub activity: String,
    /// 她当时的心情
    pub mood: String,
}

/// 多久没露面就不再算"还在"（48 小时）
const PEER_KEEP_MS: u64 = 48 * 60 * 60 * 1000;
/// 一次最多报几个（多了像点名）
const PEER_MAX: usize = 3;
/// 最多留几条（防文件长胖）
const PEER_CAP: usize = 12;

fn file() -> std::path::PathBuf {
    crate::personas::app_root().join("roster.json")
}

pub fn load() -> Vec<Peer> {
    let Ok(raw) = std::fs::read_to_string(file()) else {
        return Vec::new();
    };
    serde_json::from_str::<Vec<Peer>>(&raw).unwrap_or_default()
}

fn save(list: &[Peer]) -> Result<(), String> {
    let dir = crate::personas::app_root();
    std::fs::create_dir_all(&dir).map_err(|e| format!("建目录失败：{e}"))?;
    let path = file();
    // 原子写：临时文件 + rename（照项目里其它落盘处的惯例）
    let tmp = path.with_extension("json.tmp");
    let body = serde_json::to_string_pretty(list).map_err(|e| format!("序列化失败：{e}"))?;
    std::fs::write(&tmp, body).map_err(|e| format!("写失败：{e}"))?;
    std::fs::rename(&tmp, &path).map_err(|e| format!("替换失败：{e}"))
}

/// 记一笔"她刚露面了"。同一个 id 只留一条。
///
/// 顺手清理过期行 —— 这个文件只有"当下"，不该攒成历史。
pub fn touch(id: &str, name: &str, activity: &str, mood: &str, now: u64) -> Vec<Peer> {
    let id = id.trim();
    if id.is_empty() {
        return load();
    }
    let mut list: Vec<Peer> = load()
        .into_iter()
        .filter(|p| p.at > 0 && now.saturating_sub(p.at) < PEER_KEEP_MS)
        .collect();
    list.retain(|p| p.id != id);
    list.push(Peer {
        id: id.to_string(),
        name: crate::state::clip_chars(name.trim(), 40),
        at: now,
        activity: crate::state::clip_chars(activity.trim(), 60),
        mood: crate::state::clip_chars(mood.trim(), 12),
    });
    list.sort_by_key(|p| p.at);
    while list.len() > PEER_CAP {
        list.remove(0);
    }
    let _ = save(&list);
    list
}

/// 组【同住】块。`me` 是当前角色 —— **自己那行必须排除**（她不用"知道自己在场"）。
pub fn render_peer_block(peers: &[Peer], me: &str, now: u64) -> String {
    let others: Vec<&Peer> = peers
        .iter()
        .filter(|p| p.id != me && !p.name.trim().is_empty())
        .filter(|p| now.saturating_sub(p.at) < PEER_KEEP_MS)
        .collect();
    if others.is_empty() {
        return String::new();
    }
    let mut items: Vec<String> = Vec::new();
    for p in others.iter().rev().take(PEER_MAX) {
        let ago = crate::tools::ago_text(now.saturating_sub(p.at));
        let doing = if p.activity.trim().is_empty() {
            String::new()
        } else {
            format!("，当时在{}", p.activity.trim())
        };
        items.push(format!("- {}：{}{}", p.name.trim(), ago, doing));
    }
    format!(
        "【同住】这台机器上不止你一个 —— 你们轮流陪着同一个人。最近还在的：\n{}\n【可以顺口提一句，也可以完全不提。要提就一两句，别演成三角戏，也别替对方说话。】",
        items.join("\n")
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn peer(id: &str, name: &str, at: u64, activity: &str) -> Peer {
        Peer {
            id: id.into(),
            name: name.into(),
            at,
            activity: activity.into(),
            mood: String::new(),
        }
    }

    #[test]
    fn peer_block_skips_self_and_stale() {
        let now = 1_000_000_000u64;
        let peers = vec![
            peer("me", "自己", now, "写代码"),
            peer("other", "别人", now - 60_000, "翻冰箱"),
            // 刚好超过保留期：不该出现
            peer("stale", "太久没来", now - PEER_KEEP_MS - 1, "发呆"),
        ];
        let s = render_peer_block(&peers, "me", now);
        assert!(s.contains("别人"), "该带上别人：{s}");
        assert!(!s.contains("自己"), "★不能把自己写进去★：{s}");
        assert!(!s.contains("太久没来"), "★超过保留期的不该出现★：{s}");
        assert!(s.contains("1 分钟前"), "该写出「多久之前」：{s}");
        assert!(s.contains("翻冰箱"), "该带上她在干嘛：{s}");
    }

    #[test]
    fn peer_block_is_empty_when_alone() {
        let now = 1_000_000_000u64;
        let peers = vec![peer("me", "自己", now, "")];
        assert!(
            render_peer_block(&peers, "me", now).is_empty(),
            "只有自己时不该冒出这个块"
        );
    }

    /// 没配名字的行走不进块里（半截数据不如不报）
    #[test]
    fn peer_block_needs_a_name() {
        let now = 1_000_000_000u64;
        let peers = vec![peer("other", "  ", now, "发呆")];
        assert!(render_peer_block(&peers, "me", now).is_empty());
    }
}
