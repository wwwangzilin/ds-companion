"""生成 ds-companion 的图标（不借用任何其它项目的图形）。

设计基调按主人偏好：暗色圆角底 + 紫→蓝→粉霓虹渐变。
三个候选，都用 4x 超采样再缩，保证小尺寸不糊：

  A 气泡星火  —— 渐变描边对话气泡 + 四角星火（对话「有灵魂」）
  B 猫耳环    —— 霓虹圆环顶上两只耳朵（贴「伴侣」，但对某个角色有偏向）
  C 双点轨道  —— 一大一小两点 + 一道弧（最中性，像「陪伴」）

用法：
  python tools/make-icons.py preview     # 只出预览图，不动 src-tauri/icons
  python tools/make-icons.py install A   # 装某个候选 + 出全套尺寸
"""

import os
import sys
from PIL import Image, ImageDraw, ImageFilter

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
ICON_DIR = os.path.join(ROOT, "src-tauri", "icons")
PREVIEW_DIR = os.path.join(ROOT, "preview")

F = 4  # 超采样倍数
SIZES = [256, 128, 64, 48, 32, 24, 16]

# 霓虹渐变的三个停靠点（紫 → 蓝 → 粉）
STOPS = [
    (0.00, (167, 139, 250)),
    (0.50, (96, 165, 250)),
    (1.00, (244, 114, 182)),
]
PLATE_TOP = (18, 15, 30)
PLATE_BOTTOM = (32, 25, 56)


def lerp(a, b, t):
    return tuple(round(a[i] + (b[i] - a[i]) * t) for i in range(3))


def stop_color(t):
    t = max(0.0, min(1.0, t))
    for i in range(len(STOPS) - 1):
        p0, c0 = STOPS[i]
        p1, c1 = STOPS[i + 1]
        if p0 <= t <= p1:
            return lerp(c0, c1, (t - p0) / (p1 - p0))
    return STOPS[-1][1]


def diagonal_gradient(size):
    """对角线性渐变。先在小图上算再放大，避免纯 Python 遍历百万像素。"""
    small = max(64, size // 8)
    img = Image.new("RGB", (small, small))
    px = img.load()
    denom = 2 * (small - 1)
    for y in range(small):
        for x in range(small):
            px[x, y] = stop_color((x + y) / denom)
    return img.resize((size, size), Image.BILINEAR)


def vertical_plate(size):
    img = Image.new("RGB", (size, size))
    px = img.load()
    for y in range(size):
        c = lerp(PLATE_TOP, PLATE_BOTTOM, y / (size - 1))
        for x in range(size):
            px[x, y] = c
    return img


def rounded_mask(size, radius_ratio=0.225):
    m = Image.new("L", (size, size), 0)
    d = ImageDraw.Draw(m)
    d.rounded_rectangle([0, 0, size - 1, size - 1], radius=int(size * radius_ratio), fill=255)
    return m


def star_polygon(cx, cy, r_out, r_in):
    pts = []
    for i in range(8):
        r = r_out if i % 2 == 0 else r_in
        # 从正上方开始，每 45°
        import math

        ang = -math.pi / 2 + i * math.pi / 4
        pts.append((cx + r * math.cos(ang), cy + r * math.sin(ang)))
    return pts


def draw_a_bubble(canvas, grad, size):
    """A：气泡（渐变描边）+ 星火。"""
    mask = Image.new("L", (size, size), 0)
    d = ImageDraw.Draw(mask)
    w = int(size * 0.52)
    h = int(size * 0.40)
    left = (size - w) // 2
    top = int(size * 0.26)
    radius = int(h * 0.42)
    stroke = int(size * 0.055)
    d.rounded_rectangle(
        [left, top, left + w, top + h], radius=radius, outline=255, width=stroke
    )
    # 气泡尾巴（左下）
    tail = [
        (left + int(w * 0.20), top + h - stroke // 2),
        (left + int(w * 0.34), top + h - stroke // 2),
        (left + int(w * 0.16), top + h + int(size * 0.10)),
    ]
    d.polygon(tail, fill=255)
    # 星火（实心，用同一渐变）
    d.polygon(
        star_polygon(size * 0.5, top + h * 0.5, size * 0.105, size * 0.030), fill=255
    )
    canvas.paste(grad, (0, 0), mask)


def draw_b_catring(canvas, grad, size):
    """B：霓虹圆环 + 猫耳。"""
    mask = Image.new("L", (size, size), 0)
    d = ImageDraw.Draw(mask)
    pad = int(size * 0.27)
    stroke = int(size * 0.062)
    cx = size / 2
    cy = size * 0.56
    r = (size - 2 * pad) / 2
    d.ellipse([cx - r, cy - r, cx + r, cy + r], outline=255, width=stroke)
    # 两只耳朵
    ear_h = int(size * 0.20)
    ear_w = int(size * 0.20)
    for sign in (-1, 1):
        bx = cx + sign * r * 0.62
        by = cy - r * 0.78
        d.polygon(
            [
                (bx - ear_w / 2, by + ear_h * 0.35),
                (bx + sign * ear_w * 0.10, by - ear_h * 0.65),
                (bx + ear_w / 2, by + ear_h * 0.45),
            ],
            fill=255,
        )
    canvas.paste(grad, (0, 0), mask)


def draw_c_orbit(canvas, grad, size):
    """C：一大一小两点 + 一道弧。"""
    mask = Image.new("L", (size, size), 0)
    d = ImageDraw.Draw(mask)
    big_r = size * 0.155
    bx, by = size * 0.40, size * 0.52
    d.ellipse([bx - big_r, by - big_r, bx + big_r, by + big_r], fill=255)
    small_r = size * 0.075
    sx, sy = size * 0.685, size * 0.345
    d.ellipse([sx - small_r, sy - small_r, sx + small_r, sy + small_r], fill=255)
    # 弧：绕两点的连线弯过去
    d.arc(
        [size * 0.36, size * 0.30, size * 0.76, size * 0.78],
        start=205,
        end=330,
        fill=255,
        width=int(size * 0.050),
    )
    canvas.paste(grad, (0, 0), mask)


CANDIDATES = {
    "A": ("气泡星火", draw_a_bubble),
    "B": ("猫耳环", draw_b_catring),
    "C": ("双点轨道", draw_c_orbit),
}


def render(key, size):
    """渲染成给定边长的 RGBA 图（先在 4x 上画再缩）。"""
    W = size * F
    plate = vertical_plate(W).convert("RGBA")
    grad = diagonal_gradient(W).convert("RGBA")
    draw = CANDIDATES[key][1]
    body = Image.new("RGBA", (W, W), (0, 0, 0, 0))
    body.paste(plate, (0, 0))
    # 外发光：把图形复制一层模糊后垫在底下
    glow = Image.new("RGBA", (W, W), (0, 0, 0, 0))
    draw(glow, grad, W)
    glow = glow.filter(ImageFilter.GaussianBlur(W * 0.018))
    body = Image.alpha_composite(body, glow)
    layer = Image.new("RGBA", (W, W), (0, 0, 0, 0))
    draw(layer, grad, W)
    body = Image.alpha_composite(body, layer)
    # 裁圆角
    body.putalpha(Image.composite(body.getchannel("A"), Image.new("L", (W, W), 0), rounded_mask(W)))
    return body.resize((size, size), Image.LANCZOS)


def contact_sheet(keys, out_path):
    """每个候选一行，展示 256/64/32/16 四档，底下垫棋盘格看透明区。"""
    cell = 280
    sheet = Image.new("RGBA", (cell * 4, cell * len(keys)), (255, 255, 255, 255))
    dd = ImageDraw.Draw(sheet)
    for r in range(0, sheet.height, 16):
        for c in range(0, sheet.width, 16):
            if ((r // 16) + (c // 16)) % 2:
                dd.rectangle([c, r, c + 15, r + 15], fill=(228, 228, 232, 255))
    for i, k in enumerate(keys):
        y = i * cell
        for j, s in enumerate([256, 64, 32, 16]):
            im = render(k, s)
            x = j * cell + (cell - s) // 2
            sheet.alpha_composite(im, (x, y + (cell - s) // 2))
    sheet.convert("RGB").save(out_path)


def install(key):
    os.makedirs(ICON_DIR, exist_ok=True)
    big = render(key, 1024)
    big.save(os.path.join(ICON_DIR, "icon.png"))
    for s, name in [(32, "32x32.png"), (64, "64x64.png"), (128, "128x128.png"), (256, "128x128@2x.png")]:
        render(key, s).save(os.path.join(ICON_DIR, name))
    # ICO 要一次性带全部尺寸
    ico_sizes = [(s, s) for s in [16, 24, 32, 48, 64, 128, 256]]
    render(key, 256).save(os.path.join(ICON_DIR, "icon.ico"), sizes=ico_sizes)
    print("installed candidate", key, CANDIDATES[key][0], "->", ICON_DIR)


if __name__ == "__main__":
    mode = sys.argv[1] if len(sys.argv) > 1 else "preview"
    if mode == "preview":
        os.makedirs(PREVIEW_DIR, exist_ok=True)
        for k in CANDIDATES:
            p = os.path.join(PREVIEW_DIR, f"icon-{k}.png")
            contact_sheet([k], p)
            print("preview:", p)
    elif mode == "install":
        install(sys.argv[2] if len(sys.argv) > 2 else "A")
    else:
        raise SystemExit("用法: make-icons.py preview | install <A|B|C>")
