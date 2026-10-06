//! 隔着一段时间看一眼主人在看什么 —— 截前台窗口、认成字、喂给她。
//!
//! 【这一层比"你在用什么软件"敏感得多，所以门也厚得多】
//! 前面那条（`front.rs`）读的是"哪个程序在前台"；这一条读的是**屏幕上的字** ——
//! 网页在讲什么、文档里写了什么、聊天框里是谁在说话，全在里面。所以：
//!   ① 默认关，而且**开的时候要勾选+弹窗确认**（这条不在代码里，在设置页）；
//!   ② 截图只进内存，**一个字节都不落盘**（`ocr.ps1` 用 InMemoryRandomAccessStream，
//!      实测 `mode=memory`；内存流不通时退回临时文件并当场删掉）；
//!   ③ 结果只在**进程内存**里活到下一次观测，不写文件、不进聊天留档、不出网；
//!   ④ 前台是敏感软件（密码管理器/银行那类，`front.rs` 会把它认成空 exe）时，
//!      这一次**根本不截**；前台是她自己的窗口时也不截（看自己没意义）；
//!   ⑤ 送进对话的只有**清洗并截断后的 200~300 字**，不是整个屏幕。
//!
//! 【为什么判断逻辑全在 Rust、PowerShell 只管认字】清洗、滤噪、截断都是**规则**，
//! 规则得有单测盯着、也该能调参不重新编译脚本。脚本只调用系统能力（截屏 + OCR）。

use std::io::Read;
use std::process::{Command, Stdio};
use std::sync::Mutex;
use std::time::Duration;

/// 间隔可选范围（分钟）。1 分钟已经挺激进了 —— 每次成本约 1.5 秒 CPU。
pub const MIN_MINUTES: u32 = 1;
pub const MAX_MINUTES: u32 = 60;
/// 送进对话的字数范围
pub const MIN_CHARS: u32 = 60;
pub const MAX_CHARS: u32 = 800;
/// 她"亲眼看"回来交的那段最多留多少字 —— 模型输出长度不可控，而它要进下一轮上下文
pub const SEE_CHARS: usize = 300;
/// 后台每这么久醒一次看看该不该到点了（比最小间隔小，改了设置能较快生效）
pub const TICK_SECS: u64 = 15;
/// 子进程最多等这么久；超了就放弃这一次（下一次到点再来）
const RUN_TIMEOUT: Duration = Duration::from_secs(20);

/// 一次观测的结果
#[derive(Clone, Debug, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    /// 什么时候看的（ms）
    pub at: u64,
    /// 清洗 + 截断之后，实际会喂给她的那段
    pub text: String,
    /// OCR 出来的原始行数
    pub lines: u32,
    /// 截断之后的字数
    pub chars: u32,
    /// 这一次花了多久（含起 PowerShell）
    pub ms: u64,
    /// memory = 全程没落盘；temp = 走了临时文件（用完已删）
    pub mode: String,
    /// 截的是哪块区域（"2880x1860"）
    pub size: String,
    /// 这一次**没看**的原因（空 = 看了）。跳过也要记 —— 界面上要能解释"为什么没动静"
    pub skipped: String,
    /// 她看见之后顺口说的那句话（空 = 这次不说）。冒在桌宠的气泡里。
    pub say: String,
    /// 那句话是什么时候说的（ms）—— 桌宠据此判断"这句话是不是已经过时了"
    pub say_at: u64,
    /// 她**亲眼**看过之后回来说的那段（多模态那条路）。空 = 这次没走那条路
    pub see: String,
    /// 那段是什么时候回来的（ms）
    pub see_at: u64,
    /// 她看的那张图缩到多大（"512x319"）。空 = 这次没生成图
    pub see_size: String,
    /// 那段 `see` 对应的是**哪一屏**（存当时的清洗文本，用来判断它有没有过期）
    pub see_for: String,
}

/// 一张等着页面来取的图（她"亲眼看"那条路）。
///
/// 【为什么不放进 `Snapshot`】`Snapshot` 每 15 秒被设置页拉一次（`dsc_screen_state`），
/// 里面塞一份 30KB 的 base64 会让 IPC 和界面一起变慢。图只在页面真要注入时取一次。
#[derive(Clone, Debug, Default, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Shot {
    /// base64（**不带** data: 前缀 —— 页面自己拼）
    pub b64: String,
    pub w: u32,
    pub h: u32,
    /// 图上有没有画鼠标圈（false = 截图那一刻鼠标不在这一块里）
    pub cursor: bool,
    /// 是什么时候截的（ms）
    pub at: u64,
    /// 截的是哪块区域（"2880x1860"）
    pub size: String,
}

/// 上一次尝试的时间 + 最近一次结果。**只在内存里**：退出即散。
#[derive(Default)]
struct State {
    last_try: u64,
    snap: Option<Snapshot>,
    /// 等着页面来取的那张图
    shot: Option<Shot>,
}

static STATE: Mutex<Option<State>> = Mutex::new(None);

/// 上一轮注入进对话的那段文本 —— 和这次一模一样就不再注入（同一个页面盯久了不该每轮都花额度）
static LAST_INJECTED: Mutex<Option<String>> = Mutex::new(None);

/// 上一张**已经生成过图**的屏幕内容（拿清洗后的 OCR 文本当指纹）。
///
/// 【为什么用 OCR 文本当"变更探测器"】同一页盯半小时，OCR 出来的字一模一样 ——
/// 那就没必要每 5 分钟花 200 token 让她重看同一张图。本地 OCR 是零成本的，
/// 拿它当门铃、拿多模态当眼睛，这就是"OCR 当备份"这句话的正确用法。
static LAST_SHOT_FOR: Mutex<Option<String>> = Mutex::new(None);

fn with_state<T>(f: impl FnOnce(&mut State) -> T) -> T {
    let mut g = match STATE.lock() {
        Ok(g) => g,
        Err(p) => p.into_inner(),
    };
    f(g.get_or_insert_with(State::default))
}

// ─────────────────────── 文本处理（纯函数，全部可单测） ───────────────────────

/// 是不是东亚字符 —— 判"这个空格要不要说掉"时只看这一类
fn is_cjk(c: char) -> bool {
    matches!(
        c as u32,
        0x3000..=0x303f | 0x3040..=0x30ff | 0x4e00..=0x9fff | 0xff00..=0xffef
    )
}

/// 把连续的空白折成一个空格
fn collapse_spaces(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut prev_space = false;
    for c in s.trim().chars() {
        if c.is_whitespace() {
            if !prev_space {
                out.push(' ');
            }
            prev_space = true;
        } else {
            out.push(c);
            prev_space = false;
        }
    }
    out
}

/// 说掉**汉字之间的空格**。
///
/// 【为什么必须做】Windows 的 OCR 是**逐字**给识别框的，中文出来就是
/// `中 学 电 话 亭 的 那 面 墙` —— 直接喂给模型既难看又费 token（每个字多一个空格）。
/// 但英文/数字之间的空格是**真空格**（`Visual Studio Code`），一个都不能动 ——
/// 所以只在"空格两边都是东亚字符"时才删。
pub fn squeeze(line: &str) -> String {
    let chars: Vec<char> = line.trim().chars().collect();
    let mut out = String::with_capacity(line.len());
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        if c == ' ' || c == '\t' {
            let prev = out.chars().last();
            let next = chars[i + 1..]
                .iter()
                .find(|x| **x != ' ' && **x != '\t')
                .copied();
            if let (Some(p), Some(n)) = (prev, next) {
                if is_cjk(p) && is_cjk(n) {
                    i += 1;
                    continue;
                }
            }
        }
        out.push(c);
        i += 1;
    }
    collapse_spaces(&out)
}

/// 一眼就知道是字幕/菜单的短词。**故意短** —— 漏掉几个只是多一句废话，
/// 误杀一行就可能把她本该看到的内容吃掉。
const UI_WORDS: &[&str] = &[
    "首页", "登录", "注册", "菜单", "更多", "分享", "收藏", "关注", "点赞", "投币",
    "转发", "评论", "弹幕", "弹幕列表", "订阅", "订阅合集", "推荐", "搜索", "设置",
    "消息", "动态", "历史", "创作中心", "大会员", "客户端", "下载", "打开", "关闭",
    "确定", "取消", "保存", "全屏", "退出", "最小化", "投稿", "简介", "三", "曰",
    "令", "回", "区",
];

/// 这行是噪音吗。
///
/// 【判据都偏保守】宁可多留一句废话，也别把真内容滤掉 —— 她理解的是"大概在看什么"，
/// 多一行不影响，少一行可能就少了主题。
pub fn is_noise(line: &str) -> bool {
    let t = line.trim();
    if t.chars().count() < 2 {
        return true; // 单个字/单个符号：OCR 的碎片
    }
    // 纯数字或纯标点（播放量、时间码那类）
    let has_word = t.chars().any(|c| c.is_alphabetic());
    if !has_word {
        return true;
    }
    // 带查询串的长链接：`?spm_id_from=...` 那截全是噪音，
    // 而"他在看 bilibili.com"这个信息域名已经给了
    if t.contains('?') && t.contains('/') && t.chars().count() > 48 {
        return true;
    }
    // 光秃秃一个菜单词
    if UI_WORDS.contains(&t) {
        return true;
    }
    false
}

/// 把屏幕上的一段收拾成"要喂给她的那一段"。
///
/// 顺序是**屏幕上从上到下**的（OCR 就是这么给的）—— 网页标题一般在最上面，
/// 于是自然落在前面，正是最该让她看到的那部分。截断按**字符数**。
pub fn compose(lines: &[String], max_chars: u32) -> String {
    let max = max_chars.clamp(MIN_CHARS, MAX_CHARS) as usize;
    let mut out = String::new();
    let mut seen: Vec<String> = Vec::new();
    for raw in lines {
        // 【顺序不能反】OCR 是**逐字**给框的（`讠 殳 置`），先 squeeze 把它们连成
        // `讠殳置`，strip_radicals 才认得出该抠哪个。
        let t = strip_radicals(raw);
        if is_noise(&t) {
            continue;
        }
        // 同一行出现两次（侧栏和正文里都印了一遍）只留一次
        if seen.iter().any(|s| s == &t) {
            continue;
        }
        let sep = if out.is_empty() { 0 } else { 1 };
        let have = out.chars().count();
        if have + sep + t.chars().count() > max {
            // 塞不下整行：把剩下的额度用掉一部分，够长才值得留
            let left = max.saturating_sub(have + sep);
            if left >= 8 {
                if sep == 1 {
                    out.push('\n');
                }
                out.extend(t.chars().take(left));
            }
            break;
        }
        if sep == 1 {
            out.push('\n');
        }
        out.push_str(&t);
        seen.push(t);
    }
    out
}

/// 按**字符**截断（不是字节）—— 中文一个字三字节，按字节切会切出半个字
fn clip_chars(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_string();
    }
    s.chars().take(max).collect()
}

/// 从她看到的那段里挑一个"最像主题"的短句，当那句话的宾语。
///
/// 【为什么不能直接拿第一行】第一行经常是导航栏、播放量、时间码那类碎片；也可能整屏
/// 都是碎的。所以按"标题的样子"找：不太短、不太长、有中日韩字、不是链接 ——
/// 找不到就退回第一行够长的那个（宁可说一句含糊的，也别什么都不说）。
/// 主题最多留这么多个字。
///
/// 【为什么是 18】桌宠头顶只留了 44px（两行 12.5px 的字），而模板最长的那条
/// 前后还要各占几个字 —— 主体再长就压到她脸上了。
const SUBJECT_CHARS: usize = 18;

pub fn pick_subject(text: &str) -> Option<String> {
    let mut fallback: Option<String> = None;
    for raw in text.lines() {
        let t = raw.trim();
        if t.is_empty() {
            continue;
        }
        if fallback.is_none() && t.chars().count() >= 4 {
            fallback = Some(clip_chars(t, SUBJECT_CHARS));
        }
        let n = t.chars().count();
        if n >= 5 && n <= 40 && t.chars().any(is_cjk) && !t.contains("://") {
            return Some(clip_chars(t, SUBJECT_CHARS));
        }
    }
    fallback
}

/// 本地把"她看见的东西"说成一句话。**零成本**。
///
/// 【为什么不上模型】主人要的就是"主人居然在看……"这种反应，不是一段小作文 ——
/// 而它每隔几分钟就来一次，走隐藏链等于定期花额度。模板拼就够了，措辞想调改这张表。
///
/// 【为什么按内容哈希选模板】同一屏内容每次说同一句，气泡不会闪；内容一变，
/// 哈希跟着变，措辞也就跟着换了（不至于每次都是同一句）。
///
/// 【为什么模板里不带自称】它得对任何角色都成立 —— "本小姐"这种是某个角色的人设，
/// 写死在壳里就等于把壳绑给一个角色了。
pub fn local_line(subject: &str) -> String {    const TPL: &[&str] = &[
        "主人居然在看「{}」",
        "「{}」……在看这个啊",
        "又打开了「{}」呢",
        "哦——「{}」",
        "在「{}」里泡着呢",
        "主人看「{}」看得好认真",
        "这个「{}」，我看见了",
    ];
    let h = subject
        .bytes()
        .fold(2166136261u32, |a, b| (a ^ b as u32).wrapping_mul(16777619));
    TPL[(h as usize) % TPL.len()].replace("{}", subject)
}

/// 「看见了就说一句」—— 按配置和内容决定这次说不说，返回（那句话, 时间戳）
fn say_for(cfg: &crate::config::AppConfig, text: &str) -> (String, u64) {
    if cfg.screen_say_mode != "local" {
        return (String::new(), 0);
    }
    // 【默认不用 OCR 挑主题】小字号中文会被 Windows OCR 拆成偏旁（「设置」→「讠殳置」），
    // 拿它当宾语念出来就是乱码 —— 那正是主人报的"她有时候说的是乱码"。
    // 开着"亲眼看"时宁可**先不冒泡**：等她看完回来，`note_seen` 会用她真正看到的重算一句
    // 并叫醒桌宠。那一下不花额外的钱 —— 图本来就已经看过了。
    if cfg.screen_see {
        return (String::new(), 0);
    }
    match pick_subject(text) {
        Some(sub) => (local_line(&sub), crate::now_ms()),
        None => (String::new(), 0),
    }
}

/// 解析 `ocr.ps1` 的输出：第一行是 `#meta ...`，之后每行一条文字。
///
/// 返回（元信息键值, 正文行）
pub fn parse_output(stdout: &str) -> (std::collections::HashMap<String, String>, Vec<String>) {    let mut meta = std::collections::HashMap::new();
    let mut lines = Vec::new();
    for (i, raw) in stdout.lines().enumerate() {
        let l = raw.trim_end_matches('\r');
        if i == 0 {
            for kv in l.trim_start_matches("#meta ").split(' ') {
                if let Some((k, v)) = kv.split_once('=') {
                    meta.insert(k.to_string(), v.to_string());
                }
            }
            continue;
        }
        // 【这一行不能当文字行收进去】`#img` 后面是几十 K 字符的 base64 —— 混进 lines 里
        // 就成了"屏幕上的字"，会把真正的内容全挤掉。单独存到 meta 的另一个键上。
        // 注意 meta 里那个 `img=512x331` 是**尺寸**，两个键别搞混。
        if let Some(b64) = l.strip_prefix("#img ") {
            let t = b64.trim();
            if !t.is_empty() {
                meta.insert("imgb64".to_string(), t.to_string());
            }
            continue;
        }
        if !l.trim().is_empty() {
            lines.push(l.to_string());
        }
    }
    (meta, lines)
}

// ─────────────────────── 跑一次 ───────────────────────

/// 把脚本转成 `-EncodedCommand` 认的形式：UTF-16LE 再 base64。
///
/// 【为什么不落盘一个 .ps1】机器上不留文件，也顺手绕开"PowerShell 5.1 把无 BOM 的
/// 文件按 GBK 解读"那类编码坑（那坑在本项目踩过：中文注释能把引号吞掉）。
fn encoded_command(script: &str) -> String {
    let mut bytes = Vec::with_capacity(script.len() * 2);
    for u in script.encode_utf16() {
        bytes.extend_from_slice(&u.to_le_bytes());
    }
    crate::avatar::base64_encode(&bytes)
}

/// 跑一次「截屏 + OCR」，回原始行。
fn run_ocr() -> Result<(std::collections::HashMap<String, String>, Vec<String>), String> {
    let script = include_str!("../ocr/ocr.ps1");
    let b64 = encoded_command(script);

    let mut cmd = Command::new("powershell");
    cmd.args([
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-EncodedCommand",
        &b64,
    ])
    .stdin(Stdio::null())
    .stdout(Stdio::piped())
    .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW：别弹个黑框抢焦点
    }

    let mut child = cmd.spawn().map_err(|e| format!("起不了 powershell：{e}"))?;
    // 【为什么要搬去另一个线程读】`.output()` 没超时，而这个脚本要起一整套 WinRT；
    // 万一哪天卡住，定时线程就永远回不来了 —— 那种"看着还在跑其实死了"最难查。
    let mut stdout = child.stdout.take().ok_or("拿不到 stdout")?;
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let mut buf = String::new();
        let _ = stdout.read_to_string(&mut buf);
        let _ = tx.send(buf);
    });
    match rx.recv_timeout(RUN_TIMEOUT) {
        Ok(text) => {
            let _ = child.wait();
            Ok(parse_output(&text))
        }
        Err(_) => {
            let _ = child.kill();
            Err(format!("OCR 超过 {} 秒没回来", RUN_TIMEOUT.as_secs()))
        }
    }
}

/// 解析 `ocr.ps1` 输出里"图缩到多大"那一栏（"512x319"）
fn parse_size(s: &str) -> (u32, u32) {
    match s.split_once('x') {
        Some((a, b)) => (a.trim().parse().unwrap_or(0), b.trim().parse().unwrap_or(0)),
        None => (0, 0),
    }
}

/// 造一张"等她看"的图。`None` = 这次没图、或者**内容和上次给她看的一模一样**。
///
/// 【为什么"内容没变就不造"】同一页盯半小时，OCR 出来的字一个不差 —— 那就没必要每 5 分钟
/// 花 200 token 让她重看一张没变的图。指纹用**清洗后的 OCR 文本**，因为它是零成本的：
/// 拿本地 OCR 当门铃、拿多模态当眼睛，这才是"OCR 当备份"的正确用法。
///
/// 【注意别在 `with_state` 里调它】它内部会锁 `LAST_SHOT_FOR` —— 两把锁不是同一把，
/// 这个函数自己是安全的；但它**返回**的东西要由调用方塞进 State，别写成嵌套的 with_state。
fn shot_from(
    meta: &std::collections::HashMap<String, String>,
    text: &str,
) -> Option<Shot> {
    let b64 = match meta.get("imgb64") {
        Some(s) if !s.is_empty() => s.clone(),
        _ => return None,
    };
    {
        let mut last = match LAST_SHOT_FOR.lock() {
            Ok(g) => g,
            Err(p) => p.into_inner(),
        };
        if last.as_deref() == Some(text) {
            return None;
        }
        *last = Some(text.to_string());
    }
    let (w, h) = parse_size(meta.get("img").map(String::as_str).unwrap_or(""));
    Some(Shot {
        b64,
        w,
        h,
        cursor: meta.get("cursor").map(String::as_str) == Some("1"),
        at: crate::now_ms(),
        size: format!(
            "{}x{}",
            meta.get("w").cloned().unwrap_or_default(),
            meta.get("h").cloned().unwrap_or_default()
        ),
    })
}

/// 页面来取"最近一张等她看的图"。**取走即清** —— 同一张图不该让页面看两遍。
pub fn take_shot() -> Option<Shot> {
    if !crate::config::load().screen_watch {
        return None;
    }
    with_state(|s| s.shot.take())
}

/// 从她「亲眼看」回来的那段里挑出能当气泡宾语的那一句。
///
/// 【为什么优先用它】本地 OCR 挑出来的主题可能是乱的（偏旁碎片：`讠殳置`），而这段是
/// 模型亲眼看过的 —— 约定的格式是两行（`在做什么：…` / `重点：…`），**重点那行最好用**。
/// 格式没照做时退回第一行，都比 OCR 挑的准。
fn subject_from_see(see: &str) -> Option<String> {
    let mut first: Option<String> = None;
    for line in see.lines() {
        let l = line.trim();
        if l.is_empty() {
            continue;
        }
        for pre in ["重点：", "重点:", "重点 ", "重点"] {
            if let Some(rest) = l.strip_prefix(pre) {
                let r = rest.trim().trim_start_matches(['：', ':']).trim();
                if !r.is_empty() {
                    return Some(clip_chars(r, SUBJECT_CHARS));
                }
            }
        }
        if first.is_none() {
            let l = l
                .strip_prefix("在做什么：")
                .or_else(|| l.strip_prefix("在做什么:"))
                .unwrap_or(l)
                .trim();
            if !l.is_empty() {
                first = Some(l.to_string());
            }
        }
    }
    first.filter(|s| s.chars().count() >= 2).map(|s| clip_chars(&s, SUBJECT_CHARS))
}

/// 页面看完回来交作业：她**亲眼**看到的那段（"在做什么 + 重点在哪"）。
///
/// 返回 `true` = 顺手把桌宠那句换成了更准的，调用方该去叫醒桌宠。
///
/// 【为什么要在这里重算气泡】截图那一刻只有本地 OCR 那版主题（可能是偏旁碎片），
/// 而她看完之后手上才有准的内容。重算不花额外的钱 —— 这次看图本来就花了。
pub fn note_seen(text: &str, size: &str) -> bool {
    let t = text.trim();
    if t.is_empty() {
        return false;
    }
    let mut says = false;
    with_state(|s| {
        let snap = s.snap.get_or_insert_with(Snapshot::default);
        snap.see = clip_chars(t, SEE_CHARS);
        snap.see_at = crate::now_ms();
        let now_text = snap.text.clone();
        snap.see_for = now_text;
        if !size.is_empty() {
            snap.see_size = size.to_string();
        }
        if let Some(subj) = subject_from_see(&snap.see) {
            let line = local_line(&subj);
            if line != snap.say {
                snap.say = line;
                snap.say_at = crate::now_ms();
                says = true;
            }
        }
    });
    says
}

/// **只会出现在部件里的独用字** —— 正常中文里不会单独用它们。
///
/// 【为什么需要这张表】小字号的中文，Windows OCR 经常**把字拆成部件**。实测样本
/// （屏幕上是 DSH 的界面，13~15px 正文）：
///   「设置」→「讠 殳 置」  「候」→「亻 制」  「折」→「扌 斤」
///   「消」→「氵 肖」      「如果」→「爿 珩」
/// 它们**全都是合法汉字**，靠"像不像字""是不是常用字"根本判不出来。但拆出来的部件
/// 本身是独用字 —— 正常文本里不会出现 —— 所以这一条判据既准又便宜。
///
/// 【这是主人报的那个 bug】桌宠那句会念成「主人居然在看「讠殳置」」，看起来就是乱码。
///
/// 【为什么删得放心】这些字出现在真实屏幕上就等于 OCR 拆了字，删掉只会让
/// `讠殳置` 变成 `置`（更接近原意），不会伤到任何正常内容。
///
/// 【这张表是补出来的，不是列全的】拆出来的碎片**不一定**是"部件专用字" ——
/// 「设」被拆成 `讠` + `殳`，而 `殳` 是它的声旁、本身是个罕见的正经字。所以策略是：
/// **遇到一个样本就补一个**，并把它写进 `broken_ocr_radicals_are_stripped` 那条测试里。
/// 判断标准只有一条：现代中文里会不会单独用它（`肖`、`斤` 这类常用字一律不许进表 ——
/// 它们是"消息""公斤"的一部分，删了就真丢字了）。
const RADICAL_NOISE: &str =
    "讠亻彳扌氵忄纟阝卩廴辶钅饣疒衤礻犭罒疋丷爿刂冫灬虍亠冖丿丨丶乛乚亅殳";

fn is_radical_noise(c: char) -> bool {
    RADICAL_NOISE.contains(c)
}

/// 抠掉 OCR 拆字留下的偏旁碎片，顺手把多出来的空格收掉。
///
/// 【它和 squeeze 的分工】squeeze 管"逐字框之间的空格"（`中 学 电 话 亭` → `中学电话亭`），
/// 这里管"被拆出来的部件"。两个都做完，OCR 那点毛病才算收拾干净。
pub fn strip_radicals(line: &str) -> String {
    let kept: String = squeeze(line).chars().filter(|c| !is_radical_noise(*c)).collect();
    squeeze(&kept)
}

/// 这一次不该看的原因（空 = 可以看）。
///
/// 【为什么"在看自己"也算理由】前台是 ds-companion 自己的窗口时，截下来的是设置页 /
/// 聊天页 —— 那既没信息，还可能把她自己注入的块又读回来一遍。
fn skip_reason(cfg: &crate::config::AppConfig) -> String {
    if !cfg.screen_watch {
        return "没开".to_string();
    }
    match crate::front::current() {
        // 敏感软件：`front.rs` 把它的进程名和标题都抹成空串了 —— 那就连截都不截
        Some(a) if a.exe.is_empty() => "前台是敏感软件，跳过".to_string(),
        Some(a) if a.exe.eq_ignore_ascii_case("ds-companion.exe") => "在看自己".to_string(),
        _ => String::new(),
    }
}

/// 后台每 TICK_SECS 秒来一次：到点了就截一次。
///
/// 返回 `true` = 这一趟**真的看了**（有新内容）—— 调用方据此决定要不要叫醒桌宠。
pub fn tick() -> bool {
    let cfg = crate::config::load();
    let now = crate::now_ms();
    let every = cfg.screen_every_minutes.clamp(MIN_MINUTES, MAX_MINUTES) as u64 * 60_000;

    let due = with_state(|s| {
        if !cfg.screen_watch {
            return false;
        }
        now.saturating_sub(s.last_try) >= every
    });
    if !due {
        return false;
    }

    let reason = skip_reason(&cfg);
    if !reason.is_empty() {
        // 跳过也要记时间，否则每 15 秒重试一次
        with_state(|s| {
            s.last_try = now;
            let snap = s.snap.get_or_insert_with(Snapshot::default);
            snap.at = now;
            snap.skipped = reason;
        });
        return false;
    }

    let started = std::time::Instant::now();
    let result = run_ocr();
    let ms = started.elapsed().as_millis() as u64;
    with_state(|s| {
        s.last_try = crate::now_ms();
        let snap = s.snap.get_or_insert_with(Snapshot::default);
        snap.ms = ms;
        snap.skipped = String::new();
        snap.at = crate::now_ms();
        match result {
            Ok((meta, lines)) => {
                let raw_lines = lines.len() as u32;
                let text = compose(&lines, cfg.screen_chars);
                let (say, say_at) = say_for(&cfg, &text);
                snap.lines = raw_lines;
                snap.chars = text.chars().count() as u32;
                snap.mode = meta.get("mode").cloned().unwrap_or_default();
                snap.size = format!(
                    "{}x{}",
                    meta.get("w").cloned().unwrap_or_default(),
                    meta.get("h").cloned().unwrap_or_default()
                );
                snap.say = say;
                snap.say_at = say_at;
                // 留一张图等页面来取（她"亲眼看"那条路）。开关关着就不造 —— 造了也没人要，
                // 白花缩图和编码那几十毫秒。
                if cfg.screen_see {
                    if let Some(shot) = shot_from(&meta, &text) {
                        s.shot = Some(shot);
                    }
                }
                snap.text = text;
            }
            Err(e) => {
                snap.text.clear();
                snap.chars = 0;
                snap.lines = 0;
                snap.skipped = format!("这次没看成：{e}");
            }
        }
    });
    crate::shell_log(&format!(
        "[screen] {}ms lines={} chars={}",
        ms,
        with_state(|s| s.snap.as_ref().map(|x| x.lines).unwrap_or(0)),
        with_state(|s| s.snap.as_ref().map(|x| x.chars).unwrap_or(0))
    ));
    true
}

/// 界面/命令要的那一份快照。
///
/// 【为什么关着的时候要改 `skipped`】内部那份快照记的是"上一次尝试的结果" ——
/// 主人把开关关掉之后回来看读数，最该看到的是"没开"，而不是停在上一次那句
/// "前台是敏感软件，跳过"上（那会让人以为它还在偷偷看）。
pub fn snapshot() -> Snapshot {
    let on = crate::config::load().screen_watch;
    with_state(|s| {
        let mut snap = s.snap.clone().unwrap_or_default();
        if !on {
            snap.skipped = "没开".to_string();
        }
        snap
    })
}

/// 手动看一眼（设置页的「现在看一次」）。同步跑一次，不等后台节拍。
pub fn look_now() -> Snapshot {
    let cfg = crate::config::load();
    let reason = skip_reason(&cfg);
    if !reason.is_empty() {
        with_state(|s| {
            s.last_try = crate::now_ms();
            let snap = s.snap.get_or_insert_with(Snapshot::default);
            snap.at = crate::now_ms();
            snap.skipped = reason;
        });
        return snapshot();
    }
    let started = std::time::Instant::now();
    let result = run_ocr();
    let ms = started.elapsed().as_millis() as u64;
    with_state(|s| {
        s.last_try = crate::now_ms();
        let snap = s.snap.get_or_insert_with(Snapshot::default);
        snap.at = crate::now_ms();
        snap.ms = ms;
        snap.skipped = String::new();
        match result {
            Ok((meta, lines)) => {
                snap.lines = lines.len() as u32;
                let text = compose(&lines, cfg.screen_chars);
                let (say, say_at) = say_for(&cfg, &text);
                snap.chars = text.chars().count() as u32;
                snap.say = say;
                snap.say_at = say_at;
                if cfg.screen_see {
                    if let Some(shot) = shot_from(&meta, &text) {
                        s.shot = Some(shot);
                    }
                }
                snap.text = text;
                snap.mode = meta.get("mode").cloned().unwrap_or_default();
                snap.size = format!(
                    "{}x{}",
                    meta.get("w").cloned().unwrap_or_default(),
                    meta.get("h").cloned().unwrap_or_default()
                );
            }
            Err(e) => {
                snap.text.clear();
                snap.chars = 0;
                snap.lines = 0;
                snap.skipped = format!("这次没看成：{e}");
            }
        }
    });
    snapshot()
}

/// 拼进【他屏幕上】那一块。空 = 这一轮不加。
///
/// 【为什么一样就不加】同一个页面盯久了，每轮都把同一段 240 字塞进上下文纯属烧额度；
/// 而她上一轮已经见过那段了（就在历史消息里）。
pub fn render_block(cfg: &crate::config::AppConfig) -> String {
    if !cfg.screen_watch {
        return String::new();
    }
    let snap = snapshot();
    // 两条路，优先**她亲眼看过**的那条：它带"焦点在哪"，而 OCR 那版只有一堆字。
    //
    // 【开着"亲眼看"时，宁可这一轮不注入】刚截完、页面还没跑完那一小会儿，手上只有 OCR。
    // 拿它去凑数，喂进去的可能是「0 露娜模式 " 1 个后台任务运行中 丷」这种带偏旁碎片的
    // 东西 —— 她读着就会说出些莫名其妙的话。等下一轮 see 回来再注入，只晚一次。
    let (head, body) = if !snap.see.trim().is_empty() {
        ("【他屏幕上】你自己看了一眼，看到的是：", snap.see.clone())
    } else if cfg.screen_see {
        return String::new();
    } else {
        ("【他屏幕上】大概写着这些：", snap.text.clone())
    };
    if body.trim().is_empty() {
        return String::new();
    }
    {
        let mut last = match LAST_INJECTED.lock() {
            Ok(g) => g,
            Err(p) => p.into_inner(),
        };
        if last.as_deref() == Some(body.as_str()) {
            return String::new();
        }
        *last = Some(body.clone());
    }
    format!(
        "{}\n{}\n【这是你自己瞄到的一眼，不是他念给你听的：别复述、别逐条报，最多顺着提一句。真要用就拿它当由头，别当谈资。】",
        head, body
    )
}

/// 主人关掉这个开关时，把去重状态清掉 —— 免得下次打开时第一轮被吃掉。
///
/// 【为什么连图指纹一起清】"关掉再打开"在心智上就是"重新开始"：不清指纹的话，
/// 关掉前刚好看过的那一屏，重新打开后会被判成"没变过"而永远不再看第二眼。
/// 验收脚本也靠这一下拿到干净的起点（否则同一块板子只能验第一次）。
pub fn forget_last_injected() {
    if let Ok(mut g) = LAST_INJECTED.lock() {
        *g = None;
    }
    if let Ok(mut g) = LAST_SHOT_FOR.lock() {
        *g = None;
    }
    // 手上还攥着一张没人要的图也一起丢掉（关掉之后再取走它没有意义）
    with_state(|s| s.shot = None);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn squeeze_closes_up_chinese_but_leaves_english_alone() {
        assert_eq!(squeeze("中 学 电 话 亭"), "中学电话亭");
        assert_eq!(squeeze("Visual Studio Code"), "Visual Studio Code");
        assert_eq!(squeeze("chrome. exe"), "chrome. exe");
        // 中英混排：中文那边合上，英文那边不动
        assert_eq!(squeeze("用 Tauri 2 打 包"), "用 Tauri 2 打包");
        // 中文和全角标点之间那个空格也该说掉
        assert_eq!(squeeze("为 何 成 了 哭 墙 ？"), "为何成了哭墙？");
    }

    #[test]
    fn squeeze_folds_whitespace_and_trims() {
        assert_eq!(squeeze("  标 题  "), "标题");
        assert_eq!(squeeze("a    b"), "a b");
        assert_eq!(squeeze(""), "");
    }

    #[test]
    fn noise_rules_keep_content_and_drop_furniture() {
        assert!(is_noise("0"));
        assert!(is_noise("·"));
        assert!(is_noise("17:30:00"));
        assert!(is_noise("弹幕列表"));
        assert!(is_noise("大会员"));
        // 带查询串的长链接是纯噪音（域名那条信息另外给）
        assert!(is_noise(
            "https://www.bilibili.com/video/BV1X?spm_id_from=333.788.recommend_more&trackid=web"
        ));
        // ★真内容一个都不能滤★
        assert!(!is_noise("中学电话亭的那面墙，为何成了学生的哭墙？"));
        assert!(!is_noise("https://www.bilibili.com"));
        assert!(!is_noise("小约翰可汗的奇葩小国"));
    }

    #[test]
    fn compose_keeps_screen_order_and_respects_the_budget() {
        let lines = vec![
            "0".to_string(),
            "中 学 电 话 亭 的 那 面 墙".to_string(),
            "大会员".to_string(),
            "这 一 、 的 不 是 探 监 吗".to_string(),
        ];
        let got = compose(&lines, 60);
        assert_eq!(got, "中学电话亭的那面墙\n这一、的不是探监吗");
        // 字数上限真的守住了
        assert!(got.chars().count() <= 60);
    }

    #[test]
    fn compose_dedupes_and_truncates_the_tail() {
        let lines: Vec<String> = vec!["重 复 的 一 行".to_string(), "重 复 的 一 行".to_string()];
        assert_eq!(compose(&lines, 60), "重复的一行");

        // 最后一行塞不下时截一段就收手，整体不超上限。
        // 【注意别拿小于 MIN_CHARS 的数来测】compose 会把额度夹进 [MIN_CHARS, MAX_CHARS]，
        // 传 20 得到的其实是 60 —— 第一版测试就是这么假红的。
        let long = vec!["主 题 一 句 话".to_string(), "后".repeat(200)];
        let got = compose(&long, MIN_CHARS);
        assert!(got.starts_with("主题一句话\n"), "{got}");
        assert_eq!(got.chars().count(), MIN_CHARS as usize, "{got}");
    }

    #[test]
    fn compose_respects_the_hard_limits() {
        let lines: Vec<String> = (0..50).map(|i| format!("第 {i} 行 的 内 容 在 这 里")).collect();
        // 给一个超界的数也要被夹到上限里，不能真按 100 万字去拼
        let got = compose(&lines, 100_000);
        assert!(got.chars().count() <= MAX_CHARS as usize);
        let tiny = compose(&lines, 1);
        assert!(tiny.chars().count() <= MIN_CHARS as usize);
    }

    #[test]
    fn parse_output_reads_meta_and_lines() {
        let out = "#meta w=2880 h=1860 shot=92ms ocr=368ms lines=2 mode=memory\n甲 乙\n丙\n\n";
        let (meta, lines) = parse_output(out);
        assert_eq!(meta.get("w").map(String::as_str), Some("2880"));
        assert_eq!(meta.get("mode").map(String::as_str), Some("memory"));
        assert_eq!(lines, vec!["甲 乙".to_string(), "丙".to_string()]);
    }

    #[test]
    fn parse_output_survives_garbage() {
        let (meta, lines) = parse_output("");
        assert!(meta.is_empty() && lines.is_empty());
        let (_, lines) = parse_output("#meta err=no-engine");
        assert!(lines.is_empty());
    }

    // ── 「看见了就说一句」────────────────────────────────────────────────

    /// 主题要挑"像标题"的那行，而不是傻乎乎拿第一行（第一行常是播放量/时间码）
    #[test]
    fn pick_subject_prefers_a_title_shaped_line() {
        let text = "0\n17:30:00\n中学电话亭的那面墙\n弹幕列表";
        assert_eq!(pick_subject(text).as_deref(), Some("中学电话亭的那面墙"));
        // 链接不当主题
        let text2 = "https://www.bilibili.com\n小约翰可汗的奇葩小国";
        assert_eq!(pick_subject(text2).as_deref(), Some("小约翰可汗的奇葩小国"));
    }

    /// 一屏全是碎片时也得能说点什么（退回第一行够长的那个）
    #[test]
    fn pick_subject_falls_back_to_anything_usable() {
        // 4 个字：够当兜底，但还不够"像标题"（那要 5 个起）
        assert_eq!(pick_subject("一二三四\n五六七").as_deref(), Some("一二三四"));
        // 实在没东西可说就别说
        assert_eq!(pick_subject(""), None);
        assert_eq!(pick_subject("0\n1"), None);
    }

    /// 太长的主体要截（桌宠头顶只放得下两行）
    #[test]
    fn pick_subject_clips_the_long_ones() {
        let long = "标".repeat(80);
        let got = pick_subject(&long).unwrap();
        assert_eq!(got.chars().count(), SUBJECT_CHARS);
    }

    /// ★同一屏内容每次说同一句★（否则气泡每 15 秒闪一次措辞）
    #[test]
    fn local_line_is_stable_and_carries_the_subject() {
        let a = local_line("小约翰可汗的奇葩小国");
        let b = local_line("小约翰可汗的奇葩小国");
        assert_eq!(a, b);
        assert!(a.contains("小约翰可汗的奇葩小国"), "{a}");
        // 模板里那个 {} 一定要被换掉，别把占位符冒出来
        assert!(!a.contains("{}"), "{a}");
        // 内容不同 → 措辞通常会换（不强制，但至少得是句正常话）
        let c = local_line("完全不同的另一个主题");
        assert!(c.contains("完全不同的另一个主题"), "{c}");
    }

    /// 关掉「说一句」就真的不说；开着才说。
    ///
    /// 【注意 `screen_see` 要显式关掉】这条测的是**退回纯 OCR 那条老路**时的行为；
    /// 默认是开着"亲眼看"的，那时 `say_for` 故意不冒泡（等 see 回来再说）——
    /// 见 `say_for_skips_ocr_subjects_when_seeing_is_on`。
    #[test]
    fn say_for_respects_the_switch() {
        let mut cfg = crate::config::AppConfig::default();
        cfg.screen_say_mode = "local".to_string();
        cfg.screen_see = false;
        let (say, at) = say_for(&cfg, "中学电话亭的那面墙，为何成了学生的哭墙？");
        assert!(!say.is_empty());
        assert!(say.contains("中学电话亭的那面墙"));
        assert!(at > 0);

        cfg.screen_say_mode = "off".to_string();
        let (say2, at2) = say_for(&cfg, "中学电话亭的那面墙，为何成了学生的哭墙？");
        assert!(say2.is_empty());
        assert_eq!(at2, 0);
    }

    #[test]
    fn encoded_command_is_utf16le_base64() {        // 用一小段验编码形状：UTF-16LE 的 "Hi" = 48 00 69 00 → 4 字节 → "SABpAA=="
        let got = encoded_command("Hi");
        assert_eq!(got, "SABpAA==");
        // 中文也要能过（这是整个方案的前提：脚本里有中文注释）
        let cn = encoded_command("中");
        assert!(!cn.is_empty());
    }

    /// 图那一行是几十 K 字符的 base64 —— **不能**混进"屏幕上的字"里
    #[test]
    fn parse_output_keeps_the_image_out_of_the_text_lines() {
        let stdout = "#meta w=2880 h=1860 cursor=1 img=512x331\n第一行正文\n#img AAAABBBBCCCC\n第二行正文\n";
        let (meta, lines) = parse_output(stdout);
        assert_eq!(meta.get("img").map(String::as_str), Some("512x331"), "尺寸那一栏还得是尺寸");
        assert_eq!(meta.get("imgb64").map(String::as_str), Some("AAAABBBBCCCC"));
        // ★关键★ base64 不许出现成一行"文字"
        assert_eq!(lines, vec!["第一行正文".to_string(), "第二行正文".to_string()]);
        assert_eq!(meta.get("cursor").map(String::as_str), Some("1"));
    }

    /// 只有 `#img` 没内容时不该造出一个空的图
    #[test]
    fn parse_output_ignores_an_empty_image_line() {
        let (meta, lines) = parse_output("#meta w=800 h=600\n正文\n#img \n");
        assert!(!meta.contains_key("imgb64"));
        assert_eq!(lines, vec!["正文".to_string()]);
    }

    #[test]
    fn parse_size_handles_both_good_and_junk() {
        assert_eq!(parse_size("512x331"), (512, 331));
        assert_eq!(parse_size(""), (0, 0));
        assert_eq!(parse_size("512"), (0, 0));
        // 上游给不出数字时不能 panic，退成 0 就行（界面显示 0x0 也比崩了强）
        assert_eq!(parse_size("axb"), (0, 0));
    }

    /// ★同一屏内容只造一次图★ —— 否则每 5 分钟花 200 token 重看一张没变的图。
    ///
    /// 这个测试碰的是模块级的 `LAST_SHOT_FOR`（全局），所以两种情形必须在**同一个测试**
    /// 里连着验，别拆成两个（拆开跑的顺序不确定，会互相污染）。
    #[test]
    fn shot_is_built_once_per_screen_content() {
        let mut meta = std::collections::HashMap::new();
        meta.insert("imgb64".to_string(), "QUJD".to_string());
        meta.insert("img".to_string(), "512x331".to_string());
        meta.insert("w".to_string(), "2880".to_string());
        meta.insert("h".to_string(), "1860".to_string());
        meta.insert("cursor".to_string(), "1".to_string());

        let first = shot_from(&meta, "唯一的第一段屏幕内容");
        let shot = first.expect("第一次该造出图来");
        assert_eq!(shot.b64, "QUJD");
        assert_eq!((shot.w, shot.h), (512, 331));
        assert!(shot.cursor, "cursor=1 要如实传下去");
        assert_eq!(shot.size, "2880x1860");
        assert!(shot.at > 0);

        // ★同样的内容再来一次：不造★
        assert!(shot_from(&meta, "唯一的第一段屏幕内容").is_none());
        // 内容变了才再造
        assert!(shot_from(&meta, "换了一屏完全不同的内容").is_some());
        // 没有图数据（脚本没能编码出来）→ 什么都不造
        assert!(shot_from(&std::collections::HashMap::new(), "又换了一屏").is_none());
    }

    /// ★这是主人报的"她有时候说的是乱码"那个 bug★
    ///
    /// 小字号的中文，Windows OCR 会**把字拆成部件** —— 拆出来的是合法汉字，靠"像不像字"
    /// 判不出来；但它们都是**独用字**（正常文本里不会单独出现），所以能精确抠掉。
    #[test]
    fn broken_ocr_radicals_are_stripped() {
        // 全部是实测样本（屏幕上是 DSH 的界面，13~15px 正文）
        assert_eq!(strip_radicals("Memory EvoIve 讠 殳 置"), "Memory EvoIve 置");
        assert_eq!(strip_radicals("时 亻 制 台 宽"), "时制台宽");
        assert_eq!(strip_radicals("扌 斤 行"), "斤行");
        assert_eq!(strip_radicals("氵 肖 息"), "肖息");
        assert_eq!(strip_radicals("爿 珩 base64"), "珩 base64");
        // 行尾那个被认成 丷 的引号
        assert_eq!(strip_radicals("模 式 中 丷"), "模式中");
        // ★正常内容一个都不许动★（这是这个函数唯一的风险）
        assert_eq!(strip_radicals("安装与配置"), "安装与配置");
        assert_eq!(strip_radicals("Visual Studio Code"), "Visual Studio Code");
        assert_eq!(strip_radicals("设置"), "设置");
        assert_eq!(strip_radicals(""), "");
    }

    /// 抠过偏旁的行要真的进到喂给她的那段里
    #[test]
    fn compose_strips_radicals_end_to_end() {
        let lines = vec![
            "0 露 娜 模 式 \" 1 个 后 台 任 务 运 行 中 丷".to_string(),
            "爿 珩 base64 有 两 万 多 个 字 符".to_string(),
        ];
        let t = compose(&lines, 400);
        assert!(!t.contains('丷'), "那个引号碎片要没了：{t}");
        assert!(!t.contains('爿'), "「爿」要没了：{t}");
        // 剩下的真内容一个字都不能少
        assert!(t.contains("露娜模式"), "{t}");
        assert!(t.contains("个后台任务运行中"), "{t}");
        assert!(t.contains("base64"), "{t}");
    }

    /// 气泡那句取的是她"亲眼看"回来的**重点**那行
    #[test]
    fn subject_from_see_prefers_the_focus_line() {
        let see = "在做什么：正在查看一个验证窗口。\n重点：release code 7788";
        assert_eq!(subject_from_see(see).as_deref(), Some("release code 7788"));
        // 模型没照格式来 → 退回第一行，并且把"在做什么："这个前缀去掉
        assert_eq!(subject_from_see("在做什么：在看文档").as_deref(), Some("在看文档"));
        assert_eq!(subject_from_see("随便写了一句").as_deref(), Some("随便写了一句"));
        // 空的 / 只有一个字的 → 没有主题，别冒泡
        assert!(subject_from_see("").is_none());
        assert!(subject_from_see("重").is_none());
    }

    /// 开着"亲眼看"时**不用 OCR 挑主题** —— 那正是乱码的来源
    #[test]
    fn say_for_skips_ocr_subjects_when_seeing_is_on() {
        let mut cfg = crate::config::AppConfig::default();
        cfg.screen_say_mode = "local".to_string();
        let text = "中学电话亭的那面墙，为何成了学生的哭墙？";

        cfg.screen_see = true;
        let (say, at) = say_for(&cfg, text);
        assert!(say.is_empty(), "开着亲眼看时不该拿 OCR 挑的主题冒泡：{say}");
        assert_eq!(at, 0);

        // 关掉"亲眼看"（退回纯 OCR 那条老路）才用本地主题
        cfg.screen_see = false;
        let (say2, at2) = say_for(&cfg, text);
        assert!(say2.contains("中学电话亭"), "{say2}");
        assert!(at2 > 0);
    }

    /// 她"亲眼看"回来的那段：空的要拒掉，长的要截断（它下一轮就进上下文）
    #[test]
    fn note_seen_rejects_empty_and_clips_the_rest() {        assert!(!note_seen("   ", "512x331"), "空回复不该被记下来");

        let long = "重点".repeat(SEE_CHARS); // 远超上限
        assert!(note_seen(&long, "512x331"));
        let snap = snapshot();
        assert_eq!(snap.see.chars().count(), SEE_CHARS, "要截到 SEE_CHARS");
        assert_eq!(snap.see_size, "512x331");
        assert!(snap.see_at > 0);
        // ★亲眼看过的那段要压过 OCR 那版★（render_block 的优先级就靠这个）
        assert!(render_block(&{
            let mut c = crate::config::AppConfig::default();
            c.screen_watch = true;
            c
        })
        .contains("你自己看了一眼"));
    }
}
