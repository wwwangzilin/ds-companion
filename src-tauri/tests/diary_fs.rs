//! 日记的**真实落盘**测试：写、追加、读、列表。
//!
//! 【为什么单开一个集成测试】单元测试跑在同一个进程里，`DSC_DATA_DIR` 又是进程级环境
//! 变量 —— 在里面改它会把同进程其它测试一起带偏（数据纪律：测试不许碰主人的真数据，
//! 也不许互相污染）。集成测试是**另一个进程**，可以先把自己关进临时目录再动手。
//! （也正因如此，这个文件里只能有**一个** `#[test]`：同文件内的测试是并行的，
//! 两个都去改环境变量就会互相踩。要加第二个测试就再开一个文件。）
//!
//! 【为什么值得这么麻烦】写盘是这个功能唯一真正碰用户文件的地方：追加时会不会重复
//! 标题、临时文件会不会留在盘上、换角色会不会串目录 —— 这几件事光靠看代码看不出来。

use ds_companion_lib::diary;

#[test]
fn writes_appends_reads_and_lists_one_file_per_day() {
    let root = std::env::temp_dir().join(format!("dsc-diary-fs-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    std::env::set_var("DSC_DATA_DIR", &root);

    // ① 第一次写：建目录、加日期标题、落盘
    let path = diary::save_day("dsc-luna", "2026-10-02", "今天他把饮料丢给我，说是喝不完。")
        .expect("第一次写该成功");
    assert!(path.exists(), "文件得真的在盘上：{}", path.display());
    assert!(
        path.starts_with(&root),
        "必须落在数据目录里：{}",
        path.display()
    );
    assert_eq!(path.file_name().unwrap(), "2026-10-02.md");
    assert_eq!(
        diary::read_day("dsc-luna", "2026-10-02").unwrap(),
        "# 2026-10-02\n\n今天他把饮料丢给我，说是喝不完。\n",
    );

    // ② 同一天再写：**不覆盖**旧内容，分隔开接在后面，且标题只有一次
    diary::save_day("dsc-luna", "2026-10-02", "其实我喝完了。").expect("追加该成功");
    let text = diary::read_day("dsc-luna", "2026-10-02").unwrap();
    assert!(text.contains("喝不完"), "旧内容不能被覆盖：{text}");
    assert!(text.contains("其实我喝完了。"), "新内容要接上：{text}");
    assert_eq!(
        text.matches("# 2026-10-02").count(),
        1,
        "标题只能有一个：{text}"
    );

    // ③ 另一天 = 另一个文件；临时文件不许留在盘上
    diary::save_day("dsc-luna", "2026-10-03", "第二天。").expect("换天该成功");
    let dir = diary::diary_dir("dsc-luna");
    let md: Vec<String> = std::fs::read_dir(&dir)
        .unwrap()
        .flatten()
        .map(|e| e.file_name().to_string_lossy().to_string())
        .collect();
    assert_eq!(md.len(), 2, "一天一个文件，多出来的是：{md:?}");
    assert!(
        !md.iter().any(|n| n.contains("tmp")),
        "临时文件必须被 rename 掉：{md:?}",
    );

    // ④ 列表：新的在前
    assert_eq!(
        diary::days("dsc-luna"),
        vec!["2026-10-03".to_string(), "2026-10-02".to_string()],
    );

    // ⑤ 没写过的日子 → None（不是 panic，也不是空串）；角色之间互不串门
    assert!(diary::read_day("dsc-luna", "2026-01-01").is_none());
    assert!(diary::read_day("dsc-other", "2026-10-02").is_none());
    assert!(diary::days("dsc-other").is_empty());

    let _ = std::fs::remove_dir_all(&root);
}
