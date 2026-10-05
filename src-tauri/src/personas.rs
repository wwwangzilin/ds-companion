//! 人设的存储与 DSH preset 导入。
//!
//! 落点（独立一份，不碰 ~/.dsh）：
//!   %APPDATA%\ds-companion\personas\<id>.md
//! 格式是 frontmatter + 正文，人可读、可 git、可用任何编辑器改：
//!
//!   ---
//!   id: nekomode
//!   name: 猫娘模式
//!   description: ...
//!   source: dsh:nekomode
//!   ---
//!   <人设正文>

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct Persona {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub description: String,
    /// manual | dsh:<preset id>
    #[serde(default)]
    pub source: String,
    /// 人设正文（注入时拼在用户消息前面）
    #[serde(default)]
    pub body: String,
    /// **她怎么称呼主人**（"主人"/名字/外号…）。空 = 不提，由人设正文自己定。
    ///
    /// 【为什么单独一栏】原来这个信息只活在正文里（`你是「露娜」，口头禅是「杂鱼」…`），
    /// 想换个称呼就得改人设正文、还可能把别的设定碰坏。它跟「关系阶段」是一对：
    /// 阶段决定**语气**，称呼决定**怎么叫**，两者一起进【关系】块。
    ///
    /// 注意它**不是** `call_names` 那个东西 —— 那个答的是"怎么叫她"。
    #[serde(default)]
    pub address: String,
}

#[derive(Serialize, Clone, Debug)]
pub struct DshPreset {
    pub id: String,
    pub name: String,
    pub description: String,
    pub chars: usize,
    pub imported: bool,
    /// 只有一行占位文本的 preset（真身在运行时插件里注入）
    pub stub: bool,
}

/// 应用数据根目录。
///
/// 优先级：`DSC_DATA_DIR`（**测试隔离用**）> `%APPDATA%\ds-companion` > `~/.ds-companion`。
///
/// 为什么要这个环境变量：验收脚本（.verify/*.mjs）做的是"真存真删"，而它们默认
/// 打在主人真实的记忆/人设/状态上 —— 实测 memory-trash 里堆了 100+ 条测试残留，
/// 还出现过 `*.testpollution-backup` 这种"先备份真实文件再跑测试"的痕迹。测试碰
/// 生产数据有两个后果：① 结果不可重复 ② 出了事分不清哪条是主人的、哪条是脚本的。
/// 所以脚本一律 `DSC_DATA_DIR=<临时目录>` 启动 app，真数据一个字节都不碰。
/// 数据目录的解析规则 —— **纯函数**，环境变量的读取在 `app_root()` 那一层。
///
/// 为什么要把"读环境"和"定规则"拆开：这条规则原来是靠"改环境变量再断言"来测的，
/// 而环境变量是**进程级**的 —— 并发跑的其他测试正好在这期间问 `app_root()`，
/// 就会拿到 `D:/tmp/dsc-isolated` 这种假目录。实测后果：config 的坏文件用例间歇性
/// 失败，报"没留下 .bad-* 证据"（坏文件写到了假目录，证据却在真目录里找）。
/// 拆成纯函数之后，规则本身可以被直接测，谁都不用动环境。
fn resolve_app_root(dir: Option<&str>, appdata: Option<&str>, home: Option<&str>) -> PathBuf {
    if let Some(d) = dir {
        if !d.trim().is_empty() {
            return PathBuf::from(d.trim());
        }
    }
    if let Some(a) = appdata {
        if !a.is_empty() {
            return Path::new(a).join("ds-companion");
        }
    }
    // 兜底：用户主目录
    Path::new(home.unwrap_or(".")).join(".ds-companion")
}

/// 平台注入的数据根目录（目前只有 Android 用）。
///
/// 为什么需要它：`resolve_app_root` 的三条路在手机上**全是坏的** —— 没有
/// `DSC_DATA_DIR`、没有 `%APPDATA%`、也没有 `USERPROFILE`，最后落到相对路径
/// `./.ds-companion`，而 app 进程的 CWD 在 Android 上不可写。结果是配置、状态、
/// 记忆、对话记录、提案**全部写不进去**。所以 setup 拿到 AppHandle 之后把
/// `app_data_dir()` 注入进来。
///
/// 为什么不用环境变量（`std::env::set_var("APPDATA", ...)`）：那是进程级可变状态，
/// setup 阶段可能已经有别的线程在跑，改它属于数据竞争；而且会污染别处对 APPDATA
/// 的判断（那是个 Windows 语义的名字）。
static APP_ROOT_OVERRIDE: OnceLock<PathBuf> = OnceLock::new();

/// 由 setup 在 Android 上调用。只生效一次；桌面端不调。
pub fn set_app_root_override(p: PathBuf) {
    let _ = APP_ROOT_OVERRIDE.set(p);
}

pub fn app_root() -> PathBuf {
    // ① 测试隔离开关压过一切：验收脚本靠它一个字节都不碰主人的真数据
    if let Ok(d) = std::env::var("DSC_DATA_DIR") {
        if !d.trim().is_empty() {
            return PathBuf::from(d.trim());
        }
    }
    // ② 平台注入的（Android：app 私有目录）
    if let Some(p) = APP_ROOT_OVERRIDE.get() {
        return p.clone();
    }
    // ③ 桌面：%APPDATA%\ds-companion > ~/.ds-companion
    resolve_app_root(
        None,
        std::env::var("APPDATA").ok().as_deref(),
        std::env::var("USERPROFILE").ok().as_deref(),
    )
}

// ───────────────── 坏文件不静默 + 回收站不无限长（数据纪律） ─────────────────

/// 回收站保留份数：软删除的备份只留最近这么多份，多余的按时间戳删掉。
///
/// 不设上限的后果是实测过的：memory-trash 攒了 100+ 个文件、personas-trash 26 个，
/// 全是"每次删各留一份"堆出来的。回收站不是归档，它只负责"刚删错还能捞回来"。
pub const TRASH_KEEP: usize = 50;

fn now_stamp() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// 辅助日志：跟主日志（%TEMP%\ds-companion.log）分开写，省得每个模块都要拿 AppHandle。
///
/// 【为什么不能让"隔离"来关掉它】这里有个真实的坑：早先的版本在 `DSC_DATA_DIR` 生效时
/// 把日志改写到 stderr —— 本意是"别在主人机器上留文件"。但验收入口 verify-run.ps1 正是用
/// 隔离数据启动的，而 GUI 子系统**没有 stderr**：于是工具调用的审计记录（谁在什么时候读了
/// 哪个文件）在**最需要它的那一次运行里**全部无声消失（实测：24 项验收全绿，日志里
/// `tool=` 一条都没有）。审计是账本，不能挑环境。
///
/// 现在只有真正的单元测试才走 stderr（`DSC_UNIT_TEST=1` 由单测进程启动时设置），
/// 其余一律落文件。
pub fn aux_log(line: &str) {
    let text = format!("[{}] {line}\n", now_stamp());
    if std::env::var("DSC_UNIT_TEST").map(|v| v == "1").unwrap_or(false) {
        eprint!("{text}");
        return;
    }
    use std::io::Write;
    let mut p = std::env::temp_dir();
    p.push("ds-companion.log");
    if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(&p) {
        let _ = f.write_all(text.as_bytes());
    }
}

/// 文件在但**读不成**时，别悄悄退回默认值。
///
/// 原来的写法是 `serde_json::from_str(&text).unwrap_or_default()`：配置一坏，
/// 激活的人设变 None、好感度归零，日志里一个字都没有 —— 主人只会看到"她怎么突然
/// 不认识我了"。现在改成：把坏文件改名到 `<名>.bad-<戳>`（留证据，且不会被下一次
/// 保存覆盖），写一行日志，然后才用默认值启动。
///
/// 返回 true 表示确实隔离了一个坏文件（文件不存在不算）。
pub fn recover_bad_file(path: &Path, reason: &str) -> bool {
    if !path.exists() {
        return false;
    }
    let mut backup = path.as_os_str().to_os_string();
    backup.push(format!(".bad-{}", now_stamp()));
    let backup = PathBuf::from(backup);
    match fs::rename(path, &backup) {
        Ok(_) => {
            aux_log(&format!(
                "[recover] {} 解析失败（{reason}），已隔离为 {}，本次用默认值启动",
                path.display(),
                backup.display()
            ));
            true
        }
        Err(e) => {
            aux_log(&format!(
                "[recover] {} 解析失败（{reason}）且隔离失败（{e}）—— 它可能被下一次保存覆盖，请手动备份",
                path.display()
            ));
            false
        }
    }
}

/// 回收站只留最近 `TRASH_KEEP` 份，多的删掉。只动 trash 目录，绝不碰正本。
///
/// 排序优先按**文件名里的时间戳**而不是 mtime：文件名的时间戳是稳定的，而 robocopy
/// / 各种备份工具会把 mtime 改得乱七八糟。认不出来（老格式）就退回 mtime，总之不能
/// 因为"认不出"就永远不清理。
pub fn prune_trash(dir: &Path) -> usize {
    let Ok(entries) = fs::read_dir(dir) else {
        return 0;
    };
    let mut files: Vec<(u64, PathBuf)> = Vec::new();
    for e in entries.flatten() {
        let p = e.path();
        if !p.is_file() {
            continue;
        }
        let stem = p.file_name().and_then(|s| s.to_str()).unwrap_or("");
        let stamp = stem
            .rsplit(['-', '.'])
            .find_map(|seg| {
                let digits: String = seg.chars().take_while(|c| c.is_ascii_digit()).collect();
                if digits.len() >= 9 {
                    digits.parse::<u64>().ok()
                } else {
                    None
                }
            })
            .or_else(|| {
                e.metadata()
                    .ok()
                    .and_then(|m| m.modified().ok())
                    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|d| d.as_millis() as u64)
            })
            .unwrap_or(0);
        files.push((stamp, p));
    }
    if files.len() <= TRASH_KEEP {
        return 0;
    }
    files.sort_by_key(|(stamp, _)| *stamp);
    let drop_count = files.len() - TRASH_KEEP;
    let mut removed = 0;
    for (_, p) in files.into_iter().take(drop_count) {
        if fs::remove_file(&p).is_ok() {
            removed += 1;
        }
    }
    if removed > 0 {
        aux_log(&format!(
            "[trash] {} 超过 {TRASH_KEEP} 份，清掉最旧的 {removed} 份",
            dir.display()
        ));
    }
    removed
}

pub fn personas_dir() -> PathBuf {
    app_root().join("personas")
}

/// 把**所有**回收站按上限清一遍，返回清掉的总数。
///
/// 为什么需要它：`prune_trash` 平时只在"又删了一个东西"时才顺手跑，
/// 也就是说已经堆到 100+ 份的历史垃圾不会自己消失，上限形同虚设。
/// 设置界面「整理回收站」按一下走这条。
pub fn prune_all_trash() -> usize {
    let root = app_root();
    let mut removed = 0;
    for name in [
        "memory-trash",
        "personas-trash",
        "state-trash",
        "proposals-trash",
    ] {
        removed += prune_trash(&root.join(name));
    }
    removed
}

/// 隔离状态自报（启动时打印一行，专供事后排查"这次跑的到底是哪份数据"）
pub fn scope_line() -> String {
    let isolated = std::env::var("DSC_DATA_DIR")
        .map(|v| !v.trim().is_empty())
        .unwrap_or(false);
    format!(
        "data-dir={} isolated={}",
        app_root().display(),
        isolated
    )
}

pub fn ensure_dirs() -> std::io::Result<()> {
    fs::create_dir_all(personas_dir())
}

/// FNV-1a 32：给纯非 ASCII 的名字（如「猫娘」）生成稳定、干净的文件名后缀。
pub fn fnv1a32(text: &str) -> u32 {
    let mut hash: u32 = 0x811c9dc5;
    for b in text.as_bytes() {
        hash ^= *b as u32;
        hash = hash.wrapping_mul(0x01000193);
    }
    hash
}

/// 只留安全的字符，避免路径穿越 / 非法文件名 / 控制台打不出来的名字。
/// ASCII 部分照抄，非 ASCII（中文等）不塞进文件名，整名退化成 `p-<hash>`。
pub fn safe_id(raw: &str) -> String {
    let mut out = String::new();
    let mut ascii_seen = false;
    for ch in raw.chars() {
        if ch.is_ascii_alphanumeric() {
            out.push(ch.to_ascii_lowercase());
            ascii_seen = true;
        } else if ch == '-' || ch == '_' || ch == ' ' || ch == '.' {
            out.push('-');
        }
    }
    while out.contains("--") {
        out = out.replace("--", "-");
    }
    let out = out.trim_matches('-').to_string();
    if ascii_seen && !out.is_empty() {
        out
    } else {
        format!("p-{:08x}", fnv1a32(raw))
    }
}

/// 原子写：临时文件 + rename（照 Quill / DSHrestore 的教训）
fn write_atomic(path: &Path, data: &str) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    let tmp = path.with_extension("tmp-write");
    fs::write(&tmp, data.as_bytes())?;
    fs::rename(&tmp, path)
}

fn parse_persona_md(text: &str) -> Option<Persona> {
    let mut lines = text.lines().peekable();
    // 跳过开头的空行
    while matches!(lines.peek(), Some(l) if l.trim().is_empty()) {
        lines.next();
    }
    if lines.peek().map(|l| l.trim()) != Some("---") {
        return None;
    }
    lines.next();
    let mut id = String::new();
    let mut name = String::new();
    let mut description = String::new();
    let mut source = String::new();
    let mut address = String::new();
    for line in lines.by_ref() {
        if line.trim() == "---" {
            break;
        }
        if let Some((k, v)) = line.split_once(':') {
            let v = v.trim().trim_matches('"').to_string();
            match k.trim() {
                "id" => id = v,
                "name" => name = v,
                "description" => description = v,
                "source" => source = v,
                "address" => address = v,
                _ => {}
            }
        }
    }
    let body = lines.collect::<Vec<_>>().join("\n").trim().to_string();
    if id.is_empty() {
        return None;
    }
    Some(Persona {
        address,
        id,
        name: if name.is_empty() { "未命名".into() } else { name },
        description,
        source,
        body,
    })
}

/// 存成人设文件（frontmatter + 正文）。
///
/// 【★加字段必须同时改这里和 `parse_persona_md`★】这两处是手写的，不是 serde 自动的 ——
/// 新字段只要漏在这张清单里，就会"界面上填得进去、存下去就没了"，而且**一声不响**。
/// `address`（她怎么称呼主人）就是这么丢过一次的：验收脚本填了「主人」、关系块里却没有，
/// 一路查到这儿才发现。所以下面那条 `frontmatter_keeps_every_field` 用**非空值**挨个比对。
fn render_persona_md(p: &Persona) -> String {
    format!(
        "---\nid: {}\nname: {}\ndescription: {}\nsource: {}\naddress: {}\n---\n{}\n",
        p.id, p.name, p.description, p.source, p.address, p.body
    )
}

// ─────────────────── 出厂默认角色 & 「不注入」────────────────────
//
// 【语义（三态）】`config.active_persona`：
//   · `None`（从没选过 / 清空过）→ **出厂默认角色**（DeepSeek 娘）。她有自己的状态与记忆。
//   · `Some(PERSONA_OFF)`        → **原版**：人设不注入，状态/回锚块也不注（那都是"她"的东西），
//                                   只剩工具与记忆里那些全局条目 —— 就是没装这个软件时的样子。
//   · `Some(id)`                 → 那个人设。
//
// 【为什么默认角色必须住在代码里】它的意义是"就算你把数据目录清空、换台机器，也总有一个能说话的
// 默认角色"。放在 personas 目录里就意味着它能被删掉/忘拷贝 —— 那"默认"就不成立了。
// 但**允许被定制**：磁盘上真有同 id 的文件时以文件为准（主人可以改她、也可以覆盖她）。

/// 出厂默认角色的 id
pub const BUILTIN_ID: &str = "dsh-deepseek";
/// 「不注入人设」这个选择在配置里的值（原版 DeepSeek）
pub const PERSONA_OFF: &str = "off";

/// 出厂默认角色的定义（编译进二进制，见文件头的理由）
const BUILTIN_MD: &str = include_str!("../builtin/deepseek.md");

/// 出厂默认角色。磁盘上有同 id 的就以磁盘为准（允许主人改她）。
pub fn builtin_persona() -> Persona {
    if let Some(p) = get_persona(BUILTIN_ID) {
        return p;
    }
    parse_persona_md(BUILTIN_MD).unwrap_or_else(|| Persona {
        address: String::new(),
        id: BUILTIN_ID.into(),
        name: "DeepSeek 娘".into(),
        description: String::new(),
        source: "builtin".into(),
        body: BUILTIN_MD.into(),
    })
}

/// 取一个人设（磁盘优先、默认角色兜底）。设置界面点开默认角色时要能拿到她的正文。
pub fn get_persona_any(id: &str) -> Option<Persona> {
    if safe_id(id) == BUILTIN_ID {
        return Some(builtin_persona());
    }
    get_persona(id)
}

/// **当前实际生效**的人设（注入链路唯一的入口）。
///
/// 配置里指着一个不存在的人设时**退回默认角色**而不是什么都不注：那种情况下
/// 主人看到的是"我的角色没了"，而退回默认至少还能说话，而且设置页里那个 id 一眼就能看出是错的。
pub fn effective_persona(active: Option<&str>) -> Option<Persona> {
    match active.map(str::trim) {
        Some(id) if id == PERSONA_OFF => None,
        Some(id) if !id.is_empty() => get_persona(id).or_else(|| Some(builtin_persona())),
        // None / 空串 = 没选过 → 出厂默认
        _ => Some(builtin_persona()),
    }
}

/// 当前生效的 `character_id`（状态文件与记忆的角色维度都按它归档）。
///
/// 三种情况分开是**有意的**：选原版时返回空串 —— 空串在注入链路里意味着
/// "没有角色身份"，于是状态块、回锚块、角色记忆全都不参与，正是"原版"该有的样子。
pub fn active_character_id(active: Option<&str>) -> String {
    match active.map(str::trim) {
        Some(id) if id == PERSONA_OFF => String::new(),
        Some(id) if !id.is_empty() => id.to_string(),
        _ => BUILTIN_ID.to_string(),
    }
}

/// 当前角色**可以被呼唤的名字**（"叫她的名字也算亲密"）。
///
/// 【为什么从正文里抽，而不是加配置项】所有人的设第一行都是同一个约定：
/// `你是「露娜」（Luna），…` / `你是「铃」（Suzu），…` —— 名字就在第一处 `「」` 里。
/// 加一个配置字段意味着每换一个角色都要重新填一遍，而约定已经在那儿了。
///
/// 【它修的是什么】`state.rs` 的呼唤词表里曾经**硬编码了「露娜」**：只有叫她名字
/// 才算亲密（好感 +0.5、解锁"第一次叫我主人"）。换个角色就叫不动她 —— 那是唯一一处
/// 引擎级偏心，文案再怎么改都追不上。现在名字由人设决定。
///
/// 抽不到就返回空：呼唤判定退回通用词（"在吗""在不在"），**不会**因为抽不到而误判。
pub fn call_names(active: Option<&str>) -> Vec<String> {
    // 原版（不注入人设）没有角色身份，也就没有名字
    let Some(p) = effective_persona(active) else {
        return Vec::new();
    };
    let line = p.body.lines().next().unwrap_or("");
    let mut out = Vec::new();
    if let Some(name) = first_quoted(line) {
        out.push(name);
    }
    // `你是「露娜」（Luna）` 里的英文名也认 —— 主人可能直接打 Luna
    if let Some(en) = first_paren_ascii(line) {
        out.push(en);
    }
    out
}

/// 一行里第一处 `「…」` 的内容（人设名字的稳定约定）。
/// 太长的不算名字（那是引文），宁可抽不到也不要把一段话当名字。
fn first_quoted(line: &str) -> Option<String> {
    let start = line.find('「')? + '「'.len_utf8();
    let rest = &line[start..];
    let end = rest.find('」')?;
    let name = rest[..end].trim();
    if name.is_empty() || name.chars().count() > 12 {
        return None;
    }
    Some(name.to_string())
}

/// 紧随其后的 `（Luna）` 里的 ASCII 名字。只认全 ASCII —— 中文括注多半是解释不是名字。
fn first_paren_ascii(line: &str) -> Option<String> {
    let start = line.find('（')? + '（'.len_utf8();
    let rest = &line[start..];
    let end = rest.find('）')?;
    let name = rest[..end].trim();
    if name.is_empty()
        || !name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == ' ' || c == '-' || c == '_')
    {
        return None;
    }
    Some(name.to_string())
}

pub fn list_personas() -> Vec<Persona> {
    let mut out = Vec::new();
    let dir = personas_dir();
    let Ok(entries) = fs::read_dir(&dir) else {
        // 目录都读不了（第一次跑）：至少把出厂默认给出去，别给一个空列表
        return vec![builtin_persona()];
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("md") {
            continue;
        }
        if let Ok(text) = fs::read_to_string(&path) {
            if let Some(p) = parse_persona_md(&text) {
                out.push(p);
            }
        }
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    // 出厂默认永远在第一个：它不在 personas 目录里，但界面/托盘菜单里必须选得到
    // （磁盘上真存过同 id 的话它就已经在列表里了，别重复插）
    if !out.iter().any(|p| p.id == BUILTIN_ID) {
        out.insert(0, builtin_persona());
    }
    out
}

pub fn get_persona(id: &str) -> Option<Persona> {
    let path = personas_dir().join(format!("{}.md", safe_id(id)));
    fs::read_to_string(path).ok().and_then(|t| parse_persona_md(&t))
}

pub fn save_persona(persona: &Persona) -> Result<Persona, String> {
    let id = safe_id(if persona.id.is_empty() { &persona.name } else { &persona.id });
    let path = personas_dir().join(format!("{id}.md"));
    // 已存在时保留原 source（编辑不该把导入来源抹掉）
    let source = if persona.source.is_empty() {
        get_persona(&id).map(|p| p.source).unwrap_or_default()
    } else {
        persona.source.clone()
    };
    let saved = Persona {
        // ★这里必须**透传**主人的输入，不能是 `String::new()`★
        //
        // 【为什么单独写一句】这个字面量是"保存的真相"：写成空串就等于
        // "界面上填得进去、存下去就没了"。而批量补字段的脚本补出来的正是空串 ——
        // 它只保证"字段在"（编译过），不保证值对。验收脚本抓到的就是这一处。
        address: persona.address.trim().to_string(),
        id: id.clone(),
        name: persona.name.trim().to_string(),
        description: persona.description.trim().to_string(),
        source: if source.is_empty() { "manual".into() } else { source },
        body: persona.body.clone(),
    };
    if saved.name.is_empty() {
        return Err("名字不能为空".into());
    }
    write_atomic(&path, &render_persona_md(&saved)).map_err(|e| e.to_string())?;
    Ok(saved)
}

pub fn delete_persona(id: &str) -> Result<(), String> {
    let path = personas_dir().join(format!("{}.md", safe_id(id)));
    if !path.exists() {
        return Err("人设不存在".into());
    }
    // 先进回收站目录，别真删（主人的东西不静默销毁）
    let trash = app_root().join("personas-trash");
    fs::create_dir_all(&trash).map_err(|e| e.to_string())?;
    // 毫秒（原来是秒）：同一秒里连删两次会撞名，而且 prune_trash 靠这个数字排序
    let stamp = now_stamp();
    let dest = trash.join(format!("{}-{}.md", safe_id(id), stamp));
    fs::rename(&path, &dest).map_err(|e| e.to_string())?;
    prune_trash(&trash);
    Ok(())
}

// ─────────────────────────── DSH preset 导入 ───────────────────────────────

fn dsh_presets_dir() -> PathBuf {
    let home = std::env::var("USERPROFILE").unwrap_or_else(|_| ".".into());
    Path::new(&home).join(".dsh").join(".agent-presets")
}

fn unquote(s: &str) -> String {
    let t = s.trim();
    if t.len() >= 2
        && ((t.starts_with('"') && t.ends_with('"')) || (t.starts_with('\'') && t.ends_with('\'')))
    {
        t[1..t.len() - 1].to_string()
    } else {
        t.to_string()
    }
}

/// 从 agent.cordis.yml 里抽 `- id: persona` 行的 prefix 文本。
/// 两种写法都吃（都实测存在）：`prefix: |-` 多行字面块、`prefix: 一句话` 单行标量。
/// 这套逻辑与原来的 Node 版逐行对应，现在只留 Rust 这一份真相。
pub fn extract_persona_prefix(yaml: &str) -> Option<String> {
    let lines: Vec<&str> = yaml.split('\n').map(|l| l.trim_end_matches('\r')).collect();
    let mut i = 0;
    let mut persona_indent = 0usize;
    while i < lines.len() {
        let t = lines[i].trim();
        if t.starts_with("- id:") && t["- id:".len()..].trim() == "persona" {
            persona_indent = lines[i].len() - lines[i].trim_start().len();
            break;
        }
        i += 1;
    }
    if i >= lines.len() {
        return None;
    }
    // 从 persona 行的**下一行**开始找 prefix。
    // （曾经写成从本行开始扫，一进去就撞上「下一个 - id:」判断而立刻 break ——
    //   真文件里 persona 行不在第一行，所以线上永远扫不到；单测把 persona 放在第 1 行才侥幸通过。）
    let mut j = i + 1;
    while j < lines.len() {
        let line = lines[j];
        let trimmed = line.trim_start();
        let indent = line.len() - trimmed.len();
        if let Some(rest) = trimmed.strip_prefix("prefix:") {
            let inline = rest.trim();
            let is_block = inline.starts_with('|') || inline.starts_with('>');
            if !inline.is_empty() && !is_block {
                return Some(unquote(inline));
            }
            let content_indent = indent + 2;
            let mut out: Vec<String> = Vec::new();
            for l in lines.iter().skip(j + 1) {
                if l.trim().is_empty() {
                    out.push(String::new());
                    continue;
                }
                let lead = l.len() - l.trim_start().len();
                if lead < content_indent {
                    if lead <= indent {
                        break;
                    }
                    out.push(l.trim_start().to_string());
                    continue;
                }
                out.push(l.chars().skip(content_indent).collect());
            }
            while matches!(out.last(), Some(s) if s.is_empty()) {
                out.pop();
            }
            return Some(out.join("\n"));
        }
        // 缩进回到 persona 行同级或更浅的下一个条目 = 这个 persona 行没有 prefix
        if trimmed.starts_with("- ") && indent <= persona_indent {
            break;
        }
        j += 1;
    }
    None
}

fn scalar(yml: &str, key: &str) -> Option<String> {
    for line in yml.lines() {
        if let Some(rest) = line.strip_prefix(&format!("{key}:")) {
            return Some(unquote(rest));
        }
    }
    None
}

pub fn scan_dsh_presets() -> Vec<DshPreset> {
    let dir = dsh_presets_dir();
    let mut out = Vec::new();
    let Ok(entries) = fs::read_dir(&dir) else {
        return out;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_dir() {
            continue;
        }
        let id = entry.file_name().to_string_lossy().to_string();
        if id.contains(".bak") {
            continue;
        }
        let Ok(cordis) = fs::read_to_string(path.join("agent.cordis.yml")) else {
            continue;
        };
        let Some(persona) = extract_persona_prefix(&cordis) else {
            continue;
        };
        let meta = fs::read_to_string(path.join("preset.yml")).unwrap_or_default();
        let chars = persona.chars().count();
        out.push(DshPreset {
            id: id.clone(),
            name: scalar(&meta, "name").unwrap_or_else(|| id.clone()),
            description: scalar(&meta, "description").unwrap_or_default(),
            chars,
            imported: personas_dir().join(format!("dsh-{}.md", safe_id(&id))).exists(),
            // 只有一行、且没有 {{变量}}，基本就是运行时插件再注入真身的占位
            stub: !persona.contains('\n') && persona.chars().count() < 200,
        });
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    out
}

pub fn import_dsh_preset(preset_id: &str) -> Result<Persona, String> {
    let preset = scan_dsh_presets()
        .into_iter()
        .find(|p| p.id == preset_id)
        .ok_or_else(|| format!("找不到 preset: {preset_id}"))?;
    let cordis = fs::read_to_string(dsh_presets_dir().join(&preset.id).join("agent.cordis.yml"))
        .map_err(|e| e.to_string())?;
    let body = extract_persona_prefix(&cordis).ok_or_else(|| "这个人设行没有 prefix".to_string())?;
    let persona = Persona {
        address: String::new(),
        id: format!("dsh-{}", safe_id(&preset.id)),
        name: preset.name.clone(),
        description: preset.description.clone(),
        source: format!("dsh:{}", preset.id),
        body,
    };
    save_persona(&persona)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn block_prefix() {
        let yaml = "- id: persona\n  name: '@x'\n  config:\n    prefix: |-\n      第一行\n\n      第二行\n- id: next\n";
        assert_eq!(
            extract_persona_prefix(yaml).unwrap(),
            "第一行\n\n第二行"
        );
    }

    /// ★存盘/读回一个字段都不能丢★（`address` 就是被漏掉过一次的那个）。
    ///
    /// 【为什么必须用非空值】第一版这条测试（frontmatter_roundtrip）用的是
    /// `address: String::new()` —— 空值丢不丢都一样，所以它绿着，bug 活着。
    /// 存盘清单是手写的，这类"新字段没进清单"的错只能靠**逐字段非空比对**抓住。
    #[test]
    fn frontmatter_keeps_every_field() {
        let p = Persona {
            id: "p-verify".into(),
            name: "露娜".into(),
            description: "小恶魔".into(),
            source: "manual".into(),
            address: "主人".into(),
            body: "你是「露娜」，一个……".into(),
        };
        let md = render_persona_md(&p);
        assert!(md.contains("address: 主人"), "frontmatter 里得有 address：\n{md}");
        let back = parse_persona_md(&md).expect("该能读回来");
        assert_eq!(back.address, "主人", "★address 丢了★");
        assert_eq!(back.id, "p-verify");
        assert_eq!(back.name, "露娜");
        assert_eq!(back.description, "小恶魔");
        assert_eq!(back.source, "manual");
        assert_eq!(back.body, "你是「露娜」，一个……");
    }

    /// 回归：persona 行**不在**第一行时必须照样能扫到。
    /// 真文件（nekomode/agent.cordis.yml）里它在第 26 行 —— 老实现就是在这一点上
    /// 线上全瞎、而「persona 放第一行」的单测依旧全绿。
    #[test]
    fn prefix_when_persona_row_is_not_first() {
        let yaml = "\
# 一段注释
- id: host-thing
  name: '@deepseek-ai/dsh-x'

# ── identity ──
- id: persona
  name: '@deepseek-ai/dsh-persona'
  config:
    prefix: |-
      你是「小喵」喵~，
      第二行。
- id: agent-instructions
  name: '@deepseek-ai/dsh-agent-instructions'
";
        let got = extract_persona_prefix(yaml).unwrap();
        assert!(got.starts_with("你是「小喵」"), "got: {got:?}");
        assert!(got.contains("第二行。"), "got: {got:?}");
        assert!(!got.contains("agent-instructions"), "扫过头了: {got:?}");
    }

    /// 回归：内联 prefix 且 persona 行不在第一行
    #[test]
    fn inline_prefix_not_first() {
        let yaml = "- id: a\n  name: x\n- id: persona\n  config:\n    prefix: 一行人设\n- id: b\n";
        assert_eq!(extract_persona_prefix(yaml).unwrap(), "一行人设");
    }

    /// persona 行没有 prefix 时要干净地返回 None（别往前/往后误吞）
    #[test]
    fn persona_without_prefix_returns_none() {
        let yaml = "- id: a\n- id: persona\n  name: '@x'\n- id: b\n  config:\n    prefix: 不属于 persona\n";
        assert!(extract_persona_prefix(yaml).is_none());
    }

    #[test]
    fn inline_prefix() {
        let yaml = "- id: persona\n  name: '@x'\n  config:\n    prefix: You are a helpful assistant.\n";
        assert_eq!(
            extract_persona_prefix(yaml).unwrap(),
            "You are a helpful assistant."
        );
    }

    #[test]
    fn no_persona_row() {
        assert!(extract_persona_prefix("- id: other\n  name: '@y'\n").is_none());
    }

    #[test]
    fn id_is_safe() {
        // 路径穿越必须被吃掉
        assert_eq!(safe_id("../../etc/passwd"), "etcpasswd");
        assert_eq!(safe_id("Hello World"), "hello-world");
        // 纯中文不给丑文件名，退回稳定短哈希（同名同 id，幂等）
        let a = safe_id("猫娘");
        assert!(a.starts_with("p-"), "got {a}");
        assert_eq!(a.len(), 10);
        assert_eq!(a, safe_id("猫娘"));
        assert_ne!(a, safe_id("露娜"));
        // 空名也不能产出空文件名
        assert_eq!(safe_id(""), "p-811c9dc5");
    }

    #[test]
    fn frontmatter_roundtrip() {
        let p = Persona {
            address: String::new(),
            id: "x".into(),
            name: "名字".into(),
            description: "描述".into(),
            source: "dsh:luna".into(),
            body: "正文\n第二行".into(),
        };
        let parsed = parse_persona_md(&render_persona_md(&p)).unwrap();
        assert_eq!(parsed.name, p.name);
        assert_eq!(parsed.body, p.body);
        assert_eq!(parsed.source, p.source);
    }

    /// `DSC_DATA_DIR` 必须压过 APPDATA —— 这是"验收脚本不碰真数据"的唯一开关。
    ///
    /// 【它为什么不碰环境变量】进程级环境是所有测试共享的：早先这条用
    /// `set_var / remove_var` 验"回落 APPDATA"，并发跑的其他测试正好在这期间调
    /// `app_root()`，就会拿到 `D:/tmp/dsc-isolated` 这种假目录 —— 实测把 config 的
    /// 坏文件用例踩成了间歇性失败（坏文件写到假目录、证据却在真目录里找）。
    /// 现在规则本身是纯函数（`resolve_app_root`），直接测它；最后再补一条只读的
    /// "真机确实读到了环境"，两条都不需要改任何东西。
    #[test]
    fn data_dir_env_wins_over_appdata() {
        assert_eq!(
            resolve_app_root(Some("D:/tmp/dsc-isolated"), Some("C:/fake"), Some("C:/home")),
            PathBuf::from("D:/tmp/dsc-isolated"),
            "DSC_DATA_DIR 优先"
        );
        // 末尾空格/空值要当"没设"，否则一个手滑的空变量会把数据写进当前目录，
        // 而且此时要回落到 APPDATA（这就是"隔离没生效"的那条路，必须守住）
        assert_eq!(
            resolve_app_root(Some("   "), Some("C:/fake-appdata"), Some("C:/home")),
            Path::new("C:/fake-appdata").join("ds-companion"),
            "空值当没设，回落 APPDATA"
        );
        assert_eq!(
            resolve_app_root(None, None, Some("C:/home")),
            Path::new("C:/home").join(".ds-companion"),
            "都没有才回落主目录"
        );

        // 真机那一条：`app_root()` 确实读到了环境（只读，不改）
        crate::tests::lock_test_data_dir();
        let want = std::env::var("DSC_DATA_DIR").unwrap_or_default();
        assert_eq!(app_root(), PathBuf::from(want));
    }

    /// 坏文件要留证据、不能原地不动（否则下一次保存就把它盖掉了）
    #[test]
    fn bad_file_is_quarantined_not_ignored() {
        crate::tests::lock_test_data_dir();
        let dir = std::env::temp_dir().join(format!("dsc-recover-{}", now_stamp()));
        fs::create_dir_all(&dir).unwrap();
        let cfg = dir.join("config.json");
        fs::write(&cfg, b"{ this is not json").unwrap();

        assert!(recover_bad_file(&cfg, "test"), "应当报告隔离成功");
        assert!(!cfg.exists(), "坏文件必须被挪走");
        let quarantined: Vec<_> = fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .filter(|e| e.file_name().to_string_lossy().contains(".bad-"))
            .collect();
        assert_eq!(quarantined.len(), 1, "应当留下恰好一份 .bad 证据");
        // 不存在时不能凭空造一份"证据"
        assert!(!recover_bad_file(&cfg, "test"));
        let _ = fs::remove_dir_all(&dir);
    }

    /// 回收站封顶：只留最新的 TRASH_KEEP 份，且绝不动"正本"目录
    #[test]
    fn trash_keeps_newest_only() {
        let dir = std::env::temp_dir().join(format!("dsc-trash-{}", now_stamp()));
        fs::create_dir_all(&dir).unwrap();
        let total = TRASH_KEEP + 7;
        for i in 0..total {
            // 文件名里的时间戳就是排序依据（不是 mtime）
            fs::write(dir.join(format!("item-{}.md", 1_790_000_000_000u64 + i as u64)), b"x").unwrap();
        }
        let removed = prune_trash(&dir);
        assert_eq!(removed, 7, "只该删最旧的 7 份");
        let left: Vec<String> = fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().to_string())
            .collect();
        assert_eq!(left.len(), TRASH_KEEP);
        // 留下的是**最新**那批：最早那份必须已经不在
        assert!(
            !left.contains(&format!("item-{}.md", 1_790_000_000_000u64)),
            "删错了：最旧的还在，等于没封顶"
        );
        // 再跑一次是幂等的（没超上限就不动）
        assert_eq!(prune_trash(&dir), 0);
        let _ = fs::remove_dir_all(&dir);
    }

    // ─────────────── 出厂默认角色 & 「原版」三态 ───────────────
    //
    // 这一组盯的是"没选角色时到底谁在说话"：以前是**没有任何人设**（等于原版），
    // 现在默认是 DeepSeek 娘，而"原版"变成一个要显式选的选项。语义搞错的话，
    // 主人会看到"我明明没选角色，怎么有个陌生人在跟我说话"——或者反过来，"默认角色不见了"。

    #[test]
    fn builtin_persona_is_always_available() {
        let p = builtin_persona();
        assert_eq!(p.id, BUILTIN_ID);
        assert!(!p.name.trim().is_empty(), "默认角色得有名字");
        assert!(p.body.len() > 300, "默认角色的正文太短了：{}", p.body.len());
        assert!(
            p.body.contains("DeepSeek"),
            "默认角色应该是 DeepSeek 的拟人化"
        );
        // 内嵌定义要能解析出 frontmatter（md 是唯一真相源，格式坏了这里就会红）
        let parsed = parse_persona_md(BUILTIN_MD).expect("内置 md 必须能解析");
        assert_eq!(parsed.id, BUILTIN_ID);
        assert_eq!(parsed.source, "builtin");
    }

    /// 三态：没选 → 默认角色；选「原版」→ 谁都不注；选了不存在的 → 退回默认（不是空白）
    #[test]
    fn effective_persona_three_states() {
        let d = effective_persona(None).expect("没选角色时应当有默认角色");
        assert_eq!(d.id, BUILTIN_ID);
        assert_eq!(
            effective_persona(Some("")).map(|p| p.id),
            Some(BUILTIN_ID.into()),
            "空串也按'没选'处理"
        );

        assert!(
            effective_persona(Some(PERSONA_OFF)).is_none(),
            "选「原版」时必须什么都不注"
        );

        // 配置指着一个不存在的人设 → 退回默认角色（比"什么都不注"好：至少还能说话，
        // 而且设置页里那个错误 id 一眼就能看出来）
        let missing = effective_persona(Some("这个角色不存在")).expect("应当退回默认角色");
        assert_eq!(missing.id, BUILTIN_ID);
    }

    /// character_id 三态：原版时是空串（状态与角色记忆都不参与）
    #[test]
    fn character_id_follows_the_same_three_states() {
        assert_eq!(active_character_id(None), BUILTIN_ID);
        assert_eq!(active_character_id(Some("  ")), BUILTIN_ID);
        assert_eq!(active_character_id(Some(PERSONA_OFF)), "");
        assert_eq!(active_character_id(Some("dsh-luna")), "dsh-luna");
    }

    /// 出厂默认角色必须出现在列表里（而且排第一个）—— 它不在 personas 目录里
    #[test]
    fn list_personas_always_includes_the_default() {
        crate::tests::lock_test_data_dir();
        let list = list_personas();
        assert!(
            list.iter().any(|p| p.id == BUILTIN_ID),
            "列表里必须有默认角色：{:?}",
            list.iter().map(|p| &p.id).collect::<Vec<_>>()
        );
        assert_eq!(list[0].id, BUILTIN_ID, "默认角色该排在最前面");
        // 就算磁盘上有同 id 的文件，也不该出现两条
        assert_eq!(list.iter().filter(|p| p.id == BUILTIN_ID).count(), 1);
        // get_persona_any 也要能取到她（设置页点开默认角色要看得到正文）
        assert!(get_persona_any(BUILTIN_ID).is_some());
    }
}
