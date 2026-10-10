//! 桌宠的「手脚」：按她的实际范围决定吃不吃鼠标、被拖起来甩出去、自己在屏幕上走。
//!
//! 【铁律：这一拍线程绝不走 Tauri 的窗口 API】
//! Tauri 的 `set_position` / `set_ignore_cursor_events` 这类**写操作**在 Windows 上是
//! `send_user_message` —— 把消息丢给事件循环再**等它处理完**。而事件循环就跑在主线程上，
//! 主线程此刻可能正卡在一个同步 command 里（比如设置窗口问 `dsc_pet_window`），
//! 于是两边互等：她这一拍等主线程，主线程等这一拍 —— 整个 app 变成"未响应"。
//! 本小姐实测踩过这一下（进程 Responding=False、设置窗口 8 秒不回话）。
//! 所以这里一律直接调 Win32（`SetWindowPos` / `SetWindowLongW` / `GetWindowRect`…），
//! 不经过事件循环；对外暴露的状态也全部走**缓存**，主线程来问只会读内存。
//!
//! 【为什么不用 Tauri 的 startDragging】`Window::start_dragging()` 在 Windows 上是
//! `SendMessage(WM_NCLBUTTONDOWN, HTCAPTION)` —— 它会阻塞到拖拽结束（系统自己跑一个
//! 模态循环），期间拿不到窗口位置，也就拿不到抛掷速度。自己按 `GetCursorPos` 跟手移动，
//! 位置和速度都在手上，松手那一刻直接接物理积分，一条链路、没有模态循环。
//!
//! 【为什么命中判定在壳里】窗口一旦进入"穿透"，页面收不到任何鼠标事件，也就永远不知道
//! 鼠标什么时候进到她身上 —— 这是个死锁。所以只能由壳每拍问系统「光标在哪」，
//! 再和她身体的矩形比。矩形由页面量出来（扫 alpha 的那个 fit，见 dist/pet.js），
//! 壳通过 `dsc_pet_hitbox` 收下。
//!
//! 【手感参数取自上游】dsh-pet 的 assets/config.jsonc：重力 1400 px/s²、碰壁恢复系数 0.78、
//! 落地摩擦 2.5/s、软上限 3600 px/s、顶部也反弹（MIT，见仓库根 NOTICE）。

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::{AppHandle, Emitter, Manager};

use crate::pet;

/// 一拍多长（约 60Hz）。位置更新、命中判定、物理积分共用这一拍。
const TICK: Duration = Duration::from_millis(16);
/// 抛掷物理（上游默认值）
const GRAVITY: f64 = 1400.0;
const RESTITUTION: f64 = 0.78;
const GROUND_FRICTION: f64 = 2.5;
const MAX_V: f64 = 3600.0;
/// 松手时速度低于这个值就当"轻轻放下"：不进物理，也不报"落地"
const THROW_MIN: f64 = 220.0;
/// 跟手样本只留这么多（60Hz 下约 200ms）
const SAMPLES_MAX: usize = 12;
/// 算速度时回看多久（毫秒）
const VELOCITY_WINDOW_MS: u128 = 80;

/// 她身体在窗口里的矩形（CSS px，相对窗口左上角）—— 页面量出来报回来的
#[derive(Clone, Copy, Debug, Default)]
struct HitBox {
    x: f64,
    y: f64,
    w: f64,
    h: f64,
}

#[derive(Clone, Copy, Debug)]
struct Sample {
    at: Instant,
    x: f64,
    y: f64,
}

#[derive(Clone, Copy, Debug)]
struct Grab {
    /// 抓取点相对窗口左上角的偏移 —— 跟手时用它保证"她不会跳到光标底下"
    ox: f64,
    oy: f64,
    /// 抓起来的瞬间窗口在哪（用来判断"这算点了一下还是拖起来扔了"）
    from: (f64, f64),
    since: Instant,
    moved: bool,
}

#[derive(Clone, Copy, Debug)]
struct Walk {
    from: (f64, f64),
    to: (f64, f64),
    start: Instant,
    ms: f64,
}

#[derive(Clone, Copy, Debug)]
struct Fly {
    vx: f64,
    vy: f64,
}

/// 每一拍从系统读回来的事实（主线程只读这份缓存，不再碰任何窗口 API）
#[derive(Clone, Copy, Debug)]
struct Snap {
    /// 窗口左上角（逻辑 px）
    pos: (f64, f64),
    /// 逻辑 px = 物理 px / scale
    scale: f64,
    /// 可用工作区（逻辑 px）：(min_x, min_y, max_x, max_y)
    screen: (f64, f64, f64, f64),
}

static HITBOX: Mutex<Option<HitBox>> = Mutex::new(None);
static SNAP: Mutex<Option<Snap>> = Mutex::new(None);
/// 交互总开关（配置 `petInteract`；关掉 = 永远穿透，回到以前的行为）
static INTERACT: AtomicBool = AtomicBool::new(true);
/// 循环开没开（窗口关了要让它自己停）
static RUNNING: AtomicBool = AtomicBool::new(false);
static APP: Mutex<Option<AppHandle>> = Mutex::new(None);
static GRAB: Mutex<Option<Grab>> = Mutex::new(None);
static WALK: Mutex<Option<Walk>> = Mutex::new(None);
static FLY: Mutex<Option<Fly>> = Mutex::new(None);
static SAMPLES: Mutex<Vec<Sample>> = Mutex::new(Vec::new());
/// 上一次真正设进窗口的「穿透」值（验收要问"现在到底穿不穿透"，不能靠猜）
static LAST_IGNORE: AtomicBool = AtomicBool::new(true);
/// 页面总共叫了几次"抓起来"（验收用：分清"页面没调"和"调了没跟手"）
static GRAB_CALLS: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);

// ─────────────────────── Win32：全直接调用，不经过事件循环 ───────────────────────
//
// 【为什么手写 extern 而不引 windows crate】这个项目只在 Windows 上跑，而引一个
// windows crate 会拖进一堆 feature 的编译量；这里要的只有下面这几个函数。
#[cfg(windows)]
mod win32 {
    use std::ffi::c_void;

    #[repr(C)]
    #[derive(Default)]
    pub struct Point {
        pub x: i32,
        pub y: i32,
    }

    #[repr(C)]
    #[derive(Default, Clone, Copy)]
    pub struct Rect {
        pub left: i32,
        pub top: i32,
        pub right: i32,
        pub bottom: i32,
    }

    #[repr(C)]
    pub struct MonitorInfo {
        pub cb_size: u32,
        pub rc_monitor: Rect,
        pub rc_work: Rect,
        pub flags: u32,
    }

    #[link(name = "user32")]
    extern "system" {
        fn GetCursorPos(p: *mut Point) -> i32;
        fn GetAsyncKeyState(vkey: i32) -> i16;
        fn GetWindowRect(hwnd: *mut c_void, r: *mut Rect) -> i32;
        fn SetWindowPos(
            hwnd: *mut c_void,
            after: *mut c_void,
            x: i32,
            y: i32,
            cx: i32,
            cy: i32,
            flags: u32,
        ) -> i32;
        fn MonitorFromWindow(hwnd: *mut c_void, flags: u32) -> *mut c_void;
        fn GetMonitorInfoW(monitor: *mut c_void, info: *mut MonitorInfo) -> i32;
        fn GetWindowLongW(hwnd: *mut c_void, index: i32) -> i32;
        fn SetWindowLongW(hwnd: *mut c_void, index: i32, value: i32) -> i32;
        fn GetDpiForWindow(hwnd: *mut c_void) -> u32;
    }

    /// SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE
    const SWP_FLAGS: u32 = 0x0001 | 0x0004 | 0x0010;
    /// MONITOR_DEFAULTTONEAREST
    const MONITOR_DEFAULTTONEAREST: u32 = 0x0000_0002;
    /// GWL_EXSTYLE / WS_EX_LAYERED / WS_EX_TRANSPARENT（"鼠标穿过去"就是这两位）
    const GWL_EXSTYLE: i32 = -20;
    const WS_EX_LAYERED: i32 = 0x0008_0000;
    const WS_EX_TRANSPARENT: i32 = 0x0000_0020;

    /// 光标在**物理**屏幕坐标（多屏可能是负数）
    pub fn cursor() -> Option<(i32, i32)> {
        let mut p = Point::default();
        let ok = unsafe { GetCursorPos(&mut p) };
        if ok == 0 {
            None
        } else {
            Some((p.x, p.y))
        }
    }

    /// 鼠标左键现在按着吗（高位数 = 按下）
    pub fn left_down() -> bool {
        unsafe { (GetAsyncKeyState(0x01) as u16 & 0x8000) != 0 }
    }

    /// 窗口矩形（物理 px）
    pub fn window_rect(hwnd: *mut c_void) -> Option<Rect> {
        let mut r = Rect::default();
        let ok = unsafe { GetWindowRect(hwnd, &mut r) };
        if ok == 0 {
            None
        } else {
            Some(r)
        }
    }

    /// 直接挪窗口（不走事件循环）
    pub fn move_window(hwnd: *mut c_void, x: i32, y: i32) {
        unsafe {
            SetWindowPos(hwnd, std::ptr::null_mut(), x, y, 0, 0, SWP_FLAGS);
        }
    }

    /// 显示器工作区（物理 px）：任务栏已经被系统扣掉了，比"屏高减 48"准
    pub fn work_area(hwnd: *mut c_void) -> Option<Rect> {
        let m = unsafe { MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST) };
        if m.is_null() {
            return None;
        }
        let mut mi = MonitorInfo {
            cb_size: std::mem::size_of::<MonitorInfo>() as u32,
            rc_monitor: Rect::default(),
            rc_work: Rect::default(),
            flags: 0,
        };
        let ok = unsafe { GetMonitorInfoW(m, &mut mi) };
        if ok == 0 {
            None
        } else {
            Some(mi.rc_work)
        }
    }

    /// 窗口所在显示器的缩放比（DPI 感知的窗口拿得准）
    pub fn scale_of(hwnd: *mut c_void) -> f64 {
        let dpi = unsafe { GetDpiForWindow(hwnd) };
        if dpi == 0 {
            1.0
        } else {
            dpi as f64 / 96.0
        }
    }

    /// 让鼠标穿过去 / 收回来。**不经过事件循环** —— 直接改扩展样式位。
    pub fn set_click_through(hwnd: *mut c_void, on: bool) {
        unsafe {
            let ex = GetWindowLongW(hwnd, GWL_EXSTYLE);
            let want = if on {
                ex | WS_EX_TRANSPARENT | WS_EX_LAYERED
            } else {
                ex & !WS_EX_TRANSPARENT
            };
            if want != ex {
                SetWindowLongW(hwnd, GWL_EXSTYLE, want);
            }
        }
    }
}

#[cfg(not(windows))]
mod win32 {
    use std::ffi::c_void;
    #[derive(Default, Clone, Copy)]
    pub struct Rect {
        pub left: i32,
        pub top: i32,
        pub right: i32,
        pub bottom: i32,
    }
    pub fn cursor() -> Option<(i32, i32)> {
        None
    }
    pub fn left_down() -> bool {
        false
    }
    pub fn window_rect(_h: *mut c_void) -> Option<Rect> {
        None
    }
    pub fn move_window(_h: *mut c_void, _x: i32, _y: i32) {}
    pub fn work_area(_h: *mut c_void) -> Option<Rect> {
        None
    }
    pub fn scale_of(_h: *mut c_void) -> f64 {
        1.0
    }
    pub fn set_click_through(_h: *mut c_void, _on: bool) {}
}

fn app_handle() -> Option<AppHandle> {
    APP.lock().unwrap().clone()
}

/// 窗口句柄。`hwnd()` 是纯读（拿到裸指针），不走事件循环。
#[cfg(windows)]
fn hwnd_of(win: &tauri::WebviewWindow) -> Option<*mut std::ffi::c_void> {
    win.hwnd().ok().map(|h| h.0 as *mut std::ffi::c_void)
}

#[cfg(not(windows))]
fn hwnd_of(_win: &tauri::WebviewWindow) -> Option<*mut std::ffi::c_void> {
    None
}

/// 从系统读一份事实（只在那一拍线程里调）
fn read_snap(win: &tauri::WebviewWindow) -> Option<Snap> {
    let hwnd = hwnd_of(win)?;
    let rect = win32::window_rect(hwnd)?;
    let scale = win32::scale_of(hwnd);
    let s = if scale > 0.0 { scale } else { 1.0 };
    let work = win32::work_area(hwnd)?;
    Some(Snap {
        pos: (rect.left as f64 / s, rect.top as f64 / s),
        scale: s,
        screen: (
            work.left as f64 / s,
            work.top as f64 / s,
            work.right as f64 / s,
            work.bottom as f64 / s,
        ),
    })
}

/// 缓存里的事实（主线程也安全：纯读内存）
fn snap() -> Option<Snap> {
    *SNAP.lock().unwrap()
}

fn cursor_logical(scale: f64) -> Option<(f64, f64)> {
    let s = if scale > 0.0 { scale } else { 1.0 };
    win32::cursor().map(|(x, y)| (x as f64 / s, y as f64 / s))
}

/// 她用不用吃鼠标（配置开关；关掉就永远穿透）
pub fn set_interact(on: bool) {
    INTERACT.store(on, Ordering::Relaxed);
}

/// 页面报来"她身体的矩形"
pub fn set_hitbox(x: f64, y: f64, w: f64, h: f64) {
    if !x.is_finite() || !y.is_finite() || !w.is_finite() || !h.is_finite() || w <= 0.0 || h <= 0.0 {
        return;
    }
    *HITBOX.lock().unwrap() = Some(HitBox {
        // 外扩 3px：贴边点得中比"精确到像素"重要
        x: x - 3.0,
        y: y - 3.0,
        w: w + 6.0,
        h: h + 6.0,
    });
}

/// 窗口是不是正在被拖着/飞着/走着
pub fn busy() -> bool {
    GRAB.lock().unwrap().is_some()
        || FLY.lock().unwrap().is_some()
        || WALK.lock().unwrap().is_some()
}

/// 验收用：此刻的"手脚"状态（**只读缓存**，主线程调它绝不会卡住）
pub fn debug_state() -> serde_json::Value {
    let hb = *HITBOX.lock().unwrap();
    let s = snap();
    serde_json::json!({
        "interact": INTERACT.load(Ordering::Relaxed),
        "ignoringCursor": LAST_IGNORE.load(Ordering::Relaxed),
        "busy": busy(),
        "grabCalls": GRAB_CALLS.load(Ordering::Relaxed),
        "hitbox": hb.map(|h| serde_json::json!({"x": h.x, "y": h.y, "w": h.w, "h": h.h})),
        "pos": s.map(|s| serde_json::json!({"x": s.pos.0, "y": s.pos.1})),
        "screen": s.map(|s| serde_json::json!({
            "minX": s.screen.0, "minY": s.screen.1, "maxX": s.screen.2, "maxY": s.screen.3
        })),
        // 排查/验收用：壳眼里的光标在哪、相对窗口多远（"点不到她"时先看这两个数对不对）
        "cursor": s.and_then(|s| cursor_logical(s.scale)).map(|(x, y)| serde_json::json!({"x": x, "y": y})),
        "rel": match (s, hb) {
            (Some(s), Some(h)) => cursor_logical(s.scale).map(|(x, y)| {
                let rx = x - s.pos.0;
                let ry = y - s.pos.1;
                serde_json::json!({"x": rx, "y": ry, "inside": rx >= h.x && rx <= h.x + h.w && ry >= h.y && ry <= h.y + h.h})
            }),
            _ => None,
        },
        "scale": s.map(|s| s.scale),
    })
}

/// 开始跟手拖拽（页面在 mousedown 时报鼠标相对窗口的位置）
pub fn grab_start(ox: f64, oy: f64) {
    if !ox.is_finite() || !oy.is_finite() {
        return;
    }
    GRAB_CALLS.fetch_add(1, Ordering::Relaxed);
    // 抓起来的时候不能还在飞 / 还在走
    *FLY.lock().unwrap() = None;
    *WALK.lock().unwrap() = None;
    let from = snap().map(|s| s.pos).unwrap_or((0.0, 0.0));
    {
        let mut s = SAMPLES.lock().unwrap();
        s.clear();
        s.push(Sample {
            at: Instant::now(),
            x: from.0,
            y: from.1,
        });
    }
    *GRAB.lock().unwrap() = Some(Grab {
        ox,
        oy,
        from,
        since: Instant::now(),
        moved: false,
    });
}

/// 松开：按最近这段的位移算速度，够快就甩出去。
///
/// 【为什么要把结论回给页面】"这算点了一下，还是拖起来扔了"只有壳判得出来 ——
/// 拖的时候窗口是跟着光标走的，光标相对窗口几乎不动，页面看自己的 clientX 永远是"没动"。
/// 所以判定在这儿做，页面拿 `moved`/`threw` 决定播"点击回应"还是等落地。
pub fn grab_end() -> serde_json::Value {
    let Some(g) = GRAB.lock().unwrap().take() else {
        return serde_json::json!({ "moved": false, "threw": false });
    };
    let Some((x, y)) = snap().map(|s| s.pos) else {
        return serde_json::json!({ "moved": g.moved, "threw": false });
    };
    let (vx, vy) = release_velocity(x, y);
    let threw = vx.hypot(vy) >= THROW_MIN;
    if threw {
        *FLY.lock().unwrap() = Some(Fly {
            vx: vx.clamp(-MAX_V, MAX_V),
            vy: vy.clamp(-MAX_V, MAX_V),
        });
    }
    serde_json::json!({ "moved": g.moved, "threw": threw })
}

/// 最近这段时间的平均速度（逻辑 px/s）
///
/// 【为什么取最近 ~80ms 而不是整段】整段平均会把"先慢慢挪、最后猛甩"抹平成没速度，
/// 甩出去的手感直接没了。
fn release_velocity(x: f64, y: f64) -> (f64, f64) {
    let now = Instant::now();
    let mut s = SAMPLES.lock().unwrap();
    s.push(Sample { at: now, x, y });
    while s.len() > SAMPLES_MAX {
        s.remove(0);
    }
    let Some(first) = s
        .iter()
        .rev()
        .find(|p| now.duration_since(p.at).as_millis() >= VELOCITY_WINDOW_MS)
        .or_else(|| s.first())
        .copied()
    else {
        return (0.0, 0.0);
    };
    let dt = now.duration_since(first.at).as_secs_f64();
    if dt <= 0.001 {
        return (0.0, 0.0);
    }
    ((x - first.x) / dt, (y - first.y) / dt)
}

/// 让她自己在屏幕上走一段（页面按动作素材的时长算好距离和用时）
pub fn walk_by(dx: f64, ms: f64) {
    let Some(s) = snap() else { return };
    if !dx.is_finite() || !ms.is_finite() || ms < 60.0 || dx.abs() < 1.0 {
        return;
    }
    let to_x = (s.pos.0 + dx).clamp(s.screen.0, s.screen.2 - pet::W);
    *FLY.lock().unwrap() = None;
    *WALK.lock().unwrap() = Some(Walk {
        from: s.pos,
        to: (to_x, s.pos.1),
        start: Instant::now(),
        ms,
    });
}

/// 走/飞/拖都停下（关窗、"回到角落"时用）
pub fn stop_motion() {
    *WALK.lock().unwrap() = None;
    *FLY.lock().unwrap() = None;
    *GRAB.lock().unwrap() = None;
}

/// 开一拍循环（窗口建好之后叫一次；窗口关了它自己停）
pub fn ensure_loop(app: &AppHandle) {
    *APP.lock().unwrap() = Some(app.clone());
    if RUNNING.swap(true, Ordering::SeqCst) {
        return; // 已经在跑了
    }
    let app = app.clone();
    std::thread::spawn(move || {
        let mut ignoring = true; // 建窗时设的就是穿透
        while RUNNING.load(Ordering::SeqCst) {
            let Some(win) = app.get_webview_window(pet::WINDOW_LABEL) else {
                break;
            };
            let Some(hwnd) = hwnd_of(&win) else {
                std::thread::sleep(TICK);
                continue;
            };
            // 每拍先把系统里的事实读回来（位置/缩放/工作区），写进缓存给主线程看
            let Some(s) = read_snap(&win) else {
                std::thread::sleep(TICK);
                continue;
            };
            *SNAP.lock().unwrap() = Some(s);

            // ── 跟手拖拽 ──
            //
            // 【为什么先 copy 出来】`if let Some(g) = *M.lock().unwrap()` 里的 MutexGuard 是
            // **临时值，活在整段 if let 块里** —— 块里再 lock 一次就是自己等自己（std 的
            // Mutex 不可重入）。本小姐真踩过：第一下拖动就把这一拍线程锁死。
            // Grab/Fly/Walk 都是 Copy，copy 出来之后 guard 在语句结束就释放了。
            let mut release_now = false;
            let grab = *GRAB.lock().unwrap();
            if let Some(grab) = grab {
                if let Some((cx, cy)) = cursor_logical(s.scale) {
                    let nx = cx - grab.ox;
                    let ny = cy - grab.oy;
                    let _ = win32::move_window(
                        hwnd,
                        (nx * s.scale).round() as i32,
                        (ny * s.scale).round() as i32,
                    );
                    let mut buf = SAMPLES.lock().unwrap();
                    buf.push(Sample {
                        at: Instant::now(),
                        x: nx,
                        y: ny,
                    });
                    while buf.len() > SAMPLES_MAX {
                        buf.remove(0);
                    }
                }
                if !grab.moved {
                    // 动过 3px 才算"拖"，否则按"点了一下"处理（点一下不该触发落地那套）
                    let d = (s.pos.0 - grab.from.0).abs() + (s.pos.1 - grab.from.1).abs();
                    if d > 3.0 {
                        if let Some(g2) = GRAB.lock().unwrap().as_mut() {
                            g2.moved = true;
                        }
                    }
                }
                release_now = !win32::left_down() || grab.since.elapsed().as_secs() > 30;
            }
            if release_now {
                grab_end();
            }

            // ── 抛掷物理 ──
            let fly = *FLY.lock().unwrap();
            if let Some(f) = fly {
                let dt = TICK.as_secs_f64();
                let (x, y) = s.pos;
                let mut vx = f.vx;
                let mut vy = f.vy + GRAVITY * dt;
                let mut nx = x + vx * dt;
                let mut ny = y + vy * dt;
                let (min_x, min_y, max_x, max_y) = s.screen;
                // 左右墙
                if nx < min_x {
                    nx = min_x;
                    vx = -vx * RESTITUTION;
                } else if nx + pet::W > max_x {
                    nx = max_x - pet::W;
                    vx = -vx * RESTITUTION;
                }
                // 顶（上游默认 ceilingBounce = true）
                if ny < min_y {
                    ny = min_y;
                    vy = -vy * RESTITUTION;
                }
                // 地板 = 工作区底边（任务栏已经被系统扣掉了）
                let floor = max_y - pet::H;
                let mut grounded = false;
                if ny >= floor {
                    ny = floor;
                    grounded = true;
                    if vy > 0.0 {
                        vy = -vy * RESTITUTION;
                        if vy.abs() < 90.0 {
                            vy = 0.0;
                        }
                    }
                    // 落地那一下把水平速度磨掉（否则她会一直滑）
                    vx *= (1.0 - GROUND_FRICTION * dt).max(0.0);
                }
                let _ = win32::move_window(
                    hwnd,
                    (nx * s.scale).round() as i32,
                    (ny * s.scale).round() as i32,
                );
                let busy_now = !(grounded && vx.abs() < 12.0 && vy.abs() < 12.0);
                *FLY.lock().unwrap() = if busy_now { Some(Fly { vx, vy }) } else { None };
                if !busy_now {
                    let _ = win.emit("dsc:pet-act", serde_json::json!({ "kind": "landed" }));
                }
            }

            // ── 自己走 ──
            let walk = *WALK.lock().unwrap();
            if let Some(wk) = walk {
                let k = (wk.start.elapsed().as_secs_f64() * 1000.0 / wk.ms).clamp(0.0, 1.0);
                let x = wk.from.0 + (wk.to.0 - wk.from.0) * k;
                let y = wk.from.1 + (wk.to.1 - wk.from.1) * k;
                let _ = win32::move_window(
                    hwnd,
                    (x * s.scale).round() as i32,
                    (y * s.scale).round() as i32,
                );
                if k >= 1.0 {
                    *WALK.lock().unwrap() = None;
                }
            }

            // ── 吃不吃鼠标 ──
            let want_ignore = if !INTERACT.load(Ordering::Relaxed) {
                true // 开关关着：永远穿透，跟以前一样
            } else if busy() {
                // 正在拖/飞/走的时候绝不能开穿透：拖着的时候光标随时会离开她身体，
                // 那一瞬间要是把穿透打开，窗口就从手里"掉出去"（跟手直接断）
                false
            } else {
                let hb = *HITBOX.lock().unwrap();
                match (hb, cursor_logical(s.scale)) {
                    (Some(hb), Some((cx, cy))) => {
                        let rx = cx - s.pos.0;
                        let ry = cy - s.pos.1;
                        !(rx >= hb.x && rx <= hb.x + hb.w && ry >= hb.y && ry <= hb.y + hb.h)
                    }
                    // 还没量出来她多大 / 问不到光标：保守地穿透（宁可点不到，也不能挡路）
                    _ => true,
                }
            };
            if want_ignore != ignoring {
                win32::set_click_through(hwnd, want_ignore);
                ignoring = want_ignore;
                LAST_IGNORE.store(want_ignore, Ordering::Relaxed);
            }

            std::thread::sleep(TICK);
        }
        RUNNING.store(false, Ordering::SeqCst);
        crate::shell_log("[pet] 手脚循环停下了");
    });
}

/// 停掉循环（关窗时叫）
pub fn stop_loop() {
    RUNNING.store(false, Ordering::SeqCst);
    *APP.lock().unwrap() = None;
    stop_motion();
}
