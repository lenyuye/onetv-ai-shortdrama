#!/usr/bin/env python3
"""从 图标/圆角矩形图标版本.jpg 生成 macOS icns 与前端 logo。
处理：白底泛洪填充→透明、裁剪、缩放、iconset 输出。
"""
import subprocess
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT.parent / "图标" / "圆角矩形图标版本.jpg"
OUT_ICONS = ROOT / "apps" / "desktop" / "src-tauri" / "icons"
OUT_PUBLIC = ROOT / "apps" / "desktop" / "public"

SENTINEL = (255, 0, 254)


def main() -> None:
    im = Image.open(SRC).convert("RGB")
    w, h = im.size
    # 从四角泛洪填充白色外圈 → 哨兵色
    for xy in [(0, 0), (w - 1, 0), (0, h - 1), (w - 1, h - 1)]:
        try:
            ImageDraw.floodfill(im, xy, SENTINEL, thresh=48)
        except Exception as e:  # noqa: BLE001
            print(f"floodfill {xy} failed: {e}", file=sys.stderr)

    rgba = im.convert("RGBA")
    arr = np.array(rgba)
    sentinel_mask = (
        (arr[:, :, 0] == SENTINEL[0])
        & (arr[:, :, 1] == SENTINEL[1])
        & (arr[:, :, 2] == SENTINEL[2])
    )
    arr[sentinel_mask, 3] = 0
    # 轻微羽化：对 alpha 做一次边缘收缩平滑
    alpha = arr[:, :, 3]
    alpha = np.where(alpha > 0, alpha, 0).astype(np.uint8)
    arr[:, :, 3] = alpha
    out = Image.fromarray(arr, "RGBA")

    bbox = out.getbbox()
    if bbox:
        out = out.crop(bbox)
    side = max(out.size)
    canvas = Image.new("RGBA", (side, side), (0, 0, 0, 0))
    canvas.paste(out, ((side - out.width) // 2, (side - out.height) // 2))

    # 归一化到 1024，并做圆角保护（覆盖源图残留白边）
    size = 1024
    icon = canvas.resize((size, size), Image.LANCZOS)
    radius = int(size * 0.225)
    mask = Image.new("L", (size, size), 0)
    d = ImageDraw.Draw(mask)
    d.rounded_rectangle([0, 0, size - 1, size - 1], radius=radius, fill=255)
    icon.putalpha(mask)

    OUT_ICONS.mkdir(parents=True, exist_ok=True)
    OUT_PUBLIC.mkdir(parents=True, exist_ok=True)

    iconset = OUT_ICONS / "icon.iconset"
    if iconset.exists():
        subprocess.run(["rm", "-rf", str(iconset)], check=True)
    iconset.mkdir(parents=True)

    sizes = {
        "icon_16x16.png": 16,
        "icon_16x16@2x.png": 32,
        "icon_32x32.png": 32,
        "icon_32x32@2x.png": 64,
        "icon_128x128.png": 128,
        "icon_128x128@2x.png": 256,
        "icon_256x256.png": 256,
        "icon_256x256@2x.png": 512,
        "icon_512x512.png": 512,
        "icon_512x512@2x.png": 1024,
    }
    for name, s in sizes.items():
        icon.resize((s, s), Image.LANCZOS).save(iconset / name)

    subprocess.run(
        ["iconutil", "-c", "icns", str(iconset), "-o", str(OUT_ICONS / "icon.icns")],
        check=True,
    )

    # 前端 logo（顶栏小图 + 备用 512）
    icon.resize((256, 256), Image.LANCZOS).save(OUT_PUBLIC / "logo.png")
    icon.save(OUT_PUBLIC / "logo-512.png")
    print("icons generated:", OUT_ICONS / "icon.icns")


if __name__ == "__main__":
    main()
