//! 他此刻在用哪个软件（前台窗口）—— **默认关，要主人点头才开**。
//!
//! 【为什么它需要一个开关】这一层读的是「他在干什么」。哪怕只是个进程名，那也已经
//! 越过了"聊天内容"这条线，所以：默认关、设置里明说、敏感进程连名字都不给、只在本机处理。
//!
//! 【为什么只报进程名，绝不报窗口标题】标题里什么都有 —— 网页标题（他在看什么）、
//! 邮件主题、文件名、密码管理器里那条记录的名字。要报标题就得维护一串**永远不全**的
//! 黑名单，那不如不报。进程名已经够用：知道是 `Code.exe` 还是 `chrome.exe`，她就说对话。
//!
//! 【为什么不用 get-windows / active-win-pos-rs 那些 crate】本机 cargo 缓存里没有它们，
//! 而这个项目的取向是"离线也编得出来"。这里的需要只有五个 API，裸 FFI 就够 ——
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
}

impl FrontApp {
    fn new(exe: &str, kind: &str) -> Self {
        Self {
            exe: exe.to_string(),
            kind: kind.to_string(),
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

#[cfg(windows)]
mod imp {
    use super::{classify, exe_of, is_sensitive, FrontApp};

    #[allow(non_camel_case_types)]
    type HWND = *mut core::ffi::c_void;
    #[allow(non_camel_case_types)]
    type HANDLE = *mut core::ffi::c_void;

    #[link(name = "user32")]
    extern "system" {
        fn GetForegroundWindow() -> HWND;
        fn GetWindowThreadProcessId(hwnd: HWND, pid: *mut u32) -> u32;
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

    /// 现在的前台窗口是哪个进程。
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
            // ★敏感进程：连名字都不给★（只回一个 other，主人自己知道那是什么）
            if is_sensitive(&exe) {
                return Some(FrontApp::new("", "other"));
            }
            let kind = classify(&exe);
            Some(FrontApp::new(&exe, &kind))
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

/// 观测量到的一句话（`Code.exe · IDE · 已经 47 分钟`）。敏感进程只给"在别的软件里"。
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
    let mins = since_ms / 60_000;
    if mins >= 5 {
        format!("{}（{}，已经 {} 分钟）", app.exe, kind, mins)
    } else {
        format!("{}（{}）", app.exe, kind)
    }
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
        assert!(FrontApp::new("Code.exe", "ide").means_busy());
        assert!(FrontApp::new("pwsh.exe", "terminal").means_busy());
        assert!(!FrontApp::new("chrome.exe", "browser").means_busy());
        assert!(!FrontApp::new("steam.exe", "game").means_busy());
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

    /// 短时间不报分钟数（"已经 0 分钟"很蠢），超过 5 分钟才说
    #[test]
    fn describe_only_counts_minutes_when_it_matters() {
        let app = FrontApp::new("Code.exe", "ide");
        assert_eq!(describe(&app, 0), "Code.exe（写代码）");
        assert_eq!(describe(&app, 4 * 60_000), "Code.exe（写代码）");
        assert_eq!(describe(&app, 47 * 60_000), "Code.exe（写代码，已经 47 分钟）");
        // 敏感进程：连名字都不出现
        let blind = FrontApp::new("", "other");
        assert_eq!(describe(&blind, 0), "在别的软件里");
    }
}
