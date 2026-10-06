// 验收专用：一个极小的窗口程序，用来验「敏感进程名一个字都不许出去」。
//
// 【为什么必须自己造一个】隐私契约最硬的一条是"密码管理器这类进程连名字都不给"，
// 而这条只有在**真的有一个叫 keepass-xxx.exe 的窗口跑到前台**时才验得出来。
// 用系统自带的 notepad.exe 改名的路子靠不住：Win11 的 System32\notepad.exe 只是个
// 转发器，真正起来的进程叫 Notepad.exe（Store 版），名字一换就验不成了。
//
// 这个程序只做一件事：弹一个 MessageBox 然后一直等着。它没有别的依赖，
// 用 rustc 单文件编出来（不需要 cargo 工程），编完复制成两个名字：
//   dsc-front-probe.exe      → 普通进程，用来验"读到的是哪个进程"
//   keepass-dsc-probe.exe    → 敏感进程，用来验"名字被打码"
//
// 【为什么 MessageBox 而不是 CreateWindowEx】窗口类注册那一套几十行，而这里要的
// 只是"有个属于本进程的顶层窗口能被切到前台"。MessageBox 完全够用。
//
// 编译（脚本里自动做）：
//   rustc -O .verify\front-probe.rs -o %TEMP%\dsc-front-probe\dsc-front-probe.exe
#![windows_subsystem = "windows"]

#[link(name = "user32")]
extern "system" {
    fn MessageBoxW(
        hwnd: *mut core::ffi::c_void,
        text: *const u16,
        caption: *const u16,
        utype: u32,
    ) -> i32;
}

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

fn main() {
    // 窗口标题可以从命令行给 —— 验收要造"标题里真有内容"的场面（默认那句太干净了）
    let cap_text = std::env::args()
        .nth(1)
        .unwrap_or_else(|| "dsc-front-probe".to_string());
    let text = wide("dsc front probe");
    let cap = wide(&cap_text);
    unsafe {
        MessageBoxW(std::ptr::null_mut(), text.as_ptr(), cap.as_ptr(), 0);
    }
}
