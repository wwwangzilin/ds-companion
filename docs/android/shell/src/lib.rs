//! Android 注入时机 PoC 壳。
//!
//! 它只做三件事：加载 chat.deepseek.com、把探针当 initialization_script 注入、
//! 把结果打到 logcat。跑得起来就说明「Android 上能不能在页面脚本之前挂钩子」有了答案。
//!
//! 桌面端也能编译运行同一份代码（方便先在本机确认探针输出格式），
//! 只是桌面端读输出更方便：`$env:TEMP\...` 或直接看控制台。

use tauri::{WebviewUrl, WebviewWindowBuilder};

/// 探针源码，就在上一级目录（docs/android/poc-probe.js）。
const PROBE: &str = include_str!("../../poc-probe.js");

/// 页面加载完之后把探针结果整体打一次，方便 `adb logcat | grep dsc-poc`。
const DUMP: &str = "console.log('[dsc-poc-dump] ' + JSON.stringify(window.__DSC_POC__ || {missing:true}))";

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let url: tauri::Url = "https://chat.deepseek.com/"
                .parse()
                .expect("hard-coded URL must parse");

            let _win = WebviewWindowBuilder::new(app, "main", WebviewUrl::External(url))
                .initialization_script(PROBE)
                .on_page_load(|webview, payload| {
                    println!(
                        "[dsc-poc-native] page_load {:?} url={}",
                        payload.event(),
                        payload.url()
                    );
                    if matches!(payload.event(), tauri::webview::PageLoadEvent::Finished) {
                        let _ = webview.eval(DUMP);
                    }
                })
                .build()?;

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
