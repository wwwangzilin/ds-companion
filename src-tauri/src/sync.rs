//! 用对话同步设置：把配置 / 人设 / 状态 / 记忆打成一个包，塞进一个 DeepSeek 对话；
//! 换设备时再从那个对话里读回来。
//!
//! 【为什么走对话】这软件本来就是"以页面身份"打 chat.deepseek.com 的 —— 账号即云盘。
//! 不用再加服务器、不用管第二套鉴权，新设备上只要有同一个账号就能把家搬过去。
//!
//! 【为什么存原文不解析】人设是 `.md`、状态是 `.json` —— 打包时**原样读文本**，
//! 导入时**原样写回去**，中间不做结构解析。这样老版本写的文件在新版本里不会被解坏，
//! 新版本写的文件被老版本吃下去也只是"某些字段它不用"而已。
//!
//! 【为什么不带立绘】PNG 动辄 1MB，base64 之后塞进对话里既贵又慢，而且它是二进制。
//! 包里只记"这台机器上有哪几张"，提示主人自己重传。
//!
//! 【记忆只增不删】导入时**只补本地没有的 id**，绝不覆盖、绝不清空 —— 这是本项目的
//! 老规矩（记忆文件只增不删），也防住"新设备导入了老包，把这边刚攒的记忆冲掉"。

use crate::avatar;
use crate::config;
use crate::memory;
use crate::personas;
use serde::{Deserialize, Serialize};

/// 包的结构版本。改结构就 +1，导入端按它决定认不认。
pub const PACK_VERSION: u32 = 1;

/// 信封：导入时靠这两个记号在对话正文里把包抠出来。
/// 记号里带版本号，将来真想并行两代格式时也有地方下手。
pub const MARK_OPEN: &str = "【DS-COMPANION-SYNC 1】";
pub const MARK_CLOSE: &str = "【/DS-COMPANION-SYNC】";

/// 包里的一份文件：`path` 是**相对数据目录的路径**（如 `personas/dsh-luna.md`）。
///
/// 用相对路径而不是绝对路径，是因为包要在两台机器之间走 ——
/// 绝对路径到了新设备上必然指向一个不存在的地方。
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct PackFile {
    pub path: String,
    pub text: String,
}

#[derive(Serialize, Deserialize, Debug, Clone)]
pub struct PackDoc {
    pub v: u32,
    /// 打包时间。**由页面传进来** —— Rust 侧 `std` 只有 UTC，问不出本地时区。
    pub at: String,
    pub config: serde_json::Value,
    pub personas: Vec<PackFile>,
    pub states: Vec<PackFile>,
    pub memories: Vec<serde_json::Value>,
    /// 只记文件名（不同步二进制），导入端据此提示"这几张图得自己重传"
    pub avatars: Vec<String>,
}

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SyncPackView {
    /// 带信封的完整文本，页面拿到直接当消息发出去
    pub text: String,
    pub bytes: usize,
    pub personas: usize,
    pub states: usize,
    pub memories: usize,
    pub avatars: usize,
}

#[derive(Serialize, Debug, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SyncApplyReport {
    pub personas: usize,
    pub states: usize,
    pub memories_added: usize,
    pub memories_skipped: usize,
    pub config: bool,
    /// 覆盖前的备份目录（导错了能从这里捞回来）
    pub backup: String,
    pub avatars_missing: Vec<String>,
}

// ─────────────────────── 信封 ───────────────────────

pub fn envelope(json: &str) -> String {
    format!("{MARK_OPEN}\n{json}\n{MARK_CLOSE}")
}

/// 从一段文本里把包抠出来。认不出就回 None（调用方报"这不是一个备份对话"）。
pub fn unwrap_envelope(text: &str) -> Option<&str> {
    let start = text.find(MARK_OPEN)? + MARK_OPEN.len();
    let rest = &text[start..];
    let end = rest.find(MARK_CLOSE)?;
    Some(rest[..end].trim())
}

/// 解析一段**对话正文**（可能前后裹着模型的寒暄）里的包。
pub fn parse_pack(text: &str) -> Result<PackDoc, String> {
    let body = unwrap_envelope(text).ok_or_else(|| "这段话里没有找到同步包（记号不对）".to_string())?;
    let doc: PackDoc = serde_json::from_str(body).map_err(|e| format!("包解不开：{e}"))?;
    if doc.v > PACK_VERSION {
        return Err(format!(
            "这个包是更新版本（v{}）打的，本版本只认到 v{} —— 先升级软件",
            doc.v, PACK_VERSION
        ));
    }
    Ok(doc)
}

// ─────────────────────── 打包 ───────────────────────

/// 收目录下某个后缀的所有文件，`path` 写成相对数据目录的形式。
fn collect(dir: &std::path::Path, rel: &str, ext: &str) -> Vec<PackFile> {
    let mut out = Vec::new();
    let Ok(entries) = std::fs::read_dir(dir) else {
        return out;
    };
    for e in entries.flatten() {
        let p = e.path();
        if !p.is_file() {
            continue;
        }
        if p.extension().and_then(|s| s.to_str()) != Some(ext) {
            continue;
        }
        let Some(name) = p.file_name().and_then(|s| s.to_str()) else {
            continue;
        };
        // 读不出来的（权限/编码）就跳过，不要让一个坏文件毁掉整次导出
        if let Ok(text) = std::fs::read_to_string(&p) {
            out.push(PackFile {
                path: format!("{rel}/{name}"),
                text,
            });
        }
    }
    out.sort_by(|a, b| a.path.cmp(&b.path));
    out
}

pub fn pack(at: &str) -> Result<SyncPackView, String> {
    let root = personas::app_root();
    let cfg = config::load();
    let cfg_value = serde_json::to_value(&cfg).map_err(|e| format!("配置序列化失败：{e}"))?;

    let personas_out = collect(&root.join("personas"), "personas", "md");
    let states_out = collect(&root.join("state"), "state", "json");

    let mut memories_out = Vec::new();
    for m in memory::list_memories() {
        match serde_json::to_value(&m) {
            Ok(v) => memories_out.push(v),
            Err(_) => continue,
        }
    }

    let mut avatars_out: Vec<String> = Vec::new();
    if let Ok(entries) = std::fs::read_dir(avatar::dir()) {
        for e in entries.flatten() {
            if let Some(name) = e.file_name().to_str() {
                if name.ends_with(".png") {
                    avatars_out.push(name.to_string());
                }
            }
        }
    }
    avatars_out.sort();

    let doc = PackDoc {
        v: PACK_VERSION,
        at: at.to_string(),
        config: cfg_value,
        personas: personas_out,
        states: states_out,
        memories: memories_out,
        avatars: avatars_out,
    };
    let json = serde_json::to_string(&doc).map_err(|e| format!("包序列化失败：{e}"))?;
    let text = envelope(&json);
    Ok(SyncPackView {
        bytes: text.chars().count(),
        personas: doc.personas.len(),
        states: doc.states.len(),
        memories: doc.memories.len(),
        avatars: doc.avatars.len(),
        text,
    })
}

// ─────────────────────── 应用 ───────────────────────

/// 记忆合并：**只补本地没有的 id**。返回 (要写入的, 跳过几条)。
pub fn merge_memories(
    local: &[memory::MemoryItem],
    incoming: &[serde_json::Value],
) -> (Vec<memory::MemoryItem>, usize) {
    let mut have: std::collections::HashSet<String> =
        local.iter().map(|m| m.id.clone()).collect();
    let mut add = Vec::new();
    let mut skipped = 0usize;
    for v in incoming {
        match serde_json::from_value::<memory::MemoryItem>(v.clone()) {
            Ok(m) if !m.id.trim().is_empty() && !have.contains(&m.id) => {
                have.insert(m.id.clone());
                add.push(m);
            }
            _ => skipped += 1,
        }
    }
    (add, skipped)
}

/// 把备份目录名从时间串里洗出来（`2026-10-05 21:40` → `20261005-2140`）。
pub fn stamp_of(at: &str) -> String {
    let digits: String = at.chars().filter(|c| c.is_ascii_digit()).collect();
    if digits.len() >= 12 {
        format!("{}-{}", &digits[0..8], &digits[8..12])
    } else if digits.is_empty() {
        "unknown".to_string()
    } else {
        digits
    }
}

fn write_file_atomic(path: &std::path::Path, text: &str) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| format!("建目录失败：{e}"))?;
    }
    let tmp = path.with_extension("sync-tmp");
    std::fs::write(&tmp, text).map_err(|e| format!("写文件失败：{e}"))?;
    std::fs::rename(&tmp, path).map_err(|e| format!("替换文件失败：{e}"))
}

pub fn apply(text: &str) -> Result<SyncApplyReport, String> {
    let doc = parse_pack(text)?;
    let root = personas::app_root();
    std::fs::create_dir_all(&root).map_err(|e| format!("数据目录不可写：{e}"))?;

    // ① 先备份要覆盖的东西 —— 导错包是要能捞回来的
    let stamp = stamp_of(&doc.at);
    let backup_dir = root.join("sync-backup").join(&stamp);
    let mut backed = 0usize;
    for f in doc.personas.iter().chain(doc.states.iter()) {
        let src = root.join(f.path.replace('/', std::path::MAIN_SEPARATOR_STR));
        if src.exists() {
            if let Ok(text) = std::fs::read_to_string(&src) {
                let dst = backup_dir.join(f.path.replace('/', std::path::MAIN_SEPARATOR_STR));
                if write_file_atomic(&dst, &text).is_ok() {
                    backed += 1;
                }
            }
        }
    }
    let cfg_path = root.join("config.json");
    if let Ok(text) = std::fs::read_to_string(&cfg_path) {
        if write_file_atomic(&backup_dir.join("config.json"), &text).is_ok() {
            backed += 1;
        }
    }

    // ② 人设 / 状态：原样写回
    let mut personas_n = 0usize;
    for f in &doc.personas {
        let dst = root.join(f.path.replace('/', std::path::MAIN_SEPARATOR_STR));
        write_file_atomic(&dst, &f.text)?;
        personas_n += 1;
    }
    let mut states_n = 0usize;
    for f in &doc.states {
        let dst = root.join(f.path.replace('/', std::path::MAIN_SEPARATOR_STR));
        write_file_atomic(&dst, &f.text)?;
        states_n += 1;
    }

    // ③ 配置整体覆盖（"同步"就是让这台变成那台的样子）
    let cfg = serde_json::from_value::<config::AppConfig>(doc.config.clone())
        .map_err(|e| format!("包里的配置认不出来：{e}"))?;
    config::save(&cfg)?;

    // ④ 记忆只增不删
    let local = memory::list_memories();
    let (add, skipped) = merge_memories(&local, &doc.memories);
    let mut added = 0usize;
    for m in &add {
        if memory::save_memory(m).is_ok() {
            added += 1;
        }
    }

    // ⑤ 包里提到、但这台机器上没有的立绘 —— 明确列出来，别让人以为"同步完整了"
    let mut missing = Vec::new();
    for name in &doc.avatars {
        let id = name.trim_end_matches(".png");
        if !avatar::has_user(id) {
            missing.push(name.clone());
        }
    }

    Ok(SyncApplyReport {
        personas: personas_n,
        states: states_n,
        memories_added: added,
        memories_skipped: skipped,
        config: true,
        backup: if backed > 0 {
            backup_dir.display().to_string()
        } else {
            String::new()
        },
        avatars_missing: missing,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn envelope_roundtrip() {
        let text = envelope("{\"v\":1}");
        assert_eq!(unwrap_envelope(&text), Some("{\"v\":1}"));
    }

    /// 真发消息时，模型可能在里面加寒暄 —— 抠包必须只认记号之间的东西。
    #[test]
    fn unwrap_ignores_surrounding_chatter() {
        // 注意：JSON 得先放进变量再传进 format!，直接写在格式串里会被当成占位符
        let body = r#"{"v":1,"at":"x"}"#;
        let raw = format!("好的，这是备份：\n{}\n{}\n{}\n需要我做什么？", MARK_OPEN, body, MARK_CLOSE);
        assert_eq!(unwrap_envelope(&raw), Some(body));
    }

    #[test]
    fn unwrap_returns_none_without_markers() {
        assert_eq!(unwrap_envelope("这一段里什么都没有"), None);
        assert_eq!(unwrap_envelope(MARK_OPEN), None, "只有开始记号不该当成有效包");
    }

    #[test]
    fn parse_rejects_newer_version() {
        let json = r#"{"v":99,"at":"x","config":null,"personas":[],"states":[],"memories":[],"avatars":[]}"#;
        let err = parse_pack(&envelope(json)).unwrap_err();
        assert!(err.contains("更新版本"), "{err}");
    }

    #[test]
    fn parse_accepts_minimal_pack() {
        let json = r#"{"v":1,"at":"2026-10-05 21:40","config":{"a":1},"personas":[{"path":"personas/x.md","text":"hi"}],"states":[],"memories":[],"avatars":[]}"#;
        let doc = parse_pack(&envelope(json)).unwrap();
        assert_eq!(doc.v, 1);
        assert_eq!(doc.personas.len(), 1);
        assert_eq!(doc.personas[0].path, "personas/x.md");
    }

    /// 记忆是**只增不删**：本地已有的 id 一律跳过，别让导入把这边新攒的冲掉。
    #[test]
    fn merge_memories_only_adds_new_ids() {
        // MemoryItem 没有 Default（name/content 是必填），只能显式造
        let local = vec![memory::MemoryItem {
            id: "m1".into(),
            character_id: String::new(),
            name: "本地标题".into(),
            content: "本地老记忆".into(),
            keys: vec![],
            importance: 3,
            pinned: false,
            source_ref: String::new(),
            source: String::new(),
            created_at: 0,
            last_accessed_at: 0,
            access_count: 0,
        }];
        let incoming = vec![
            serde_json::json!({"id": "m1", "name": "包里的标题", "content": "不该覆盖本地"}),
            serde_json::json!({"id": "m2", "name": "新标题", "content": "包里新的"}),
            serde_json::json!({"nope": true}),
        ];
        let (add, skipped) = merge_memories(&local, &incoming);
        assert_eq!(add.len(), 1, "只该补 m2");
        assert_eq!(add[0].id, "m2");
        assert_eq!(skipped, 2, "m1 跳过 + 坏条目跳过");
    }

    #[test]
    fn stamp_of_cleans_time() {
        assert_eq!(stamp_of("2026-10-05 21:40"), "20261005-2140");
        assert_eq!(stamp_of(""), "unknown");
        assert_eq!(stamp_of("abc"), "unknown");
    }
}
