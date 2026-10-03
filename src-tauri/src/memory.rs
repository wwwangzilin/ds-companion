//! 记忆库：存储 + 增删改 + 交给页面做检索的载荷。
//!
//! 落点：%APPDATA%\ds-companion\memory\<id>.md（frontmatter + 正文），人可读可 git。
//!
//! 【为什么检索不在 Rust 做】注入钩子是在 XHR 的 send() 里**同步**改 body 的，
//! 而检索要用到"用户这次打的那句话"——同步上下文等不了 IPC 往返。
//! 所以：Rust 管持久化（这里是唯一真相源），页面在初始化时把整库拉进内存，
//! 命中打分 + token 装箱在页面里同步跑（脚本见 inject/selector.js）。
//!
//! 可见性语义（沿用 gal 的结论，别自己发明）：
//!   全局记忆（characterId 为空）+ 当前激活角色自己的记忆；
//!   没有角色激活时，带角色的记忆一条都不可见。

use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::personas::{app_root, safe_id};

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct MemoryItem {
    pub id: String,
    /// 空 = 全局（所有角色都能看到）
    #[serde(default)]
    pub character_id: String,
    /// 短标题，注入时会显示
    pub name: String,
    pub content: String,
    /// 触发词：对话里出现才可能被捞出来
    #[serde(default)]
    pub keys: Vec<String>,
    /// 1-5，抄 Generative Agents 的 importance：让"重要但不常提"的事也能浮上来
    #[serde(default = "default_importance")]
    pub importance: u8,
    #[serde(default)]
    pub pinned: bool,
    /// 来源锚点：这条是从哪段对话抽出来的（"2026-09-30 21:03 · 露娜模式"）。
    /// 主人问"她为什么记得这个"时，靠它翻得到原话。
    #[serde(default)]
    pub source_ref: String,
    /// 来路：manual（主人手写）/ extract（模型整理抽出来的）。
    /// 只记「当初怎么来的」，之后的更新不改它 —— 界面靠它回答"这条哪来的"。
    #[serde(default)]
    pub source: String,
    #[serde(default)]
    pub created_at: u64,
    #[serde(default)]
    pub last_accessed_at: u64,
    #[serde(default)]
    pub access_count: u32,
}

fn default_importance() -> u8 {
    3
}

/// 主人手写 / 模型整理抽出来 —— 界面靠这个回答"这条哪来的"
pub const SOURCE_MANUAL: &str = "manual";
pub const SOURCE_EXTRACT: &str = "extract";

pub fn memory_dir() -> PathBuf {
    app_root().join("memory")
}

pub fn ensure_dir() -> std::io::Result<()> {
    fs::create_dir_all(memory_dir())
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// 触发词用逗号/空格/顿号分隔都认
fn split_keys(raw: &str) -> Vec<String> {
    raw.split([',', '，', '、', ' ', '\t', '\n'])
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect()
}

fn render_md(m: &MemoryItem) -> String {
    format!(
        "---\nid: {}\ncharacterId: {}\nname: {}\nkeys: {}\nimportance: {}\npinned: {}\nsource: {}\nsourceRef: {}\ncreatedAt: {}\nlastAccessedAt: {}\naccessCount: {}\n---\n{}\n",
        m.id,
        m.character_id,
        m.name,
        m.keys.join(","),
        m.importance,
        m.pinned,
        m.source,
        m.source_ref,
        m.created_at,
        m.last_accessed_at,
        m.access_count,
        m.content
    )
}

fn parse_md(text: &str) -> Option<MemoryItem> {
    let mut lines = text.lines().peekable();
    while matches!(lines.peek(), Some(l) if l.trim().is_empty()) {
        lines.next();
    }
    if lines.peek().map(|l| l.trim()) != Some("---") {
        return None;
    }
    lines.next();
    let mut m = MemoryItem {
        id: String::new(),
        character_id: String::new(),
        name: String::new(),
        content: String::new(),
        keys: Vec::new(),
        importance: 3,
        pinned: false,
        source: String::new(),
        source_ref: String::new(),
        created_at: 0,
        last_accessed_at: 0,
        access_count: 0,
    };
    for line in lines.by_ref() {
        if line.trim() == "---" {
            break;
        }
        if let Some((k, v)) = line.split_once(':') {
            let v = v.trim();
            match k.trim() {
                "id" => m.id = v.to_string(),
                "characterId" => m.character_id = v.to_string(),
                "name" => m.name = v.to_string(),
                "keys" => m.keys = split_keys(v),
                "importance" => m.importance = v.parse().unwrap_or(3).clamp(1, 5),
                "pinned" => m.pinned = v == "true",
                "source" => m.source = v.to_string(),
                "sourceRef" => m.source_ref = v.to_string(),
                "createdAt" => m.created_at = v.parse().unwrap_or(0),
                "lastAccessedAt" => m.last_accessed_at = v.parse().unwrap_or(0),
                "accessCount" => m.access_count = v.parse().unwrap_or(0),
                _ => {}
            }
        }
    }
    m.content = lines.collect::<Vec<_>>().join("\n").trim().to_string();
    if m.id.is_empty() {
        return None;
    }
    // 老文件没有 source 字段：按手写算（B 链路是后加的，之前只可能是主人自己写的）
    if m.source.is_empty() {
        m.source = SOURCE_MANUAL.into();
    }
    Some(m)
}

fn write_atomic(path: &Path, data: &str) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let tmp = path.with_extension("tmp-write");
    fs::write(&tmp, data.as_bytes())?;
    fs::rename(&tmp, path)
}

pub fn list_memories() -> Vec<MemoryItem> {
    let mut out = Vec::new();
    let Ok(entries) = fs::read_dir(memory_dir()) else {
        return out;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("md") {
            continue;
        }
        let Ok(text) = fs::read_to_string(&path) else {
            // 读不出来（权限/占用）：留着别动，下次再说
            continue;
        };
        match parse_md(&text) {
            Some(m) => out.push(m),
            // 解析不了 = 这条记忆对整条链路都不存在了（注入、设置界面、整理去重全看不见）。
            // 不隔离的话它会一直躺在目录里"占位"，而主人只会觉得"这条怎么没了"。
            None => {
                crate::personas::recover_bad_file(&path, "记忆 frontmatter 解析失败");
            }
        }
    }
    out.sort_by(|a, b| b.importance.cmp(&a.importance).then(b.created_at.cmp(&a.created_at)));
    out
}

// ─────────────────── 权重衰减（只降权，绝不删文件）───────────────────
//
// 【要解决什么】注入原来按 `importance → created_at` 排。这意味着一条两年前的高分记忆
// 会和昨天的同分记忆**并列**，而"最近聊过什么"往往比"很久以前聊过什么"更该出现在上下文里。
// 但反过来也不能只看新 —— 所以做成**衰减**：随时间降权，被用到就回血。
//
// 【三条硬规矩】
//   1. **只影响排序，绝不删文件**（记忆这条链路上"只增不删"是铁律）。
//   2. **pinned 不衰减**：主人钉住的就是"永远要记得"。
//   3. **有下限**：再怎么老也不掉到 0 —— 否则一条关键词正好命中的旧记忆永远浮不上来，
//      那等于偷偷把它删了（只是删得更隐蔽）。

/// 半衰期：30 天没被碰过的记忆，权重掉一半
const HALF_LIFE_DAYS: f32 = 30.0;
/// 权重下限：低于它就按"平权"处理，保证老记忆还有浮上来的机会
const MIN_WEIGHT: f32 = 0.35;
/// 每次被访问（注入后 `memory_touch`）加的权重
const HIT_BONUS: f32 = 0.08;
/// 访问加成的封顶次数 —— 免得一条被反复捞出来的记忆永久霸榜
const HIT_BONUS_CAP: u32 = 10;
const DAY_MS: u64 = 86_400_000;

/// 这条记忆现在值多少分。**纯函数**：`now` 从外面传，测的时候不用等时间流逝。
///
/// 分三块：底分（importance）× 新鲜度 + 访问加成。新鲜度按半衰期衰减，
/// 但 pinned 恒为 1；最后统一抬到下限之上。
pub fn weight_of(m: &MemoryItem, now_ms: u64) -> f32 {
    let base = m.importance.clamp(1, 5) as f32;
    // 被访问过就以"上次访问"为基准 —— 这正是"用过就回血"的落地
    let last = m.created_at.max(m.last_accessed_at);
    let idle_days = if now_ms > last {
        (now_ms - last) as f32 / DAY_MS as f32
    } else {
        0.0
    };
    let freshness = if m.pinned {
        1.0
    } else {
        0.5f32.powf(idle_days / HALF_LIFE_DAYS)
    };
    let hits = m.access_count.min(HIT_BONUS_CAP) as f32 * HIT_BONUS;
    ((base + hits) * freshness).max(MIN_WEIGHT)
}

/// 注入用的顺序：权重高的在前，同分时新的在前（可预期，不会每次注入顺序都变）。
///
/// 【现在注入链路走的是 `list_weighted`】因为权重得跟着记忆一起给到页面
/// （页面侧的检索要用它）。这个函数留着给"只要 item、不要权重"的调用方，
/// 所以显式 allow —— 别看到没被调就删掉。
#[allow(dead_code)]
pub fn list_for_inject() -> Vec<MemoryItem> {
    let now = now_ms();
    let mut out = list_memories();
    out.sort_by(|a, b| {
        weight_of(b, now)
            .partial_cmp(&weight_of(a, now))
            .unwrap_or(std::cmp::Ordering::Equal)
            .then(b.created_at.cmp(&a.created_at))
    });
    out
}

/// 带权重的记忆（只给设置界面看：主人能看到"哪条会被优先注入"）。
///
/// 【为什么不给 `MemoryItem` 加字段】那样会牵连所有构造点（parse/merge/一堆测试），
/// 而且**有被写进 .md 的风险** —— 权重是随时在变的运行时值，落盘就是脏数据。
/// 用 `flatten` 包一层，前端照样能读到 item 的所有字段。
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct WeightedMemory {
    #[serde(flatten)]
    pub item: MemoryItem,
    pub weight: f32,
}

/// 记忆列表（按权重降序）+ 每条算好的权重值
pub fn list_weighted() -> Vec<WeightedMemory> {
    let now = now_ms();
    let mut out: Vec<WeightedMemory> = list_memories()
        .into_iter()
        .map(|item| WeightedMemory {
            weight: weight_of(&item, now),
            item,
        })
        .collect();
    out.sort_by(|a, b| {
        b.weight
            .partial_cmp(&a.weight)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then(b.item.created_at.cmp(&a.item.created_at))
    });
    out
}

pub fn save_memory(item: &MemoryItem) -> Result<MemoryItem, String> {
    if item.name.trim().is_empty() {
        return Err("记忆标题不能为空".into());
    }
    let raw_id = if item.id.trim().is_empty() {
        // 没给 id 就用标题生成一个稳定的
        item.name.clone()
    } else {
        item.id.clone()
    };
    let id = safe_id(&raw_id);
    let existing = list_memories().into_iter().find(|m| m.id == id);
    let saved = MemoryItem {
        id: id.clone(),
        character_id: item.character_id.trim().to_string(),
        name: item.name.trim().to_string(),
        content: item.content.clone(),
        keys: if item.keys.is_empty() {
            split_keys(&item.name)
        } else {
            item.keys.clone()
        },
        importance: item.importance.clamp(1, 5),
        pinned: item.pinned,
        // 来源锚点：显式给了就用给的，否则沿用旧的（翻旧账仍能追到出处）
        source_ref: if !item.source_ref.trim().is_empty() {
            item.source_ref.trim().to_string()
        } else {
            existing
                .as_ref()
                .map(|m| m.source_ref.clone())
                .unwrap_or_default()
        },
        // 来路：显式给了就用给的，否则沿用旧的，再否则算主人手写
        source: if !item.source.trim().is_empty() {
            item.source.trim().to_string()
        } else {
            existing
                .as_ref()
                .map(|m| m.source.clone())
                .filter(|s| !s.is_empty())
                .unwrap_or_else(|| SOURCE_MANUAL.to_string())
        },
        created_at: if item.created_at > 0 {
            item.created_at
        } else {
            existing.as_ref().map(|m| m.created_at).unwrap_or_else(now_ms)
        },
        last_accessed_at: existing.as_ref().map(|m| m.last_accessed_at).unwrap_or(0),
        access_count: existing.as_ref().map(|m| m.access_count).unwrap_or(0),
    };
    write_atomic(&memory_dir().join(format!("{id}.md")), &render_md(&saved))
        .map_err(|e| e.to_string())?;
    Ok(saved)
}

pub fn delete_memory(id: &str) -> Result<(), String> {
    let path = memory_dir().join(format!("{}.md", safe_id(id)));
    if !path.exists() {
        return Err("记忆不存在".into());
    }
    // 和删除人设一样：进回收站，不真删
    let trash = app_root().join("memory-trash");
    fs::create_dir_all(&trash).map_err(|e| e.to_string())?;
    let stamp = now_ms();
    fs::rename(&path, trash.join(format!("{}-{}.md", safe_id(id), stamp)))
        .map_err(|e| e.to_string())?;
    // 回收站封顶：这一条链是"每次删各留一份"，实测堆到过 100+ 份
    crate::personas::prune_trash(&trash);
    Ok(())
}

// ─────────────────────── 批量写入（B 链路：模型整理的结果） ───────────────────────

/// 模型吐回来的一条。op 只有 add / update / noop 三种（**没有 delete**：
/// 删除是主人的决定，留在设置界面手点，模型无权抹掉记忆）。
#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct IngestItem {
    #[serde(default)]
    pub op: String,
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub content: String,
    #[serde(default)]
    pub keys: Vec<String>,
    /// None = 模型这次没说 → 更新时保留旧值、新建时用 3。
    /// **不能**用 `#[serde(default)] u8`：缺字段会变成 0/3，把已有的 4 悄悄降级
    /// （和 Quill 那个 camelCase 丢字段是同一类"静默退到默认"的坑，已用单测盯住）。
    #[serde(default)]
    pub importance: Option<u8>,
    #[serde(default)]
    pub character_id: String,
    /// 模型自己的理由，只写进日志，不入库
    #[serde(default)]
    pub reason: String,
    /// 来源锚点（页面把"哪个角色、哪天、几点"拼好传进来）
    #[serde(default)]
    pub source_ref: String,
}

#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct IngestReport {
    pub ok: bool,
    pub added: usize,
    pub updated: usize,
    pub skipped: usize,
    /// 空字符串 = 没出错（序列化时省掉）
    #[serde(skip_serializing_if = "String::is_empty")]
    pub error: String,
    pub details: Vec<String>,
}

impl IngestReport {
    pub fn failed(error: &str) -> Self {
        Self {
            ok: false,
            added: 0,
            updated: 0,
            skipped: 0,
            error: error.to_string(),
            details: Vec::new(),
        }
    }
}

fn pick(new: &str, old: &str) -> String {
    let t = new.trim();
    if t.is_empty() {
        old.to_string()
    } else {
        t.to_string()
    }
}

/// 找出这条要并进哪一个已有条目。
///
/// 顺序很重要：先按 id，**找不到再按标题**。只按 id 找的话，模型把 id 写错/编了
/// 一个（很常见）就会退化成"新增"，而 save_memory 又会按标题生成同一个 id 覆盖掉
/// 旧文件 —— 结果统计上是 add、文件却被改了，importance 还会被悄悄降级。
/// （这条是验收脚本抓出来的，别简化回单一查找。）
pub fn resolve_target<'a>(pool: &'a [MemoryItem], it: &IngestItem) -> Option<&'a MemoryItem> {
    if !it.id.trim().is_empty() {
        let by_id = safe_id(&it.id);
        if let Some(m) = pool.iter().find(|m| m.id == by_id) {
            return Some(m);
        }
    }
    if !it.name.trim().is_empty() {
        let by_name = safe_id(&it.name);
        if let Some(m) = pool.iter().find(|m| m.id == by_name) {
            return Some(m);
        }
    }
    None
}

/// 把模型给的一条并进「已有条目」（None = 新条目）。
/// 纯函数，不碰磁盘 —— 合并规则是这个模块最容易出错的地方，必须能单测。
pub fn merge_item(existing: Option<&MemoryItem>, it: &IngestItem) -> MemoryItem {
    match existing {
        Some(old) => MemoryItem {
            id: old.id.clone(),
            name: pick(&it.name, &old.name),
            content: pick(&it.content, &old.content),
            keys: if it.keys.is_empty() {
                old.keys.clone()
            } else {
                it.keys.clone()
            },
            importance: it
                .importance
                .map(|v| v.clamp(1, 5))
                .unwrap_or(old.importance),
            character_id: pick(&it.character_id, &old.character_id),
            ..old.clone()
        },
        None => MemoryItem {
            id: String::new(),
            character_id: it.character_id.trim().to_string(),
            name: it.name.trim().to_string(),
            content: it.content.clone(),
            keys: it.keys.clone(),
            importance: it.importance.map(|v| v.clamp(1, 5)).unwrap_or(3),
            pinned: false,
            // 这个函数只被整理链路调用 —— 新条目天然是"抽出来的"
            source: SOURCE_EXTRACT.into(),
            source_ref: it.source_ref.trim().to_string(),
            created_at: 0,
            last_accessed_at: 0,
            access_count: 0,
        },
    }
}

/// Mem0 那套 ADD/UPDATE/NOOP 的落地版。
///
/// 两条去重屏障（模型不听话时兜底，别指望它每次都按格式来）：
///   ① 显式 id 命中已有条目 → 当更新
///   ② 没给 id 时用「标题 → 稳定 id」去找，**同名即更新**，绝不造第二条
pub fn ingest_memories(items: Vec<IngestItem>) -> IngestReport {
    let mut pool = list_memories();
    let mut report = IngestReport {
        ok: true,
        added: 0,
        updated: 0,
        skipped: 0,
        error: String::new(),
        details: Vec::new(),
    };

    for it in items {
        let op = it.op.trim().to_lowercase();
        if op == "noop" {
            report.skipped += 1;
            continue;
        }
        if it.name.trim().is_empty() && it.content.trim().is_empty() {
            report.skipped += 1;
            continue;
        }
        // update 却没给 id → 退回按标题找；add 给了 id → 也按 id 找（模型偶尔会这么写）
        let existing = resolve_target(&pool, &it).cloned();

        let merged = merge_item(existing.as_ref(), &it);
        match save_memory(&merged) {
            Ok(saved) => {
                if existing.is_some() {
                    report.updated += 1;
                } else {
                    report.added += 1;
                }
                report.details.push(format!(
                    "{} {} ({})",
                    if existing.is_some() { "update" } else { "add" },
                    saved.name,
                    saved.id
                ));
                match pool.iter_mut().find(|m| m.id == saved.id) {
                    Some(slot) => *slot = saved,
                    None => pool.push(saved),
                }
            }
            Err(e) => {
                report.skipped += 1;
                report.details.push(format!("fail {}", e));
            }
        }
    }
    report
}

/// 页面每轮注入后回报"这几条被用到了"，用来维护热度（对应 gal 的 decayScore）
pub fn touch_memories(ids: Vec<String>) -> Result<(), String> {
    if ids.is_empty() {
        return Ok(());
    }
    let stamp = now_ms();
    for m in list_memories() {
        if !ids.iter().any(|i| i == &m.id) {
            continue;
        }
        let updated = MemoryItem {
            last_accessed_at: stamp,
            access_count: m.access_count.saturating_add(1),
            ..m
        };
        let path = memory_dir().join(format!("{}.md", updated.id));
        write_atomic(&path, &render_md(&updated)).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> MemoryItem {
        MemoryItem {
            id: "t1".into(),
            character_id: "dsh-luna".into(),
            name: "主人喜欢喝美式".into(),
            content: "不加糖不加奶，早上喝。".into(),
            keys: vec!["咖啡".into(), "美式".into()],
            importance: 4,
            pinned: false,
            source: SOURCE_MANUAL.into(),
            source_ref: String::new(),
            created_at: 111,
            last_accessed_at: 222,
            access_count: 3,
        }
    }

    #[test]
    fn frontmatter_roundtrip() {
        let m = sample();
        let parsed = parse_md(&render_md(&m)).unwrap();
        assert_eq!(parsed.id, m.id);
        assert_eq!(parsed.character_id, m.character_id);
        assert_eq!(parsed.name, m.name);
        assert_eq!(parsed.content, m.content);
        assert_eq!(parsed.keys, m.keys);
        assert_eq!(parsed.importance, 4);
        assert_eq!(parsed.access_count, 3);
    }

    #[test]
    fn keys_split_on_cjk_punctuation() {
        assert_eq!(split_keys("咖啡，美式、拿铁 摩卡"), vec!["咖啡", "美式", "拿铁", "摩卡"]);
    }

    #[test]
    fn importance_is_clamped() {
        let mut m = sample();
        m.importance = 99;
        let text = render_md(&m);
        assert!(parse_md(&text).unwrap().importance <= 5);
    }

    #[test]
    fn missing_frontmatter_is_rejected() {
        assert!(parse_md("就是一段普通文字").is_none());
    }

    // ── B 链路的合并规则 ────────────────────────────────────────────

    fn item(op: &str, name: &str, content: &str) -> IngestItem {
        IngestItem {
            op: op.into(),
            id: String::new(),
            name: name.into(),
            content: content.into(),
            keys: Vec::new(),
            // None = "模型这次没提重要度"
            importance: None,
            character_id: String::new(),
            reason: String::new(),
            source_ref: String::new(),
        }
    }

    #[test]
    fn ingest_new_item_keeps_attribution() {
        let mut it = item("add", "主人喜欢美式", "不加糖不加奶。");
        it.character_id = "dsh-luna".into();
        it.keys = vec!["咖啡".into()];
        it.importance = Some(4);
        let merged = merge_item(None, &it);
        assert!(merged.id.is_empty(), "新条目的 id 交给 save_memory 生成");
        assert_eq!(merged.character_id, "dsh-luna");
        assert_eq!(merged.importance, 4);
        assert_eq!(merged.keys, vec!["咖啡"]);
        assert!(!merged.pinned);
        assert_eq!(merged.source, SOURCE_EXTRACT, "整理链路抽出来的必须标 extract");
    }

    #[test]
    fn source_roundtrip_and_merge_keeps_origin() {
        // frontmatter 里的 source 要能读回来
        let m = sample();
        assert_eq!(parse_md(&render_md(&m)).unwrap().source, SOURCE_MANUAL);

        // 整理链路更新一条主人手写的记忆：来路仍是 manual（不能把"哪来的"改掉）
        let old = sample();
        let it = item("update", "", "新内容");
        assert_eq!(merge_item(Some(&old), &it).source, SOURCE_MANUAL);

        // 老文件（没有 source 行）当手写算
        let legacy = "---\nid: old\nname: 老记忆\ncontent: 正文\n---\n内容\n";
        assert_eq!(parse_md(legacy).unwrap().source, SOURCE_MANUAL);
    }

    #[test]
    fn ingest_update_keeps_stats_and_old_fields_when_blank() {
        let old = sample();
        // 模型只改了内容，其它字段留空 —— 空的必须保留旧值，不能被清掉
        let it = item("update", "", "其实早上喝的是拿铁。");
        let merged = merge_item(Some(&old), &it);
        assert_eq!(merged.id, old.id);
        assert_eq!(merged.name, old.name);
        assert_eq!(merged.content, "其实早上喝的是拿铁。");
        assert_eq!(merged.character_id, old.character_id);
        assert_eq!(merged.access_count, old.access_count);
        assert_eq!(merged.created_at, old.created_at);
        assert_eq!(merged.keys, old.keys, "没给 keys 就该保住原来的触发词");
        assert_eq!(merged.importance, old.importance);
    }

    #[test]
    fn ingest_update_overwrites_when_provided() {
        let old = sample();
        let mut it = item("update", "主人改喝拿铁了", "只喝拿铁。");
        it.keys = vec!["拿铁".into()];
        it.importance = Some(5);
        it.character_id = "dsh-luna".into();
        let merged = merge_item(Some(&old), &it);
        assert_eq!(merged.name, "主人改喝拿铁了");
        assert_eq!(merged.keys, vec!["拿铁"]);
        assert_eq!(merged.importance, 5);
        // 统计量永远跟着旧记录走（不能被模型改写）
        assert_eq!(merged.access_count, old.access_count);
    }

    #[test]
    fn ingest_importance_is_clamped() {
        let mut it = item("add", "x", "y");
        it.importance = Some(9);
        assert_eq!(merge_item(None, &it).importance, 5);
        let mut it2 = item("add", "x", "y");
        it2.importance = Some(0);
        assert_eq!(merge_item(None, &it2).importance, 1);
        // 没给 → 新建用 3
        assert_eq!(merge_item(None, &item("add", "x", "y")).importance, 3);
    }

    #[test]
    fn resolve_prefers_id_then_falls_back_to_title() {
        // 真实库里 id 就是 safe_id(标题)（save_memory 生成的），照这个造样本
        let mut human = sample();
        human.id = safe_id("主人喜欢喝美式");
        let pool = vec![human.clone()];

        // ① id 命中
        let mut by_id = item("update", "随便写", "c");
        by_id.id = human.id.clone();
        assert_eq!(resolve_target(&pool, &by_id).map(|m| m.id.clone()), Some(human.id.clone()));

        // ② id 是编的，但标题对得上 → 也必须落在同一条上（否则会造重复/静默降级）
        let mut wrong_id = item("update", "主人喜欢喝美式", "c");
        wrong_id.id = "by-title".into();
        assert_eq!(
            resolve_target(&pool, &wrong_id).map(|m| m.id.clone()),
            Some(human.id.clone()),
            "id 对不上时要用标题兜底，这条是验收脚本抓出来的"
        );

        // ③ 只给标题、不给 id（模型最常见的写法）
        let mut by_name = item("update", "主人喜欢喝美式", "c");
        by_name.id = String::new();
        assert_eq!(resolve_target(&pool, &by_name).map(|m| m.id.clone()), Some(human.id.clone()));

        // ④ id 与标题都对不上 → 新条目
        let mut both = item("update", "改过的标题", "c");
        both.id = "nope".into();
        assert!(resolve_target(&pool, &both).is_none());
        let fresh = item("add", "全新的标题", "c");
        assert!(resolve_target(&pool, &fresh).is_none());
    }

    #[test]
    fn ingest_report_failure_carries_reason() {        let r = IngestReport::failed("没有可整理的对话");
        assert!(!r.ok);
        assert_eq!(r.error, "没有可整理的对话");
        // 序列化时空 error 应该被省掉（设置窗口靠 ok 判断）
        let ok = IngestReport {
            ok: true,
            added: 1,
            updated: 0,
            skipped: 0,
            error: String::new(),
            details: vec![],
        };
        let json = serde_json::to_string(&ok).unwrap();
        assert!(!json.contains("error"), "空 error 不该出现：{json}");
        assert!(json.contains("\"added\":1"));
    }

    #[test]
    fn ingest_item_defaults_are_forgiving() {
        // 模型只给 name/content，别的字段全缺 —— 不能因此整条丢掉
        let it: IngestItem = serde_json::from_str(r#"{"op":"add","name":"n","content":"c"}"#).unwrap();
        assert_eq!(it.importance, None, "缺 importance 必须是 None（=没说），不能悄悄给个默认值");
        assert!(it.keys.is_empty());
        assert_eq!(it.character_id, "");
        // camelCase 别名也要认（前端就是按 camelCase 传的）
        let it2: IngestItem =
            serde_json::from_str(r#"{"op":"add","name":"n","content":"c","characterId":"dsh-luna"}"#)
                .unwrap();
        assert_eq!(it2.character_id, "dsh-luna");
        // 前端省略 importance 时 JSON 里根本没有这个键 —— 那种情况也得是 None
        let it3: IngestItem =
            serde_json::from_str(r#"{"op":"update","id":"t1","content":"c"}"#).unwrap();
        assert_eq!(it3.importance, None);
    }

    /// 记忆文件坏掉时不能"悄悄消失"：要隔离成 `.bad-*` 并留日志线索。
    ///
    /// 症状本来是很难查的 —— list_memories 里 `if let Some(m) = parse_md(...)` 直接
    /// 跳过，于是这条记忆对注入、设置界面、整理去重**全部不可见**，而文件还好端端躺在
    /// 目录里。主人只会觉得"这条怎么没了"，翻目录又找得到。
    #[test]
    fn broken_memory_is_quarantined() {
        crate::tests::lock_test_data_dir();
        static LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
        let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());

        let dir = std::path::PathBuf::from(std::env::var("DSC_DATA_DIR").unwrap_or_default());
        std::fs::create_dir_all(&dir).unwrap();
        ensure_dir().unwrap();
        // 先清掉可能残留的同名文件（同一进程里重复跑不该互相干扰）
        for name in ["good.md", "broken.md"] {
            let _ = std::fs::remove_file(memory_dir().join(name));
        }
        if let Ok(entries) = std::fs::read_dir(memory_dir()) {
            for e in entries.flatten() {
                if e.file_name().to_string_lossy().starts_with("broken.md.bad-") {
                    let _ = std::fs::remove_file(e.path());
                }
            }
        }

        // 一份好的：必须照常读出来
        let good = MemoryItem {
            id: "good".into(),
            character_id: String::new(),
            name: "t".into(),
            content: "c".into(),
            keys: vec![],
            importance: 3,
            pinned: false,
            source: SOURCE_MANUAL.into(),
            source_ref: String::new(),
            created_at: 1,
            last_accessed_at: 0,
            access_count: 0,
        };
        write_atomic(&memory_dir().join("good.md"), &render_md(&good)).unwrap();
        // 一份坏的：frontmatter 都没有
        std::fs::write(memory_dir().join("broken.md"), b"no frontmatter here\n").unwrap();

        let list = list_memories();
        assert_eq!(list.len(), 1, "坏的那条不该进列表：{list:?}");
        assert_eq!(list[0].id, "good");
        assert!(!memory_dir().join("broken.md").exists(), "坏文件必须被隔离");
        let bads = std::fs::read_dir(memory_dir())
            .unwrap()
            .flatten()
            .filter(|e| e.file_name().to_string_lossy().starts_with("broken.md.bad-"))
            .count();
        assert_eq!(bads, 1, "应当留下一份 broken.md.bad-* 证据");
    }

    // ─────────────────── 权重衰减 ───────────────────
    //
    // 这一组盯的是"排序会不会把该记得的事挤掉"：老记忆该降权、pinned 不许降、
    // 被用到要回血、**再老也不许掉到 0**（掉到 0 等于偷偷删了它）。

    /// 基准"现在"：第 100 天。`idle_days` = 距上次被碰过多久。
    fn now_of() -> u64 {
        (100.0 * DAY_MS as f32) as u64
    }

    fn mk(importance: u8, idle_days: f32, hits: u32, pinned: bool) -> MemoryItem {
        let stamp = now_of() as f32 - idle_days * DAY_MS as f32;
        MemoryItem {
            id: "m1".into(),
            character_id: String::new(),
            name: "一条记忆".into(),
            content: "内容".into(),
            keys: vec!["x".into()],
            importance,
            pinned,
            source_ref: String::new(),
            source: SOURCE_MANUAL.into(),
            created_at: stamp.max(1.0) as u64,
            last_accessed_at: 0,
            access_count: hits,
        }
    }

    /// 时间越久越轻（同 importance）
    #[test]
    fn weight_fades_with_time() {
        let fresh = weight_of(&mk(3, 0.0, 0, false), now_of());
        let month = weight_of(&mk(3, 30.0, 0, false), now_of());
        let quarter = weight_of(&mk(3, 90.0, 0, false), now_of());
        assert!(fresh > month, "{fresh} 应该大于 {month}");
        assert!(month > quarter, "{month} 应该大于 {quarter}");
        // 半衰期就是 30 天：一个月后大致掉一半
        assert!(
            (month / fresh - 0.5).abs() < 0.05,
            "30 天该掉一半：{month}/{fresh}"
        );
    }

    /// **再老也不许掉到 0** —— 否则关键词正好命中的旧记忆永远浮不上来
    #[test]
    fn weight_never_drops_to_zero() {
        let ancient = weight_of(&mk(1, 3650.0, 0, false), now_of());
        assert!(ancient >= MIN_WEIGHT, "老记忆被压到 {ancient}");
        assert!(ancient > 0.0);
        // 一条 5 分的近期记忆仍然应该排在它前面（下限不是"平权到底"）
        let recent_high = weight_of(&mk(5, 1.0, 0, false), now_of());
        assert!(recent_high > ancient);
    }

    /// pinned 不衰减：主人钉住的就是"永远要记得"
    #[test]
    fn pinned_never_fades() {
        let p = weight_of(&mk(3, 999.0, 0, true), now_of());
        assert!((p - 3.0).abs() < 0.001, "pinned 该保持原分：{p}");
        let unpinned = weight_of(&mk(3, 999.0, 0, false), now_of());
        assert!(p > unpinned, "{p} 应该大于 {unpinned}");
    }

    /// 被用到就回血：访问次数多的老记忆能追上新的低分记忆
    #[test]
    fn hits_bring_memories_back() {
        let old_hot = weight_of(&mk(3, 60.0, 10, false), now_of());
        let old_cold = weight_of(&mk(3, 60.0, 0, false), now_of());
        assert!(old_hot > old_cold, "常被捞出来的该更重：{old_hot} vs {old_cold}");

        // 但访问加成有上限：不会让一条低分记忆永远霸榜
        let capped = weight_of(&mk(1, 0.0, 10_000, false), now_of());
        assert!(capped < 5.0, "加成必须封顶：{capped}");
    }

    /// 刷新时间基准：被访问过之后按"上次访问"算，不是按创建时间
    #[test]
    fn access_refreshes_the_clock() {
        let mut m = mk(4, 120.0, 0, false); // 创建于 120 天前
        let stale = weight_of(&m, now_of());
        m.last_accessed_at = now_of(); // 刚刚被用到
        let fresh = weight_of(&m, now_of());
        assert!(fresh > stale, "访问之后该回血：{fresh} vs {stale}");
        assert!((fresh - 4.0).abs() < 0.001, "刚访问过的应该拿满：{fresh}");
    }

    /// 时间倒流（系统时钟被改过 / 手改过文件）不许算出 NaN 或爆炸
    #[test]
    fn weight_survives_future_timestamps() {
        let mut m = mk(3, 0.0, 0, false);
        m.created_at = now_of() + 10 * DAY_MS;
        let w = weight_of(&m, now_of());
        assert!(w.is_finite() && w > 0.0, "{w}");
        assert!(w <= 3.5, "未来的时间戳不该让它无限涨：{w}");
    }
}
