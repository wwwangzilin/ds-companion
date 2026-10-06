//! 他此刻在用哪个软件、**在看什么**（前台窗口）—— 默认关，要主人点头才开。
//!
//! 【为什么它需要一个开关】这一层读的是「他在干什么」。哪怕只是个进程名，那也已经
//! 越过了"聊天内容"这条线，所以：默认关、设置里明说、敏感进程连名字都不给、只在本机处理。
//!
//! 【为什么现在连窗口标题也读】第一版只报进程名，理由是"标题里什么都有"。那个理由只对了
//! 一半：`chrome.exe` 什么都说明不了（查资料和刷视频是同一个进程名），而**标题才真正回答
//! "他在看什么"** —— 那正是主人要的那件事。所以现在默认连标题一起读，并且：
//!   ① 敏感进程（密码管理器 / 银行 / 支付）**连标题带名字一起打码**，只回"在别的软件里"；
//!   ② 标题只在本机用：不落盘、不外发，只拼进那一轮给她的上下文；
//!   ③ 标题先清洗（去未读计数、去" - Google Chrome"这类应用名尾巴、截断过长）；
//!   ④ 设置里留了一个「只要进程名」的开关，随时能退回最保守的那一档。
//! 一句话：**读得到 ≠ 念出来**。注入块里写明了"那是你瞄到的一眼，别一个字一个字念"。
//!
//! 【为什么不读浏览器地址栏】地址栏得靠 UI Automation 遍历控件树才拿得到（慢、脆、浏览器
//! 一升级就失效），而且它比标题更敏感（query string 里有搜索词，有时还带着 token）。
//! 标题里已经含页面标题，够用了。
//!
//! 【为什么不用 get-windows / active-win-pos-rs 那些 crate】本机 cargo 缓存里没有它们，
//! 而这个项目的取向是"离线也编得出来"。这里要的只有七个 API，裸 FFI 就够 ——
//! 而且**一个依赖都不加**，也就不会撞上版本解析。
//!
//! 【为什么整块 cfg(windows)】crate-type 里有 staticlib/cdylib（Android 的目标），
//! 非 Windows 上得有桩，否则编译不过。

/// 她眼里"他在干什么"的粗分类 —— **不是**给主人看的，是给注入块与安静模式用的
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FrontApp {
    /// 进程名（"Code.exe"）。敏感进程会被换成空串
    pub exe: String,
    /// ide / terminal / browser / chat / game / media / other
    pub kind: String,
    /// 窗口标题，**清洗过**的（空 = 没读到、没有信息、或者是敏感进程）
    pub title: String,
}

impl FrontApp {
    fn new(exe: &str, kind: &str, title: &str) -> Self {
        Self {
            exe: exe.to_string(),
            kind: kind.to_string(),
            title: title.to_string(),
        }
    }

    /// 这个分类算不算"他在干正事"（安静模式据此收着点）
    ///
    /// 【为什么只有 IDE 与终端】浏览器的分类说明不了任何事 —— 查资料和刷视频是同一个
    /// `chrome.exe`。而 IDE / 终端基本就是"在写代码"，那是这个项目最该让路的场景。
    pub fn means_busy(&self) -> bool {
        self.kind == "ide" || self.kind == "terminal"
    }
}

/// 写代码
const IDE: &[&str] = &[
    "code.exe",
    "code - insiders.exe",
    "cursor.exe",
    "devenv.exe",
    "idea64.exe",
    "pycharm64.exe",
    "webstorm64.exe",
    "goland64.exe",
    "clion64.exe",
    "rustrover64.exe",
    "rider64.exe",
    "sublime_text.exe",
    "notepad++.exe",
    "zed.exe",
    "nvim.exe",
    "vim.exe",
    "emacs.exe",
    "android studio.exe",
];
/// 终端
const TERMINAL: &[&str] = &[
    "windowsterminal.exe",
    "wt.exe",
    "powershell.exe",
    "pwsh.exe",
    "cmd.exe",
    "conhost.exe",
    "alacritty.exe",
    "wezterm-gui.exe",
    "mintty.exe",
    "git-bash.exe",
    "bash.exe",
    "wsl.exe",
    "cargo.exe",
    "rustc.exe",
];
/// 浏览器（**刻意不进 means_busy**：同一进程名说明不了他在干什么）
const BROWSER: &[&str] = &[
    "chrome.exe",
    "msedge.exe",
    "firefox.exe",
    "brave.exe",
    "opera.exe",
    "vivaldi.exe",
    "iexplore.exe",
    "360se.exe",
    "360chrome.exe",
    "qqbrowser.exe",
    "sogouexplorer.exe",
];
/// 聊天
const CHAT: &[&str] = &[
    "wechat.exe",
    "weixin.exe",
    "qq.exe",
    "telegram.exe",
    "discord.exe",
    "slack.exe",
    "teams.exe",
    "ms-teams.exe",
    "dingtalk.exe",
    "feishu.exe",
    "lark.exe",
];
/// 影音
const MEDIA: &[&str] = &[
    "potplayermini64.exe",
    "potplayer.exe",
    "vlc.exe",
    "mpv.exe",
    "mpc-hc64.exe",
    "bilibili.exe",
    "cloudmusic.exe",
    "qqmusic.exe",
    "spotify.exe",
];
/// 游戏平台（具体游戏名太多，列平台就够判断"他在玩"）
const GAME: &[&str] = &["steam.exe", "steamwebhelper.exe", "epicgameslauncher.exe", "battle.net.exe"];

/// 敏感进程：**连进程名都不给**，一律按 other 处理。
///
/// 【为什么是子串匹配而不是全等】这些软件各版本改名很勤（`KeePassXC.exe` / `keepass.exe`），
/// 全等匹配漏一个就等于没做。宁可误伤（某个叫 `bank-notes.exe` 的被归成 other），
/// 也不要漏 —— 误伤的代价只是她少知道一个软件名。
const SENSITIVE: &[&str] = &[
    "keepass",
    "1password",
    "bitwarden",
    "lastpass",
    "dashlane",
    "enpass",
    "nordpass",
    "wallet",
    "bank",
    "alipay",
    "paypal",
    "1pass",
    "authenticator",
];

/// 大小写不敏感的全等匹配（进程名各家用得乱，`Code.exe` / `code.exe` 都见过）
fn hit(list: &[&str], exe_lower: &str) -> bool {
    list.iter().any(|x| *x == exe_lower)
}

/// 进程名 → 粗分类。**纯函数，可单测**。
pub fn classify(exe: &str) -> String {
    let lower = exe.trim().to_ascii_lowercase();
    if lower.is_empty() {
        return "other".to_string();
    }
    let kind = if hit(IDE, &lower) {
        "ide"
    } else if hit(TERMINAL, &lower) {
        "terminal"
    } else if hit(BROWSER, &lower) {
        "browser"
    } else if hit(CHAT, &lower) {
        "chat"
    } else if hit(MEDIA, &lower) {
        "media"
    } else if hit(GAME, &lower) {
        "game"
    } else {
        "other"
    };
    kind.to_string()
}

/// 这个进程名敏不敏感（子串匹配，见 `SENSITIVE` 的说明）
pub fn is_sensitive(exe: &str) -> bool {
    let lower = exe.trim().to_ascii_lowercase();
    if lower.is_empty() {
        return false;
    }
    SENSITIVE.iter().any(|x| lower.contains(x))
}

/// 从一条完整路径里取文件名（`C:\...\Code.exe` → `Code.exe`）
fn exe_of(path: &str) -> String {
    path.rsplit(['\\', '/'])
        .next()
        .unwrap_or(path)
        .trim()
        .to_string()
}

// ─────────────────────── 窗口标题的清洗 ───────────────────────
//
// 【为什么必须清洗】原生标题是给"人眼扫一眼任务栏"用的，直接塞进上下文又难看又费额度：
//   "Tauri 2 窗口透明怎么实现 - Google Chrome"   ← 那个" - Google Chrome"该说掉
//   "(3) 微信"                                  ← 未读数不是内容
// 清洗的哲学是**只删明显不是内容的部分**：切不掉最多是难看一眼；切错了才会丢信息。

/// 标题尾巴上常见的应用名。
///
/// 【为什么用表】判"最后一段是不是应用名"只有两条路：跟进程名比、跟已知名字比。而进程名
/// 比不上的多着呢 —— `potplayermini64.exe` 的标题尾巴写的是 `PotPlayer`。所以得有一张表。
/// **这张表永远不全**，但漏切的代价只是尾巴难看一眼，不是读不到东西；不值得为它上更复杂的
/// 启发式（试过"尾巴是纯英文就切"，会把 `GitHub - wwwangzilin/ds-companion` 切成 `GitHub`）。
const APP_SUFFIX: &[&str] = &[
    "google chrome",
    "microsoft edge",
    "mozilla firefox",
    "firefox",
    "opera",
    "brave",
    "vivaldi",
    "visual studio code",
    "visual studio",
    "intellij idea",
    "android studio",
    "pycharm",
    "webstorm",
    "goland",
    "notepad++",
    "notepad",
    "sublime text",
    "potplayer",
    "vlc media player",
    "vlc",
    "mpc-hc",
    "word",
    "excel",
    "powerpoint",
    "wps office",
    "wps文字",
    "wps表格",
    "windows terminal",
    "windows 终端",
    "文件资源管理器",
    "file explorer",
    "360安全浏览器",
    "qq浏览器",
];

/// 标题里的分隔符（各家写法不一；中文标题里最常见的是全角破折号和竖线）
const TITLE_SEPS: &[&str] = &[" - ", " — ", " – ", " | ", " · ", " − "];
/// 标题最多留这么多个字 —— 再长的一定是哪儿不对，而且塞进上下文纯浪费
const MAX_TITLE_CHARS: usize = 60;

/// 比较用：去空白 + 转小写
fn norm(s: &str) -> String {
    s.trim().to_ascii_lowercase().replace(' ', "")
}

/// 进程名 → 它的"应用名"（`Code.EXE` → `code`），用来跟标题尾巴比对
fn app_of(exe: &str) -> String {
    let n = norm(exe);
    match n.strip_suffix(".exe") {
        Some(s) => s.to_string(),
        None => n,
    }
}

/// 去掉标题开头的未读计数（`(3) 微信` / `[2] 标题` / `• 标题`）
fn strip_unread(t: &str) -> &str {
    let mut s = t.trim();
    for p in ["•", "●", "*", "·"] {
        if let Some(rest) = s.strip_prefix(p) {
            s = rest.trim_start();
        }
    }
    // 只认**纯数字**的括号：`(重要) 标题` 那种是内容，别一起吃掉
    let mut chars = s.chars();
    if let Some(open) = chars.next() {
        if open == '(' || open == '[' {
            let close = if open == '(' { ')' } else { ']' };
            if let Some(pos) = s.find(close) {
                let inner = &s[1..pos];
                if !inner.is_empty() && inner.chars().all(|c| c.is_ascii_digit()) {
                    s = s[pos + 1..].trim_start();
                }
            }
        }
    }
    s
}

/// 把连续空白折成一个空格（标题里常有全角空格和多余空白）
fn collapse_spaces(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut prev = false;
    for c in s.trim().chars() {
        if c.is_whitespace() {
            if !prev {
                out.push(' ');
            }
            prev = true;
        } else {
            out.push(c);
            prev = false;
        }
    }
    out
}

/// 找最后一个分隔符，切成（前面, 最后一段）
fn split_last_sep(t: &str) -> Option<(&str, &str)> {
    let mut best: Option<(usize, usize)> = None;
    for sep in TITLE_SEPS {
        if let Some(i) = t.rfind(sep) {
            if best.map_or(true, |(s, _)| i > s) {
                best = Some((i, sep.len()));
            }
        }
    }
    best.map(|(i, l)| (&t[..i], &t[i + l..]))
}

fn clip(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_string();
    }
    let mut out: String = s.chars().take(max).collect();
    out.push('…');
    out
}

/// 这个（已经 norm 过的）尾巴是不是"某个应用的名字"。
///
/// 【为什么两边都要 norm】表里写的是人看得懂的形式（`Google Chrome`），而比较前会把空白
/// 抹掉（标题尾巴写成 `GoogleChrome` / `google chrome` 的都有）。**第一版忘了归一化表项**，
/// 于是 `" - Google Chrome"` 一条都切不掉 —— 测试当场红光满面。
fn in_suffix_table(n: &str) -> bool {
    !n.is_empty() && APP_SUFFIX.iter().any(|x| norm(x) == n)
}

/// 清洗窗口标题。`exe` 用来判"最后一段是不是这个程序自己的名字"。
///
/// 返回空串 = **这条标题没有信息**（就剩它自己的名字、或者本来就是空的），
/// 调用方照旧只报进程名。
pub fn clean_title(raw: &str, exe: &str) -> String {
    let collapsed = collapse_spaces(strip_unread(raw));
    if collapsed.is_empty() {
        return String::new();
    }
    let app = app_of(exe);

    let mut head: &str = &collapsed;
    if let Some((h, tail)) = split_last_sep(&collapsed) {
        let tail_n = norm(tail);
        // 只看**最后一段**：`A - B - C` 里 C 才是应用名（B 可能是文件名）
        if tail_n == app || in_suffix_table(&tail_n) {
            head = h;
        }
    }
    let head = head.trim();
    if head.is_empty() {
        return String::new();
    }
    // 标题就剩**它自己**的名字 = 没有信息。
    //
    // 【为什么只判这一种】"微信"（进程名 wechat.exe）这种显示名跟进程名对不上，判不出来。
    // 与其拿一张中文应用名表去猜（猜错就是把真标题吃掉），不如照报 ——
    // 多说一句"她在微信上"不是错。
    if !app.is_empty() && norm(head) == app {
        return String::new();
    }
    clip(head, MAX_TITLE_CHARS)
}

#[cfg(windows)]
mod imp {
    use super::{classify, clean_title, exe_of, is_sensitive, FrontApp};

    #[allow(non_camel_case_types)]
    type HWND = *mut core::ffi::c_void;
    #[allow(non_camel_case_types)]
    type HANDLE = *mut core::ffi::c_void;

    #[link(name = "user32")]
    extern "system" {
        fn GetForegroundWindow() -> HWND;
        fn GetWindowThreadProcessId(hwnd: HWND, pid: *mut u32) -> u32;
        fn GetWindowTextLengthW(hwnd: HWND) -> i32;
        fn GetWindowTextW(hwnd: HWND, buf: *mut u16, max: i32) -> i32;
    }

    #[link(name = "kernel32")]
    extern "system" {
        fn OpenProcess(access: u32, inherit: i32, pid: u32) -> HANDLE;
        fn QueryFullProcessImageNameW(
            h: HANDLE,
            flags: u32,
            buf: *mut u16,
            size: *mut u32,
        ) -> i32;
        fn CloseHandle(h: HANDLE) -> i32;
    }

    /// PROCESS_QUERY_LIMITED_INFORMATION —— 权限最小的那一档，够读进程名
    const QUERY_LIMITED: u32 = 0x1000;

    /// 读前台窗口的标题。
    ///
    /// 【为什么这样是安全的】`GetWindowTextW` 对**别的进程**的窗口读的是内核缓存的那份标题，
    /// 不会给目标进程发 `WM_GETTEXT` —— 所以目标卡死了也不会把我们拖住。提权进程的窗口读回来
    /// 是空的，那也没关系：没有标题就只报进程名。
    fn window_title(hwnd: HWND) -> String {
        unsafe {
            let len = GetWindowTextLengthW(hwnd);
            if len <= 0 {
                return String::new();
            }
            // 上限 512：窗口标题正常就几十个字，超过这个数一定是哪儿不对
            let cap = (len as usize + 1).min(512);
            let mut buf = vec![0u16; cap];
            let n = GetWindowTextW(hwnd, buf.as_mut_ptr(), cap as i32);
            if n <= 0 {
                return String::new();
            }
            String::from_utf16_lossy(&buf[..n as usize])
        }
    }

    /// 现在的前台窗口是哪个进程、窗口标题是什么。
    ///
    /// 任何一步失败都回 `None`（而不是编一个值）：这一层是**锦上添花**，
    /// 没有它，后面那些功能照常工作。
    pub fn current() -> Option<FrontApp> {
        unsafe {
            let hwnd = GetForegroundWindow();
            if hwnd.is_null() {
                return None;
            }
            let mut pid: u32 = 0;
            if GetWindowThreadProcessId(hwnd, &mut pid) == 0 || pid == 0 {
                return None;
            }
            let h = OpenProcess(QUERY_LIMITED, 0, pid);
            if h.is_null() {
                // 权限不够（系统进程/提权进程）—— 正常现象，不是错误
                return None;
            }
            let mut buf = [0u16; 512];
            let mut size = buf.len() as u32;
            let ok = QueryFullProcessImageNameW(h, 0, buf.as_mut_ptr(), &mut size);
            CloseHandle(h);
            if ok == 0 || size == 0 {
                return None;
            }
            let full = String::from_utf16_lossy(&buf[..size as usize]);
            let exe = exe_of(&full);
            if exe.is_empty() {
                return None;
            }
            // ★敏感进程：连名字带标题一起打码★（只回一句"在别的软件里"，
            // 主人自己知道他开着什么，而她不需要知道）
            if is_sensitive(&exe) {
                return Some(FrontApp::new("", "other", ""));
            }
            let kind = classify(&exe);
            let title = clean_title(&window_title(hwnd), &exe);
            Some(FrontApp::new(&exe, &kind, &title))
        }
    }
}

#[cfg(not(windows))]
mod imp {
    use super::FrontApp;
    /// 非 Windows 一律没有 —— 非要有的话就得每个平台写一套，不值。
    pub fn current() -> Option<FrontApp> {
        None
    }
}

pub use imp::current;

// ───────────────────── 他在这件事上待了多久 ─────────────────────
//
// 【为什么要它】"他在 Code.exe 里"和"他已经在 Code.exe 里三个小时了"是两句话 ——
// 后者才是她会心疼的那句。窗口每轮都可能是同一个，所以要自己记"什么时候换过来的"。

static SINCE: std::sync::Mutex<Option<(String, u64)>> = std::sync::Mutex::new(None);

/// 记一次观测，返回「这个进程已经持续多久（毫秒）」。换进程就从这一刻重新计时。
pub fn note(app: &FrontApp, now_ms: u64) -> u64 {
    let Ok(mut g) = SINCE.lock() else {
        return 0;
    };
    match g.as_ref() {
        Some((exe, at)) if *exe == app.exe => now_ms.saturating_sub(*at),
        _ => {
            *g = Some((app.exe.clone(), now_ms));
            0
        }
    }
}

/// 观测量到的一句话（`Code.exe（写代码），窗口是「front.rs - ds-companion」，已经 47 分钟`）。
///
/// 【为什么标题用「」包起来】它是**别人写的一串字**（网页标题、文件名），不是我们的话 ——
/// 包起来能让模型一眼分清"哪部分是他的环境、哪部分是我的描述"。
/// 敏感进程只给"在别的软件里"，一个字的标题都不带。
pub fn describe(app: &FrontApp, since_ms: u64) -> String {
    if app.exe.is_empty() {
        return "在别的软件里".to_string();
    }
    let kind = match app.kind.as_str() {
        "ide" => "写代码",
        "terminal" => "敲命令",
        "browser" => "看网页",
        "chat" => "聊天",
        "media" => "看片子",
        "game" => "打游戏",
        _ => "忙别的",
    };
    let mut s = format!("{}（{}）", app.exe, kind);
    if !app.title.is_empty() {
        s.push_str(&format!("，窗口是「{}」", app.title));
    }
    let mins = since_ms / 60_000;
    if mins >= 5 {
        s.push_str(&format!("，已经 {} 分钟", mins));
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classify_known_apps() {
        assert_eq!(classify("Code.exe"), "ide");
        // 大小写不敏感：各家进程名写法不一
        assert_eq!(classify("code.exe"), "ide");
        assert_eq!(classify("WindowsTerminal.exe"), "terminal");
        assert_eq!(classify("chrome.exe"), "browser");
        assert_eq!(classify("WeChat.exe"), "chat");
        assert_eq!(classify("steam.exe"), "game");
        assert_eq!(classify(""), "other");
        assert_eq!(classify("某个没见过的.exe"), "other");
    }

    /// ★只有 IDE 与终端算"在干正事"★ —— 浏览器说明不了任何事（查资料和刷视频同进程名）
    #[test]
    fn only_ide_and_terminal_mean_busy() {
        assert!(FrontApp::new("Code.exe", "ide", "").means_busy());
        assert!(FrontApp::new("pwsh.exe", "terminal", "").means_busy());
        assert!(!FrontApp::new("chrome.exe", "browser", "").means_busy());
        assert!(!FrontApp::new("steam.exe", "game", "").means_busy());
    }

    /// ★敏感进程必须被认出来★（子串匹配：各版本改名很勤）
    #[test]
    fn sensitive_is_substring_matched() {
        assert!(is_sensitive("KeePassXC.exe"));
        assert!(is_sensitive("keepass.exe"));
        assert!(is_sensitive("1Password.exe"));
        assert!(is_sensitive("Bitwarden.exe"));
        assert!(!is_sensitive("Code.exe"));
        assert!(!is_sensitive("chrome.exe"));
        assert!(!is_sensitive(""));
    }

    #[test]
    fn exe_of_takes_the_file_name() {
        assert_eq!(exe_of("C:\\Program Files\\X\\Code.exe"), "Code.exe");
        assert_eq!(exe_of("/usr/bin/bash"), "bash");
        assert_eq!(exe_of("Code.exe"), "Code.exe");
    }

    #[test]
    fn app_of_drops_the_extension_case_insensitively() {
        assert_eq!(app_of("Code.EXE"), "code");
        assert_eq!(app_of("notepad++.exe"), "notepad++");
        assert_eq!(app_of("bash"), "bash");
    }

    // ── 标题清洗 ─────────────────────────────────────────────────────

    /// 尾巴上的应用名要去掉（两边写法都见过：跟进程名一样、或者完全另一个名字）
    #[test]
    fn clean_title_drops_the_app_tail() {
        // 尾巴就是进程名
        assert_eq!(
            clean_title("Tauri 2 窗口透明 - Notepad++", "notepad++.exe"),
            "Tauri 2 窗口透明"
        );
        // 尾巴是"另一个名字"（进程名 potplayermini64，标题写 PotPlayer）→ 靠表
        assert_eq!(
            clean_title("进击的巨人 01.mp4 - PotPlayer", "potplayermini64.exe"),
            "进击的巨人 01.mp4"
        );
        assert_eq!(
            clean_title("某个页面标题 - Google Chrome", "chrome.exe"),
            "某个页面标题"
        );
    }

    /// ★但真内容一个字都不能切掉★（这条是上一版"尾巴是英文就切"栽过的地方）
    #[test]
    fn clean_title_keeps_real_content() {
        assert_eq!(
            clean_title("GitHub - wwwangzilin/ds-companion", "chrome.exe"),
            "GitHub - wwwangzilin/ds-companion"
        );
        // 中文标题里的破折号是内容的一部分
        assert_eq!(
            clean_title("她说 - 然后走了", "chrome.exe"),
            "她说 - 然后走了"
        );
        // 只切**最后一段**：中间那段可能是文件名
        assert_eq!(
            clean_title("front.rs - ds-companion - Visual Studio Code", "code.exe"),
            "front.rs - ds-companion"
        );
    }

    /// 未读计数和各种前缀不是内容
    #[test]
    fn clean_title_strips_unread_prefix() {
        assert_eq!(clean_title("(3) 微信", "wechat.exe"), "微信");
        assert_eq!(clean_title("(12) 某个群 - Google Chrome", "chrome.exe"), "某个群");
        assert_eq!(clean_title("• 标题", "chrome.exe"), "标题");
        // 括号里不是数字就是内容，别一起吃掉
        assert_eq!(clean_title("(重要) 会议纪要", "chrome.exe"), "(重要) 会议纪要");
    }

    /// 标题没有信息时给空串（调用方照旧只报进程名）
    #[test]
    fn clean_title_drops_meaningless_titles() {
        // 整条标题就是**这个程序自己**的名字
        assert_eq!(clean_title("Notepad++", "notepad++.exe"), "");
        assert_eq!(clean_title("Notepad++ - Notepad++", "notepad++.exe"), "");
        assert_eq!(clean_title("", "chrome.exe"), "");
        assert_eq!(clean_title("   ", "chrome.exe"), "");
        assert_eq!(clean_title("·", "chrome.exe"), "");
        // ★但显示名跟进程名对不上时判不出来，就照报★ —— "她在微信上"不是错，
        // 拿一张中文应用名表去猜、猜错把真标题吃掉才是错
        assert_eq!(clean_title("微信", "wechat.exe"), "微信");
        // 别的应用名留在标题里，那是真内容
        assert_eq!(clean_title("Notepad++", "chrome.exe"), "Notepad++");
    }

    /// 超长标题要截断（不然一整篇网页标题都塞进上下文）
    #[test]
    fn clean_title_clips_the_long_ones() {
        let long = "标".repeat(200);
        let out = clean_title(&long, "chrome.exe");
        assert_eq!(out.chars().count(), MAX_TITLE_CHARS + 1); // 60 个字 + 省略号
        assert!(out.ends_with('…'));
    }

    #[test]
    fn clean_title_folds_whitespace() {
        assert_eq!(clean_title("  标题　  带  空白 ", "chrome.exe"), "标题 带 空白");
    }

    /// 短时间不报分钟数（"已经 0 分钟"很蠢），超过 5 分钟才说
    #[test]
    fn describe_only_counts_minutes_when_it_matters() {
        let app = FrontApp::new("Code.exe", "ide", "");
        assert_eq!(describe(&app, 0), "Code.exe（写代码）");
        assert_eq!(describe(&app, 4 * 60_000), "Code.exe（写代码）");
        assert_eq!(
            describe(&app, 47 * 60_000),
            "Code.exe（写代码），已经 47 分钟"
        );
        // 敏感进程：连名字带标题都不出现
        let blind = FrontApp::new("", "other", "");
        assert_eq!(describe(&blind, 0), "在别的软件里");
    }

    /// 有标题时，那一句里要**同时**有进程名、标题和时长 —— 三样缺一就不是"她看到的样子"
    #[test]
    fn describe_carries_the_window_title() {
        let app = FrontApp::new("msedge.exe", "browser", "Tauri 2 透明窗口 - 掘金");
        let s = describe(&app, 12 * 60_000);
        assert_eq!(
            s,
            "msedge.exe（看网页），窗口是「Tauri 2 透明窗口 - 掘金」，已经 12 分钟"
        );
        // 没标题时不硬凑一个空的「」
        let app = FrontApp::new("msedge.exe", "browser", "");
        assert_eq!(describe(&app, 0), "msedge.exe（看网页）");
    }
}
