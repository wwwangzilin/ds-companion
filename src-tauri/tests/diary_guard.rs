//! 日记的**拒写**测试：路径穿越、空正文。
//!
//! 【为什么也单开一个文件】同 `diary_fs.rs` 的理由：这个文件要改 `DSC_DATA_DIR`，
//! 而同文件内的测试是并行跑的，两个都改就会互相踩。一个文件一个测试。
//!
//! 【为什么这两条必须真跑一遍】文件名是拿日期拼出来的 —— 放一个 `../../evil` 过去，
//! 日记就写到数据目录外面了。而"拒掉了"这件事必须连**副作用**一起验：
//! 光断言返回 `Err` 不够，还要确认盘上真的没留下东西。

use ds_companion_lib::diary;

#[test]
fn refuses_escapes_and_empty_text() {
    let root = std::env::temp_dir().join(format!("dsc-diary-guard-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    // 先把自己关进临时目录：万一哪天这道闸真的坏了，也只会写进临时目录，
    // 而不是主人的 %APPDATA%（这条顺序不能反）
    std::env::set_var("DSC_DATA_DIR", &root);

    let outside_a = root.join("evil.md");
    let outside_b = root.parent().unwrap().join("evil.md");

    // ① 路径穿越：写和读都要拒
    assert!(diary::save_day("dsc-luna", "../../evil", "x").is_err(), "穿越要拒");
    assert!(diary::read_day("dsc-luna", "../../evil").is_none());
    assert!(diary::save_day("dsc-luna", "2026/10/02", "x").is_err(), "斜杠要拒");
    assert!(diary::save_day("dsc-luna", "2026-10-2", "x").is_err(), "缺补零要拒");
    assert!(!outside_a.exists(), "不许在外面留下文件：{}", outside_a.display());
    assert!(!outside_b.exists(), "不许在外面留下文件：{}", outside_b.display());

    // ② 空正文不写：宁可缺一天，也不留一篇空日记
    assert!(diary::save_day("dsc-luna", "2026-10-02", "   \n  ").is_err(), "空日记要拒");
    assert!(
        diary::read_day("dsc-luna", "2026-10-02").is_none(),
        "被拒的不该落盘",
    );
    assert!(diary::days("dsc-luna").is_empty(), "拒掉之后不该有任何文件");

    let _ = std::fs::remove_dir_all(&root);
}
