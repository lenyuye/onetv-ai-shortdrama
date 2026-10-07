#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""OneTV 深度测试交互驱动：复用冒烟脚本的窗口/点击/截图辅助。
用法：python3 guitest.py <cmd> ...
  click <img_x> <img_y>   按 1600 宽截图坐标点击（自动换算逻辑坐标+窗口偏移）
  dclick <img_x> <img_y>  双击
  paste <text>            剪贴板粘贴（避开输入法）
  key <keycode>           按键（如 36=Return, 53=Esc）
  shot <name>             截窗到 screenshots/gt_<name>.png
  nav <视图名>            按标定表点导航
"""
import sys, os, time, subprocess
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import onetv_smoke as S
import Quartz

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "screenshots")

def win():
    w = S.find_window()
    if not w:
        print("[gt] no window"); sys.exit(1)
    wid, b = w
    return wid, b  # b = (x, y, w, h)

def img2global(ix, iy, b):
    # 截图宽 1600 显示，窗口逻辑宽 b[2]
    sw = 1600.0
    f = b[2] / sw
    return b[0] + ix * f, b[1] + iy * f

CAL = {"工作区":130,"项目":163,"Agent对话":227,"剧本":261,"分镜":293,"画布":326,
       "时间线":359,"资产":423,"模型":457,"Skills":489,"Hermes连接":522,"自定义指令":557,
       "任务":590,"设置":652}

def main():
    cmd = sys.argv[1]
    b = win()[1]
    if cmd == "click":
        x, y = img2global(float(sys.argv[2]), float(sys.argv[3]), b)
        if not os.environ.get("GT_NO_ACT"):
            S.activate_app(); time.sleep(0.3)
        S.click(x, y); time.sleep(0.8)
        print(f"[gt] clicked global ({x:.0f},{y:.0f})")
    elif cmd == "dclick":
        x, y = img2global(float(sys.argv[2]), float(sys.argv[3]), b)
        if not os.environ.get("GT_NO_ACT"):
            S.activate_app(); time.sleep(0.3)
        S.click(x, y); S.click(x, y); time.sleep(0.8)
        print(f"[gt] dclicked global ({x:.0f},{y:.0f})")
    elif cmd == "paste":
        if not os.environ.get("GT_NO_ACT"):
            S.activate_app(); time.sleep(0.3)
        subprocess.run(["pbcopy"], input=sys.argv[2].encode())
        time.sleep(0.2)
        S._post(Quartz.CGEventCreateKeyboardEvent(None, 55, True))   # Cmd down
        time.sleep(0.05)
        S.press_key(9)                                               # V
        time.sleep(0.05)
        S._post(Quartz.CGEventCreateKeyboardEvent(None, 55, False))  # Cmd up
        time.sleep(0.5)
        print("[gt] pasted")
    elif cmd == "key":
        if not os.environ.get("GT_NO_ACT"):
            S.activate_app()
        S.press_key(int(sys.argv[2]))
        time.sleep(0.5)
        print(f"[gt] key {sys.argv[2]}")
    elif cmd == "shot":
        wid, b = win()
        p = os.path.join(OUT, f"gt_{sys.argv[2]}.png")
        S.capture_window(wid, p)
        print(f"[gt] shot {p} bounds={b}")
    elif cmd == "nav":
        name = sys.argv[2]
        y = CAL[name]
        x = b[0] + 59
        if not os.environ.get("GT_NO_ACT"):
            S.activate_app(); time.sleep(0.3)
        S.click(x, b[1] + y)
        time.sleep(1.0)
        print(f"[gt] nav {name} at ({x:.0f},{b[1]+y:.0f})")
    else:
        print(__doc__)

if __name__ == "__main__":
    main()
