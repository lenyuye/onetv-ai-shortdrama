#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
OneTV 真机 UI 冒烟脚本（macOS + Tauri/WKWebView）。

流程：退出已运行实例 → open -a OneTV → 等窗口 → 检测登录页（仅当出现才键入
admin/12345；会话持久化时应用直接进主界面，绝不盲打）→ 逐视图点左侧导航 →
截窗 → 基础健康断言（窗口存在 / PNG 体积 / 像素方差 / 点击后界面确有切换）→
写 smoke_report.json，退出码 = 失败视图数。

仅依赖 Python3 标准库 + pyobjc(Quartz)，PIL 强烈建议（缺失时跳过方差/比对断言）。
人看截图仍是最终判断，本脚本只筛明显问题（白屏/黑屏/空页面/导航点击无效）。

用法：
    python3 scripts/smoke/onetv_smoke.py [--out 目录] [--calibrate]
前提：
    运行脚本的终端需要有「辅助功能」权限（CGEventPost / CGWarpMouseCursorPosition）
    和「屏幕录制」权限（screencapture 截窗）。
"""

import argparse
import json
import os
import statistics
import subprocess
import sys
import time
from datetime import datetime

import Quartz

# ---------------- 可调参数 ----------------

APP_NAME = "OneTV"
PROCESS_HINT = "OneTV.app"                # pkill 兜底用
OWNER_NAMES = {"OneTV", "onetv-desktop"}  # kCGWindowOwnerName 候选（应用名/二进制名）

USERNAME = "admin"
PASSWORD = "12345"   # 默认本地账户；若已改密请同步改这里（见 README）

# ---- 标定表（CALIBRATION）----
# 来源：2026-10-06 于 1440x900 逻辑窗口、v2.19.0 实机截图上用导航条文字带检测
# （见 detect_nav_bands / --calibrate）量得的各导航行中心 y（逻辑坐标、窗口相对、
# 原点左上），顺序与 apps/desktop/src/App.tsx 的 NAV 数组逐项核对一致。
# 实测行距约 33 逻辑 px（.nav-item = 13px 字号 x1.55 行高 + 7px*2 padding），
# 分区标题（工作区/创作/管理/系统）也独占一行高——不要按行距自行推算。
# 注：导航整体是顶部锚定的固定高度布局，这些 y 基本不随窗口高变化；
# 运行时仍按 H/900 比例换算（H=900 时为精确值），窗口尺寸差异大时请 --calibrate 重测。
NAV_X_RATIO = 0.041        # 行首文字区：实测逻辑 x≈59 @ W=1440，允许窗口左缘+45~66
NAV_Y_BASE = 900.0         # 标定时窗口逻辑高
CALIBRATION = [            # (视图名, 实测逻辑 y @900 高窗口)
    ("工作区",      130),
    ("项目",        163),
    ("Agent对话",   227),
    ("剧本",        261),
    ("分镜",        293),
    ("画布",        326),
    ("时间线",      359),
    ("资产",        423),
    ("模型",        457),
    ("Skills",      489),
    ("Hermes连接",  522),
    ("任务",        557),
    ("设置",        619),
]

CLICK_SETTLE_SEC = 1.2     # 点击导航后等视图渲染
MIN_PNG_BYTES = 30 * 1024  # 白屏/黑屏截图通常远小于此
BLANK_STDDEV = 3.0         # 灰度 stddev 低于此值判“疑似空白页”（需 PIL）
DIFF_NOCHANGE = 1.0        # 点击前后截图（缩到 320x200）平均灰度差低于此值视为“界面没变”

kCGSession = Quartz.kCGSessionEventTap

# 常用键 keycodes（US ANSI 键盘）
KEY_TAB, KEY_RETURN = 48, 36
_CHAR_KEYCODES = {
    "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8,
    "v": 9, "b": 11, "q": 12, "w": 13, "e": 14, "r": 15, "y": 16, "t": 17,
    "1": 18, "2": 19, "3": 20, "4": 21, "6": 22, "5": 23, "9": 25,
    "7": 26, "8": 28, "0": 29, "o": 31, "u": 32, "i": 34, "p": 35,
    "l": 37, "j": 38, "k": 40, "n": 45, "m": 46,
}

# ---------------- 基础工具 ----------------


def run(cmd, timeout=20):
    return subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)


def osascript(script):
    return run(["osascript", "-e", script])


def activate_app():
    osascript(f'tell application "{APP_NAME}" to activate')
    time.sleep(0.4)


def find_window():
    """返回 (window_id, (x, y, w, h))；找不到返回 (None, None)。

    按 kCGWindowOwnerName（OneTV / onetv-desktop）且 kCGWindowLayer==0 过滤，
    取面积最大的命中窗口。
    """
    opts = Quartz.kCGWindowListOptionOnScreenOnly | Quartz.kCGWindowListExcludeDesktopElements
    wins = Quartz.CGWindowListCopyWindowInfo(opts, Quartz.kCGNullWindowID) or []
    best = None
    for w in wins:
        owner = w.get("kCGWindowOwnerName", "")
        if owner not in OWNER_NAMES:
            continue
        if w.get("kCGWindowLayer", 99) != 0:
            continue
        b = w.get("kCGWindowBounds", {})
        x, y = b.get("X", 0), b.get("Y", 0)
        wd, h = b.get("Width", 0), b.get("Height", 0)
        if wd <= 0 or h <= 0:
            continue
        cand = (w.get("kCGWindowNumber"), (x, y, wd, h))
        if best is None or wd * h > best[1][2] * best[1][3]:
            best = cand
    return best if best else (None, None)


def quit_app(timeout=10):
    osascript(f'tell application "{APP_NAME}" to quit')
    for _ in range(timeout):
        if run(["pgrep", "-f", PROCESS_HINT]).returncode != 0:
            return True
        time.sleep(1)
    run(["pkill", "-f", PROCESS_HINT])  # 兜底强杀
    time.sleep(2)
    return run(["pgrep", "-f", PROCESS_HINT]).returncode != 0


def launch_app(wait_secs=15):
    run(["open", "-a", APP_NAME])
    deadline = time.time() + wait_secs
    while time.time() < deadline:
        wid, bounds = find_window()
        if wid:
            return wid, bounds
        time.sleep(0.5)
    return None, None


# ---------------- 合成事件（需辅助功能权限） ----------------


def _post(ev):
    Quartz.CGEventPost(kCGSession, ev)


def click(x, y):
    """Warp + moved + mousedown/mouseup（间隔 ≥150ms）——实测 WKWebView 下才可靠命中。"""
    pt = Quartz.CGPointMake(x, y)
    Quartz.CGWarpMouseCursorPosition(pt)
    _post(Quartz.CGEventCreateMouseEvent(None, Quartz.kCGEventMouseMoved, pt, 0))
    time.sleep(0.06)
    _post(Quartz.CGEventCreateMouseEvent(None, Quartz.kCGEventLeftMouseDown, pt, 0))
    time.sleep(0.18)
    _post(Quartz.CGEventCreateMouseEvent(None, Quartz.kCGEventLeftMouseUp, pt, 0))
    time.sleep(0.1)


def press_key(keycode):
    ev = Quartz.CGEventCreateKeyboardEvent(None, keycode, True)
    _post(ev)
    time.sleep(0.05)
    ev = Quartz.CGEventCreateKeyboardEvent(None, keycode, False)
    _post(ev)
    time.sleep(0.05)


def type_text(text):
    """逐字符按 keycode 输入（仅覆盖本脚本需要的 ASCII）。未知字符退回 Unicode 事件。"""
    for ch in text:
        kc = _CHAR_KEYCODES.get(ch.lower())
        if kc is None:
            for down in (True, False):
                ev = Quartz.CGEventCreateKeyboardEvent(None, 0, down)
                Quartz.CGEventKeyboardSetUnicodeString(ev, len(ch), ch)
                _post(ev)
                time.sleep(0.05)
        else:
            press_key(kc)


# ---------------- 截图与图像分析（PIL 可选） ----------------


def capture_window(window_id, path):
    """screencapture 截窗（-x 无声、-o 无阴影），再 sips -Z 1600 缩放便于人工翻看。"""
    r = run(["screencapture", "-x", "-o", f"-l{window_id}", path], timeout=30)
    if r.returncode != 0 or not os.path.exists(path):
        return None
    run(["sips", "-Z", "1600", path], timeout=30)
    return path


def _pil():
    try:
        from PIL import Image
        return Image
    except ImportError:
        return None


def image_stats(path):
    """返回 (bytes, stddev 或 None)。PIL 缺失时 stddev=None 表示跳过方差断言。"""
    size = os.path.getsize(path)
    Image = _pil()
    if Image is None:
        return size, None
    from PIL import ImageStat
    im = Image.open(path).convert("L")  # 截窗 PNG 实际不透明，直接按灰度
    return size, ImageStat.Stat(im).stddev[0]


def gray_small(path, box=(320, 200)):
    """读图缩到 box 尺寸的灰度像素列表（比对用）。PIL 缺失返回 None。"""
    Image = _pil()
    if Image is None:
        return None
    im = Image.open(path).convert("L").resize(box)
    return list(im.tobytes())


def diff_mean(a, b):
    return sum(abs(p - q) for p, q in zip(a, b)) / len(a)


def detect_nav_bands(path, win_w=1440.0):
    """检测左侧导航条的文字行带（图像分析）。

    返回 [(img_y0, img_y1, 逻辑中心y), ...]，按 NAV_Y_BASE 换算回 900 高标定基准。
    用于 --calibrate 人工校对标定表；也用于登录页/主界面判别（主界面导航行带多）。
    """
    Image = _pil()
    if Image is None:
        return None
    im = Image.open(path).convert("L")
    iw, ih = im.size
    factor = iw / win_w  # 图像坐标 → 窗口逻辑坐标因子（动态计算）
    # 左侧导航条：x 取逻辑 18~200px；y 取逻辑 90~820px（避开 topbar 与 bottombar）
    x0, x1 = int(18 * factor), int(200 * factor)
    y0, y1 = int(90 * factor), int(820 * factor)
    data = im.crop((x0, y0, x1, y1)).tobytes()
    w = x1 - x0
    rows = [data[i * w:(i + 1) * w] for i in range(y1 - y0)]
    thr = 8.0
    bands, start = [], None
    for idx, row in enumerate(rows):
        noisy = statistics.pstdev(row) > thr
        if noisy and start is None:
            start = idx
        if not noisy and start is not None:
            if idx - start >= 6:
                bands.append((start + y0, idx + y0))
            start = None
    if start is not None:
        bands.append((start + y0, y1 - y0))
    return [(b0, b1, ((b0 + b1) / 2) / factor) for b0, b1 in bands]


def looks_like_main_ui(path):
    """主界面判别：左导航条文字行带 ≥8 条（登录页该区域只是皮肤背景，几乎无边带）。"""
    bands = detect_nav_bands(path)
    return bands is None or len(bands) >= 8  # PIL 缺失时保守返回 True（不盲打键盘）


# ---------------- 登录 ----------------


def do_login():
    """登录页：用户名 input 有 autoFocus，两个输入框/按钮都响应 Enter
    （见 apps/desktop/src/views/LoginView.tsx）。
    故只需：输入用户名 → Tab → 输入密码 → Return，全程无需点击表单坐标。
    调用前必须已用 looks_like_main_ui 确认确实停在登录页，避免往主界面盲打。
    """
    activate_app()
    time.sleep(0.4)
    type_text(USERNAME)
    press_key(KEY_TAB)
    time.sleep(0.2)
    type_text(PASSWORD)
    press_key(KEY_RETURN)


# ---------------- 视图遍历 ----------------


def goto_view(name, gx, gy, wid, prev_shot, shot_path, remark_extra, first=False):
    """点击导航并验证界面确有切换；无变化则 +6px 重试（避开行间空隙）。最多 3 次。
    first=True（列表第一个视图）：无变化时判 OK——启动恢复可能本就停在该视图，
    此时"点击目标视图无变化"是预期行为而非导航失效（v2.22 修正的误报盲区）。"""
    attempt = 0
    while attempt < 3:
        click(gx, gy + attempt * 6)
        time.sleep(CLICK_SETTLE_SEC)
        capture_window(wid, shot_path)
        prev, cur = gray_small(prev_shot), gray_small(shot_path)
        if prev is None or cur is None:
            return True, remark_extra  # 无 PIL，无法比对，信任基础断言
        if diff_mean(prev, cur) >= DIFF_NOCHANGE:
            return True, remark_extra
        attempt += 1
        remark_extra = f"第{attempt}次点击后界面无变化(差值<{DIFF_NOCHANGE})，y+{attempt*6}px 重试"
    if first:
        return True, "点击后界面无变化——启动恢复可能本就停在该视图（请人工核对截图内容）"
    return False, "点击后界面无变化：未命中导航行（标定偏移或导航失效），请人工核对截图"


def traverse_views(wid, bounds, shots_dir, report):
    """逐视图：点导航 → 截窗 → 基础断言。返回 (views, failed_count)。"""
    x, y, w, h = bounds
    nav_x = x + NAV_X_RATIO * w
    views = {}
    prev_shot = os.path.join(shots_dir, "_login_after.png")
    for i, (name, y_logical) in enumerate(CALIBRATION):
        gy = y + (y_logical / NAV_Y_BASE) * h
        print(f"[smoke] 视图[{name}] 点击 ({nav_x:.0f},{gy:.0f}) ...", flush=True)
        shot_path = os.path.join(shots_dir, f"{name}.png")
        remark = ""
        # 启动前留一份“当前界面”参照用于切换检测：直接用上一视图截图
        ok, remark = goto_view(name, nav_x, gy, wid, prev_shot, shot_path, remark, first=(i == 0))
        if ok:
            size, stddev = image_stats(shot_path)
            if size < MIN_PNG_BYTES:
                ok, remark = False, f"截图仅 {size}B（<{MIN_PNG_BYTES}B，疑似白/黑屏）" + (
                    f"；{remark}" if remark else "")
            elif stddev is not None and stddev < BLANK_STDDEV:
                ok, remark = False, f"疑似空白页（灰度 stddev={stddev:.2f} < {BLANK_STDDEV}）"
            else:
                remark = f"{size // 1024}KB" + (f", stddev={stddev:.1f}" if stddev is not None else "")
        views[name] = {"ok": ok, "png": shot_path, "remark": remark}
        print(f"[smoke]   -> {'OK' if ok else 'FAIL'} ({remark})", flush=True)
        prev_shot = shot_path
    failed = sum(1 for v in views.values() if not v["ok"])
    return views, failed


# ---------------- 标定辅助 ----------------


def calibrate(wid, bounds, shots_dir):
    """--calibrate：进主界面后截图检测导航行带，打印建议标定表（人工确认后写入脚本）。"""
    x, y, w, h = bounds
    nav_x = x + NAV_X_RATIO * w
    path = os.path.join(shots_dir, "_calibrate.png")
    click(nav_x, y + CALIBRATION[0][1] / NAV_Y_BASE * h)  # 先点一次工作区确保在主界面
    time.sleep(CLICK_SETTLE_SEC)
    capture_window(wid, path)
    bands = detect_nav_bands(path)
    if bands is None:
        print("[calibrate] 需要 PIL 才能做行带检测")
        return
    print(f"[calibrate] 检测到 {len(bands)} 条行带（期望 17 = 13 项 + 4 分区标题）：")
    pattern = (["分区:工作区", "工作区", "项目", "分区:创作", "Agent对话", "剧本", "分镜",
                "画布", "时间线", "分区:管理", "资产", "模型", "Skills", "Hermes连接",
                "任务", "分区:系统", "设置"])
    if len(bands) == len(pattern):
        print("[calibrate] 建议标定表（NAV_Y_BASE=900）：")
        for (_, _, cy), label in zip(bands, pattern):
            if not label.startswith("分区:"):
                print(f'    ("{label}", {round(cy)}),')
    else:
        for b in bands:
            print(f"    行带 逻辑中心 y={b[2]:.1f} (图像 {b[0]}-{b[1]})")
    print(f"[calibrate] 截图：{path}")


# ---------------- 主流程 ----------------


def main():
    ap = argparse.ArgumentParser(description="OneTV 真机 UI 冒烟")
    ap.add_argument("--out", default=os.path.dirname(os.path.abspath(__file__)),
                    help="输出目录（默认脚本所在目录），报告与 screenshots/ 落在这里")
    ap.add_argument("--calibrate", action="store_true",
                    help="只做导航行带检测并打印建议标定表，不跑完整冒烟")
    args = ap.parse_args()
    out_dir = os.path.abspath(args.out)
    shots_dir = os.path.join(out_dir, "screenshots")
    os.makedirs(shots_dir, exist_ok=True)

    report = {
        "timestamp": datetime.now().isoformat(timespec="seconds"),
        "app": APP_NAME,
        "window_bounds": None,
        "image_scale_factor": None,   # 图像坐标→窗口逻辑坐标因子 = 逻辑宽/图像宽（动态计算）
        "login": {"needed": None, "ok": None, "remark": ""},
        "views": {},
        "failed": 0,
    }

    print(f"[smoke] 输出目录: {out_dir}")

    # 1) 退出旧实例并重启
    print("[smoke] 退出已运行实例 ...")
    quit_app()
    print(f"[smoke] open -a {APP_NAME} 并等待窗口 ...")
    wid, bounds = launch_app(wait_secs=15)
    if not wid:
        report["login"] = {"needed": None, "ok": False, "remark": "窗口未出现"}
        report["failed"] = 1
        _write_report(report, out_dir)
        print("[smoke] 失败：未找到 OneTV 窗口")
        return 1
    report["window_bounds"] = list(bounds)
    print(f"[smoke] 窗口: id={wid} bounds={bounds}")

    # 2) 登录页检测：只有真的停在登录页才键入账号密码（会话持久化时直接进主界面）
    activate_app()
    time.sleep(1.0)
    pre = os.path.join(shots_dir, "_login_before.png")
    post = os.path.join(shots_dir, "_login_after.png")
    capture_window(wid, pre)
    if looks_like_main_ui(pre):
        report["login"] = {"needed": False, "ok": True,
                           "remark": "启动即主界面（会话已持久化），未键入账号密码"}
        print("[smoke] 已是主界面（无需登录）")
    else:
        print("[smoke] 检测到登录页，键入默认账号 ...")
        do_login()
        time.sleep(2.0)
        capture_window(wid, post)
        if looks_like_main_ui(post):
            report["login"] = {"needed": True, "ok": True, "remark": "登录成功"}
        else:
            report["login"] = {"needed": True, "ok": False,
                               "remark": "登录后仍是疑似登录页（密码已改？），请人工查看 _login_after.png"}
            print(f"[smoke] 警告：{report['login']['remark']}")
    capture_window(wid, post)

    if args.calibrate:
        calibrate(wid, bounds, shots_dir)
        return 0

    # 3) 逐视图遍历 + 断言
    views, failed = traverse_views(wid, bounds, shots_dir, report)
    report["views"] = views
    report["failed"] = failed

    # 图像坐标因子（供人工把截图上的坐标换算回窗口逻辑坐标用）
    Image = _pil()
    if Image is not None and views:
        first_png = next(iter(views.values()))["png"]
        iw, _ = Image.open(first_png).size
        report["image_scale_factor"] = round(bounds[2] / iw, 4)

    _write_report(report, out_dir)
    print(f"[smoke] 完成：{len(views)} 视图，失败 {failed}；报告 {out_dir}/smoke_report.json")
    return failed


def _write_report(report, out_dir):
    path = os.path.join(out_dir, "smoke_report.json")
    with open(path, "w", encoding="utf-8") as f:
        json.dump(report, f, ensure_ascii=False, indent=2)


if __name__ == "__main__":
    sys.exit(main())
