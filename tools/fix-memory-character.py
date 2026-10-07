#!/usr/bin/env python3
"""把记忆库里 characterId 跟它自己的 sourceRef 对不上的条目改正过来。

【背景】整理链路以前是"先拿跨角色的素材、最后盖一个整理那一刻的人设"——
两者一错开就把 A 说的话记到 B 名下。主人报的"换个角色就被夺舍"就是这个：
跟他实测对账，17 条带来源的记忆里有 3 条是这样的。

代码已经修了（见 src-tauri/inject/extract.js 的 byCharacter：素材按角色筛、盖同一个角色、
认不出角色就不整理）。这个工具收拾**已经写错的那批**。

【判定依据】每条记忆的 frontmatter 里有
    characterId: dsh-deepseek
    sourceRef:   2026-10-03 15:23 · 铃模式
`sourceRef` 尾巴上是**真实来源的角色显示名**，拿它反查人设文件（personas/*.md 的 name）
就能算出正确的 id。只有两边**都**认得出来、且确实不一致时才动手。

【安全】默认 --dry-run 只报告。--apply 才写，并且写之前先把原文件复制到
memory-trash/<时间戳>/（软删除的规矩：坏文件留证，不直接毁掉）。

用法：
  python tools/fix-memory-character.py                # 只报告
  python tools/fix-memory-character.py --apply        # 真改
  python tools/fix-memory-character.py --root <数据目录> [--apply]
"""

import argparse
import datetime as dt
import os
import re
import shutil
import sys


def app_root(explicit):
    if explicit:
        return explicit
    appdata = os.environ.get("APPDATA")
    if not appdata:
        sys.exit("找不到 %APPDATA%，请用 --root 指定数据目录")
    return os.path.join(appdata, "ds-companion")


def read(path):
    with open(path, encoding="utf-8") as f:
        return f.read()


def write(path, text):
    # newline="\n"：这些文件是 git 友好的纯文本，别让 Windows 把换行改成 CRLF
    with open(path, "w", encoding="utf-8", newline="\n") as f:
        f.write(text)


NAME_RE = re.compile(r"^(?:name|名称)\s*[:：]\s*(.+?)\s*$")

# 内置角色没有 personas/*.md（素材编在 exe 里），所以它的显示名要写死在这儿。
# 少了这一条，凡是跟"原版"聊出来的记忆全会被判成"认不出的角色"而跳过 ——
# 看起来像"没问题"，其实是**没查**。
BUILTIN = {"DeepSeek 娘": "dsh-deepseek"}


def persona_names(personas_dir):
    """角色显示名 → 人设 id。两个方向都建，因为留档里存的可能是名字也可能带后缀。"""
    table = dict(BUILTIN)
    if not os.path.isdir(personas_dir):
        return table
    for fn in sorted(os.listdir(personas_dir)):
        if not fn.endswith(".md"):
            continue
        pid = fn[:-3]
        body = read(os.path.join(personas_dir, fn))
        name = ""
        for line in body.splitlines()[:15]:
            m = NAME_RE.match(line.strip().lstrip("#").strip())
            if m:
                name = m.group(1).strip()
                break
        if not name:
            for line in body.splitlines():
                s = line.strip().lstrip("#").strip()
                if s:
                    name = s
                    break
        if name:
            table[name] = pid
    return table


FIELD_RE = {
    "characterId": re.compile(r"^characterId:[ \t]*(.*)$", re.M),
    "sourceRef": re.compile(r"^sourceRef:[ \t]*(.*)$", re.M),
    "name": re.compile(r"^name:[ \t]*(.*)$", re.M),
}
TAIL_NAME_RE = re.compile(r"·\s*([^·]+?)\s*(?:（留档）)?\s*$")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", default="")
    ap.add_argument("--apply", action="store_true")
    args = ap.parse_args()

    root = app_root(args.root)
    memory_dir = os.path.join(root, "memory")
    if not os.path.isdir(memory_dir):
        sys.exit("没有记忆目录：" + memory_dir)

    names = persona_names(os.path.join(root, "personas"))
    print("数据目录：" + root)
    print("人设表：" + ", ".join(f"{k}={v}" for k, v in sorted(names.items())))
    print("")

    wrong = []
    unknown = []
    for fn in sorted(os.listdir(memory_dir)):
        if not fn.endswith(".md"):
            continue
        path = os.path.join(memory_dir, fn)
        body = read(path)
        cid = (FIELD_RE["characterId"].search(body) or [None, ""])[1].strip() if FIELD_RE["characterId"].search(body) else ""
        ref = (FIELD_RE["sourceRef"].search(body) or [None, ""])[1].strip() if FIELD_RE["sourceRef"].search(body) else ""
        nm = (FIELD_RE["name"].search(body) or [None, fn])[1].strip() if FIELD_RE["name"].search(body) else fn
        m = TAIL_NAME_RE.search(ref)
        who = m.group(1).strip() if m else ""
        if not who:
            continue  # 手写的、或者 sourceRef 里没写来源角色 —— 无从判断，不碰
        want = names.get(who)
        if not want:
            unknown.append((fn, nm, cid, who))
            continue
        if want != cid:
            wrong.append((fn, nm, cid, want, who, path, body))

    if unknown:
        print("认不出角色的（跳过，不动）：")
        for fn, nm, cid, who in unknown:
            print(f"  {fn}  characterId={cid}  sourceRef 里的「{who}」对不上任何人设")
        print("")

    if not wrong:
        print("没有对不上的条目，收工。")
        return 0

    print(f"要对账的 {len(wrong)} 条：")
    for fn, nm, cid, want, who, _p, _b in wrong:
        print(f"  {fn}")
        print(f"     「{nm}」")
        print(f"     characterId: {cid}  →  {want}   （sourceRef 说是「{who}」）")
    print("")

    if not args.apply:
        print("（这是 dry-run；加 --apply 才真的改，改之前会先备份到 memory-trash/）")
        return 0

    stamp = dt.datetime.now().strftime("%Y%m%d-%H%M%S")
    backup = os.path.join(root, "memory-trash", stamp)
    os.makedirs(backup, exist_ok=True)

    for fn, nm, cid, want, who, path, body in wrong:
        shutil.copy2(path, os.path.join(backup, fn))
        new_body = FIELD_RE["characterId"].sub("characterId: " + want, body, count=1)
        if new_body == body:
            print(f"  !! {fn} 没改到（正则没命中？），跳过")
            continue
        write(path, new_body)
        print(f"  改好 {fn}：{cid} → {want}")

    print("")
    print("原文件备份在：" + backup)
    return 0


if __name__ == "__main__":
    sys.exit(main())
