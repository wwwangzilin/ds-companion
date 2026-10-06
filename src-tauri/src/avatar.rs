//! 立绘素材层：一个角色一张图。
//!
//! - **内置**：DeepSeek 娘（`assets/avatars/deepseek.png`，`include_bytes!` 编进 exe）。
//!   磁盘上没有对应文件时它兜底，所以内置角色开箱就有立绘。
//! - **用户上传**：自建角色在设置窗口里选图 → 落到 `<数据目录>/avatars/<角色id>.png`。
//!
//! 【为什么存文件而不是塞 config】立绘动辄 1MB 上下，base64 进 config.json 会让每次
//! push_config 都拖着它跑；而且 config.json 是文本配置，塞二进制是邋遢账。
//!
//! 【为什么内置素材编进 exe】这项目是「单 exe 分发」（release 只挂一个 exe）。素材放
//! 旁边意味着用户要再下一个文件、还可能漏。include_bytes! 把图钉进二进制，代价是
//! exe 大 1MB —— 换「装完就有立绘」值。

use crate::personas;

/// 内置角色 id。config.persona_id 为 None（= 用内置人设）时，页面用的就是它。
pub const BUILTIN_ID: &str = "dsh-deepseek";

// 内置立绘差分表 —— 由 build.rs 扫描 `assets/avatars/deepseek-*.png` 生成。
//
// 【为什么不能用 `///`】`include!` 是宏、不是 item，前面挂文档注释 Rust 会报
// "unused doc comment"。素材来源：gal-view 仓库的默认预设场景（MIT，
// Copyright (c) 2026 Yunicon）；原始那张是 `DeepSeek娘_立绘.png`（1024×1536），
// 现在的差分是 1280×1920 的重绘版，按表情拆开命名。
include!(concat!(env!("OUT_DIR"), "/avatar_assets.rs"));

/// 表情差分的变体名。
///
/// 【这是判定逻辑的一部分，别随手改名】变体名同时是**文件名**（`<id>-<变体>.png`），
/// 改一个字就等于让已经生成好的图全部对不上号。
/// 顺序也有意义：`neutral` 是兜底，永远得排第一。
pub const VARIANTS: &[&str] = &["neutral", "happy", "smug", "angry", "sad", "sleepy", "shy"];
pub const DEFAULT_VARIANT: &str = "neutral";

pub fn is_variant(v: &str) -> bool {
    VARIANTS.contains(&v)
}

/// 内置素材里有没有这个变体（素材还没生成齐时就是没有）。
fn builtin_png(variant: &str) -> Option<&'static [u8]> {
    BUILTIN_VARIANTS
        .iter()
        .find(|(v, _)| *v == variant)
        .map(|(_, b)| *b)
}

/// 单张上限，与 gal-view 的素材库同口径。再大只是拖慢 IPC。
pub const MAX_BYTES: usize = 8 * 1024 * 1024;

pub fn dir() -> std::path::PathBuf {
    personas::app_root().join("avatars")
}

/// 角色 id → 安全文件名：只留 ASCII 字母数字下划线连字符，其余压成 `-`。
///
/// 【为什么必须做】id 会变成磁盘路径的一段（`avatars/<id>.png`），而人设 id 由用户
/// 或 DSH preset 给，带 `..`、`/`、`:` 都不奇怪 —— 不洗就是路径穿越。
pub fn sanitize(id: &str) -> String {
    let mut out = String::with_capacity(id.len());
    for ch in id.chars() {
        if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' {
            out.push(ch);
        } else {
            out.push('-');
        }
    }
    let trimmed = out.trim_matches('-').to_string();
    if trimmed.is_empty() {
        "default".to_string()
    } else {
        trimmed
    }
}

pub fn path_of(id: &str) -> std::path::PathBuf {
    dir().join(format!("{}.png", sanitize(id)))
}

/// 带表情差分的文件名：`<id>-<变体>.png`（单图还是走 `path_of`，两者共存）。
pub fn variant_path(id: &str, variant: &str) -> std::path::PathBuf {
    dir().join(format!("{}-{}.png", sanitize(id), sanitize(variant)))
}

/// 某个角色**已经有**哪些变体的图（设置界面拿它显示"这角色配了几个表情"）。
pub fn variants_of(id: &str) -> Vec<String> {
    let mut out: Vec<String> = VARIANTS
        .iter()
        .filter(|v| has_variant(id, v))
        .map(|v| (*v).to_string())
        .collect();
    // 只有单图（没拆差分）时也如实说一声，别让界面显示成"什么都没有"
    if out.is_empty() && has_user(id) {
        out.push("single".to_string());
    }
    // 内置角色的差分编在 exe 里、不在用户目录 —— 不把它们算进来的话，
    // 界面上内置娘会显示成"一张差分都没有"，跟实际不符。
    if is_builtin(id) {
        for (v, _) in BUILTIN_VARIANTS {
            let s = (*v).to_string();
            if !out.contains(&s) {
                out.push(s);
            }
        }
    }
    out
}

/// 是不是「内置角色」（内置 id 或空 id 都算）。
pub fn is_builtin(id: &str) -> bool {
    id.trim().is_empty() || sanitize(id) == sanitize(BUILTIN_ID)
}

/// 用户为**某一个表情**单独传了图没。
///
/// 【跟 `has_user` 的区别】`has_user` 问的是"有没有那张单图"，这里问的是"这一格是不是
/// 他自己传的"。界面要靠后者决定「清掉这张」可不可点 —— 只传了单图时 7 个格子显示的
/// 都是同一张，但一个都不该能单独清掉。
pub fn has_variant(id: &str, variant: &str) -> bool {
    std::fs::metadata(variant_path(id, variant))
        .map(|m| m.len() > 0)
        .unwrap_or(false)
}

/// 有没有用户自己传的图（设置窗口据此决定「清除」按钮是否可点）。
pub fn has_user(id: &str) -> bool {
    std::fs::metadata(path_of(id))
        .map(|m| m.len() > 0)
        .unwrap_or(false)
}

/// 这一趟会用哪张图：`(来源, 实际用的变体)`。**只 stat，一个字节都不读。**
///
/// 【为什么要单开一条】桌宠每 60 秒自己拉一次状态，壳里 19 处 `push_config` 又各会 ping
/// 一次，而绝大多数时候是"手上那张没变"—— 那一趟根本不需要图。可原来的写法是**先把图
/// 读进来再问要不要**：读 ~2 MB、base64 成 2.7 MB 的 dataURL，然后当场丢掉。实测这条
/// 白走的路要 **48 ms**，而 `dsc_pet_state` 是**同步命令**（占着主线程），debug 构建下更明显。
///
/// 【它和 read_variant 的关系】那条现在**就是**先调这条问"用哪张"、再去读字节 ——
/// 回退顺序只有这一份，改这里不会跟它走散（`which_and_read_agree` 那条单测守着）。
///
/// 回退顺序：**用户的该变体 → 用户的单图 → 内置同变体 → 内置 neutral**。
pub fn which(id: &str, variant: &str) -> Option<(&'static str, String)> {
    let v = if is_variant(variant) {
        variant
    } else {
        DEFAULT_VARIANT
    };
    if has_variant(id, v) {
        return Some(("user", v.to_string()));
    }
    if has_user(id) {
        return Some(("user", "single".to_string()));
    }
    if is_builtin(id) {
        if builtin_png(v).is_some() {
            return Some(("builtin", v.to_string()));
        }
        if builtin_png(DEFAULT_VARIANT).is_some() {
            return Some(("builtin", DEFAULT_VARIANT.to_string()));
        }
    }
    None
}

/// 只读 PNG 头那 24 字节量宽高 —— 给"手上那张没变"那条路用，别为了两个数字把 2 MB 搬进来。
pub fn size_of(id: &str, source: &str, actual: &str) -> (u32, u32) {
    if source == "builtin" {
        return builtin_png(actual).map(png_size).unwrap_or((0, 0));
    }
    let p = if actual == "single" {
        path_of(id)
    } else {
        variant_path(id, actual)
    };
    let mut head = [0u8; 24];
    match std::fs::File::open(&p).and_then(|mut f| std::io::Read::read_exact(&mut f, &mut head)) {
        Ok(()) => png_size(&head),
        Err(_) => (0, 0),
    }
}

/// 读一张立绘（带表情变体），返回 `(字节, 来源, 实际用的变体)`。
///
/// 回退顺序见 `which`（这里只是照着它的结论去取字节，顺序不在两处各写一遍）。
///
/// 【为什么这么排】用户自己传的永远优先（他可能只传了一张单图，那所有表情都用它）；
/// 用户那边没有才落到内置；内置也没有这个变体（素材还没生成齐）就退到 neutral ——
/// 于是"只画了 neutral + happy 两张"也能正常跑，不会出现空白立绘。
pub fn read_variant(id: &str, variant: &str) -> Option<(Vec<u8>, &'static str, String)> {
    let (source, actual) = which(id, variant)?;
    let bytes = if source == "builtin" {
        builtin_png(&actual)?.to_vec()
    } else if actual == "single" {
        std::fs::read(path_of(id)).ok()?
    } else {
        std::fs::read(variant_path(id, &actual)).ok()?
    };
    if bytes.is_empty() {
        return None;
    }
    Some((bytes, source, actual))
}

/// 落盘一张用户上传的单图（临时文件 + rename，原子替换）。
pub fn save(id: &str, bytes: &[u8]) -> Result<(), String> {
    save_to(path_of(id), bytes)
}

/// 落盘某个变体的差分：`<id>-<变体>.png`。
pub fn save_variant(id: &str, variant: &str, bytes: &[u8]) -> Result<(), String> {
    if !is_variant(variant) {
        return Err(format!(
            "不认识的变体：{variant}（可用：{}）",
            VARIANTS.join(" / ")
        ));
    }
    save_to(variant_path(id, variant), bytes)
}

fn save_to(path: std::path::PathBuf, bytes: &[u8]) -> Result<(), String> {
    if bytes.is_empty() {
        return Err("空文件".to_string());
    }
    if bytes.len() > MAX_BYTES {
        return Err(format!(
            "图太大了（{} KB），上限 {} MB",
            bytes.len() / 1024,
            MAX_BYTES / 1024 / 1024
        ));
    }
    // 只认 PNG：立绘要透明底，而且统一格式省得再猜 mime。判魔数而不是后缀。
    if !bytes.starts_with(&[0x89, b'P', b'N', b'G']) {
        return Err("只支持 PNG（立绘需要透明背景）".to_string());
    }
    let dir = dir();
    std::fs::create_dir_all(&dir).map_err(|e| format!("建目录失败：{e}"))?;
    let tmp = path.with_extension("png.tmp");
    std::fs::write(&tmp, bytes).map_err(|e| format!("写图失败：{e}"))?;
    std::fs::rename(&tmp, &path).map_err(|e| format!("替换图失败：{e}"))
}

/// 删掉用户上传的单图并回到内置兜底。返回「本来有没有」。
pub fn clear(id: &str) -> Result<bool, String> {
    remove_if_exists(&path_of(id))
}

/// 删掉某个变体的差分。
pub fn clear_variant(id: &str, variant: &str) -> Result<bool, String> {
    remove_if_exists(&variant_path(id, variant))
}

/// 把这个角色的**所有**差分删掉（设置里点「清除」时连同单图一起处理）。
pub fn clear_all_variants(id: &str) -> Result<usize, String> {
    let mut n = 0usize;
    for v in VARIANTS {
        if remove_if_exists(&variant_path(id, v))? {
            n += 1;
        }
    }
    Ok(n)
}

fn remove_if_exists(path: &std::path::Path) -> Result<bool, String> {
    if !path.exists() {
        return Ok(false);
    }
    std::fs::remove_file(path).map_err(|e| format!("删除失败：{e}"))?;
    Ok(true)
}

/// 从 PNG 头里读宽高（IHDR 固定在第 16..24 字节，big-endian u32）。
/// 量不出来就回 0×0 —— 页面按 3:4 兜底，不该因为量不出尺寸就整张不显示。
pub fn png_size(bytes: &[u8]) -> (u32, u32) {
    if bytes.len() < 24 || !bytes.starts_with(&[0x89, b'P', b'N', b'G']) {
        return (0, 0);
    }
    let w = u32::from_be_bytes([bytes[16], bytes[17], bytes[18], bytes[19]]);
    let h = u32::from_be_bytes([bytes[20], bytes[21], bytes[22], bytes[23]]);
    (w, h)
}

/// data URL —— 页面 `<img src>` 直接吃。
pub fn to_data_url(bytes: &[u8]) -> String {
    format!("data:image/png;base64,{}", base64_encode(bytes))
}

// ─────────────────────── base64（手写，两个方向） ───────────────────────
//
// 【为什么手写】Cargo.toml 里没有 base64 crate，而这项目的取向是「离线也编得出来」
// —— 本机 cargo 缓存里没有的包等于编不出来。30 行表驱动比多一个依赖便宜。

const B64_TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/// 标准 base64（RFC 4648，带 `=` 填充）。
pub fn base64_encode(input: &[u8]) -> String {
    let mut out = String::with_capacity(input.len().div_ceil(3) * 4);
    for chunk in input.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = *chunk.get(1).unwrap_or(&0) as u32;
        let b2 = *chunk.get(2).unwrap_or(&0) as u32;
        let n = (b0 << 16) | (b1 << 8) | b2;
        out.push(B64_TABLE[(n >> 18) as usize & 63] as char);
        out.push(B64_TABLE[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 {
            B64_TABLE[(n >> 6) as usize & 63] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            B64_TABLE[n as usize & 63] as char
        } else {
            '='
        });
    }
    out
}

fn b64_val(c: u8) -> Option<u32> {
    match c {
        b'A'..=b'Z' => Some((c - b'A') as u32),
        b'a'..=b'z' => Some((c - b'a') as u32 + 26),
        b'0'..=b'9' => Some((c - b'0') as u32 + 52),
        b'+' => Some(62),
        b'/' => Some(63),
        _ => None,
    }
}

/// 宽容的 base64 解码：忽略换行/空白、忽略结尾的 `=`、遇到非法字符就报错。
pub fn base64_decode(input: &str) -> Result<Vec<u8>, String> {
    let mut acc: u32 = 0;
    let mut bits = 0u32;
    let mut out = Vec::with_capacity(input.len() / 4 * 3);
    for &c in input.as_bytes() {
        if c == b'=' || c.is_ascii_whitespace() {
            continue;
        }
        let Some(v) = b64_val(c) else {
            return Err(format!("base64 里有非法字符：{:?}", c as char));
        };
        acc = (acc << 6) | v;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((acc >> bits) as u8);
        }
    }
    Ok(out)
}

/// 剥掉 `data:image/png;base64,` 前缀（前端图省事直接递整条 dataURL 也认）。
pub fn strip_data_url(s: &str) -> &str {
    match s.find(";base64,") {
        Some(i) if s.starts_with("data:") => &s[i + 8..],
        _ => s,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sanitize_blocks_traversal() {
        assert_eq!(sanitize("../../etc/passwd"), "etc-passwd");
        // 中间连续的分隔符**故意不折叠**：折叠会把 `dsh--luna` 这类合法 id 撞成
        // `dsh-luna`，两个角色的立绘就串图了。这里只负责「防穿越」，不做美化。
        assert_eq!(sanitize("C:\\x\\y"), "C--x-y");
        assert_eq!(sanitize("dsh--luna"), "dsh--luna");
        assert_eq!(sanitize("luna"), "luna");
        assert_eq!(sanitize("dsh-luna_2"), "dsh-luna_2");
        assert_eq!(sanitize(""), "default");
        assert_eq!(sanitize("///"), "default");
        assert_eq!(sanitize(".."), "default");
    }

    #[test]
    fn builtin_recognition() {
        assert!(is_builtin(""));
        assert!(is_builtin("dsh-deepseek"));
        // 洗过之后等价的也认（免得用户传个带点的 id 就丢内置兜底）
        assert!(is_builtin("dsh.deepseek"));
        assert!(!is_builtin("luna"));
    }

    /// 内置素材的不变量：够大、竖构图、**差分之间尺寸一致**、变体名合法。
    ///
    /// 【为什么不再写死 1024×1536】素材是美术，会换 —— 这套从 1024×1536 换成了
    /// 1280×1920。写死尺寸的代价是「换一次素材就得改一次测试」，于是真换素材那次
    /// 被漏改，这条测试红着躺了好几天（换的是图，不是这段代码，所以谁都没去看它）。
    /// 测试该守的是「差分能互切」这个**不变量**，而不是某一张图的具体像素。
    #[test]
    fn builtin_sprites_are_consistent() {
        let neutral = builtin_png(DEFAULT_VARIANT).expect("内置素材里必须有 neutral");
        assert!(
            neutral.len() > 100_000,
            "内置立绘太小了，像是被压过：{} 字节",
            neutral.len()
        );
        let (w, h) = png_size(neutral);
        assert!(w >= 512 && h >= 768, "内置立绘尺寸可疑：{w}x{h}");
        // 立绘是竖构图；横过来或接近方形的一般是抓错图了
        assert!(h > w, "内置立绘该是竖构图，拿到 {w}x{h}");
        for &(v, bytes) in BUILTIN_VARIANTS {
            // 文件名拼错（如 deepseek-hapy.png）会被 build.rs 扫进这张表，但
            // `is_variant` 不认它 —— 页面永远选不中，等于白做一张图还没人发现。
            assert!(is_variant(v), "内置素材里有不是变体的名字：{v}（拼错了？）");
            // ★差分铁律★：尺寸不一致的话，切表情时会被看出缩放
            assert_eq!(
                png_size(bytes),
                (w, h),
                "变体 {v} 与 neutral 尺寸不一致，切表情会跳"
            );
        }
    }

    /// 变体名是判定逻辑的一部分：改名字 = 已生成好的图全部对不上号。
    #[test]
    fn variants_are_stable_and_neutral_first() {
        assert_eq!(VARIANTS[0], DEFAULT_VARIANT, "neutral 必须排第一（它是兜底）");
        assert!(is_variant("happy"));
        assert!(!is_variant("neutral2"));
        assert!(!is_variant(""));
        assert!(!is_variant("../etc"));
    }

    /// 差分文件名要洗过 —— 变体名同样会变成路径的一段。
    #[test]
    fn variant_path_is_sanitized() {
        assert!(variant_path("luna", "../../x").to_string_lossy().contains("luna-"));
        assert!(variant_path("a/b", "happy").to_string_lossy().ends_with("a-b-happy.png"));
    }

    /// `which`（只 stat）和 `read_variant`（真读）必须永远指向同一张、同一个变体名。
    ///
    /// 【为什么这条测试必须存在】这两条路是"回退顺序"的两半：`which` 决定用哪张、
    /// `read_variant` 照着去取字节。顺序一旦在某一半里被改歪，症状是**桌宠说变了、
    /// 图却没换**（或者反过来），而且只在有用户自定义立绘的机器上才现形。
    #[test]
    fn which_and_read_agree() {
        for v in VARIANTS {
            let w = which(BUILTIN_ID, v);
            let r = read_variant(BUILTIN_ID, v);
            assert_eq!(
                w.as_ref().map(|x| (x.0, x.1.clone())),
                r.as_ref().map(|x| (x.1, x.2.clone())),
                "内置角色的 {v}：which 和 read_variant 说的不是同一张"
            );
        }
        // 认不出的变体名要落到 neutral，而不是"没有图"
        assert_eq!(
            which(BUILTIN_ID, "根本没这个变体").map(|x| x.1),
            Some(DEFAULT_VARIANT.to_string())
        );
        assert_eq!(
            read_variant(BUILTIN_ID, "根本没这个变体").map(|x| x.2),
            Some(DEFAULT_VARIANT.to_string())
        );
    }

    /// 内置素材的宽高必须能**不读全文**量出来（`size_of` 就是给那条快路用的）。
    #[test]
    fn size_of_matches_png_size_on_builtin() {
        let full = builtin_png(DEFAULT_VARIANT).expect("内置素材里必须有 neutral");
        let want = png_size(full);
        assert_ne!(want, (0, 0), "内置 neutral 应该量得出尺寸");
        assert_eq!(size_of(BUILTIN_ID, "builtin", DEFAULT_VARIANT), want);
    }

    #[test]
    fn png_size_reads_ihdr() {
        assert_eq!(png_size(&[]), (0, 0));
        assert_eq!(png_size(b"not a png at all........"), (0, 0));
        assert_eq!(png_size(&[0x89, b'P', b'N', b'G', 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x02, 0x80, 0, 0, 0x03, 0x00]), (640, 768));
    }

    #[test]
    fn base64_roundtrip() {
        for case in [
            &b""[..],
            &b"f"[..],
            &b"fo"[..],
            &b"foo"[..],
            &b"foob"[..],
            &b"fooba"[..],
            &b"foobar"[..],
        ] {
            let enc = base64_encode(case);
            assert_eq!(base64_decode(&enc).unwrap(), case, "roundtrip failed: {enc}");
        }
        // RFC 4648 的标准样例
        assert_eq!(base64_encode(b"foobar"), "Zm9vYmFy");
        assert_eq!(base64_encode(b"fo"), "Zm8=");
        assert_eq!(base64_encode(b"f"), "Zg==");
    }

    #[test]
    fn base64_decode_is_lenient_but_not_silent() {
        assert_eq!(base64_decode("Zm9v\nYmFy").unwrap(), b"foobar");
        assert!(base64_decode("Zm9v!!").is_err());
    }

    #[test]
    fn strip_data_url_variants() {
        assert_eq!(strip_data_url("data:image/png;base64,AAAA"), "AAAA");
        assert_eq!(strip_data_url("AAAA"), "AAAA");
    }

    /// 二进制（含高字节）必须原样往返 —— 立绘是二进制，不是文本。
    #[test]
    fn base64_handles_high_bytes() {
        let bytes: Vec<u8> = (0u16..=255).map(|b| b as u8).collect();
        let enc = base64_encode(&bytes);
        assert_eq!(base64_decode(&enc).unwrap(), bytes);
    }
}
