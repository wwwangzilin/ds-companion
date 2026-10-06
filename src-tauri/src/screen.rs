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
}

/// 上一次尝试的时间 + 最近一次结果。**只在内存里**：退出即散。
#[derive(Default)]
struct State {
    last_try: u64,
    snap: Option<Snapshot>,
}

static STATE: Mutex<Option<State>> = Mutex::new(None);

/// 上一轮注入进对话的那段文本 —— 和这次一模一样就不再注入（同一个页面盯久了不该每轮都花额度）
static LAST_INJECTED: Mutex<Option<String>> = Mutex::new(None);

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

/// 把一批原始行收拾成"要喂给她的那一段"。
///
/// 顺序是**屏幕上从上到下**的（OCR 就是这么给的）—— 网页标题一般在最上面，
/// 于是自然落在前面，正是最该让她看到的那部分。截断按**字符数**。
pub fn compose(lines: &[String], max_chars: u32) -> String {
    let max = max_chars.clamp(MIN_CHARS, MAX_CHARS) as usize;
    let mut out = String::new();
    let mut seen: Vec<String> = Vec::new();
    for raw in lines {
        let t = squeeze(raw);
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
pub fn local_line(subject: &str) -> String {
    const TPL: &[&str] = &[
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
    if snap.text.trim().is_empty() {
        return String::new();
    }
    {
        let mut last = match LAST_INJECTED.lock() {
            Ok(g) => g,
            Err(p) => p.into_inner(),
        };
        if last.as_deref() == Some(snap.text.as_str()) {
            return String::new();
        }
        *last = Some(snap.text.clone());
    }
    format!(
        "【他屏幕上】大概写着这些：\n{}\n【这是你自己瞄到的一眼，不是他念给你听的：别复述、别逐条报，最多顺着提一句。真要用就拿它当由头，别当谈资。】",
        snap.text
    )
}

/// 主人关掉这个开关时，把"上一轮注入过什么"清掉 —— 免得下次打开时第一轮被去重吃掉
pub fn forget_last_injected() {
    if let Ok(mut g) = LAST_INJECTED.lock() {
        *g = None;
    }
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

    /// 关掉「说一句」就真的不说；开着才说
    #[test]
    fn say_for_respects_the_switch() {
        let mut cfg = crate::config::AppConfig::default();
        cfg.screen_say_mode = "local".to_string();
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
}
