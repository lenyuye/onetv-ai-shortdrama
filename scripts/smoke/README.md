# OneTV 真机 UI 冒烟脚本

不修改应用代码，在真实运行的 OneTV.app 上自动遍历全部左侧导航视图并截图，
做基础健康断言，产出 `smoke_report.json` + `screenshots/<视图名>.png`。
**人看截图仍是最终判断**——脚本只筛明显问题（白屏 / 黑屏 / 疑似空白页 / 点击后界面无变化）。

## 用法

```bash
# 默认输出到脚本所在目录（报告 smoke_report.json、截图 screenshots/）
python3 scripts/smoke/onetv_smoke.py

# 指定输出目录
python3 scripts/smoke/onetv_smoke.py --out /tmp/onetv_smoke_out

# 应用改版后重测导航标定表（进主界面 → 截图 → 检测导航行带 → 打印建议 y 值）
python3 scripts/smoke/onetv_smoke.py --out /tmp/onetv_smoke_out --calibrate
```

退出码 = 失败视图数（0 = 全部通过基础断言）。

## 前提

- macOS，`/Applications/OneTV.app` 已安装；Python3 + pyobjc（系统自带，可先
  `python3 -c "import Quartz"` 验证）。PIL（pillow）强烈建议：缺失时跳过
  「疑似空白页」「点击后界面无变化」两项图像断言。
- **辅助功能权限**：脚本用 `CGEventPost` / `CGWarpMouseCursorPosition` 合成鼠标键盘事件，
  运行脚本的终端 App（Terminal / iTerm / VSCode 等）必须在
  系统设置 → 隐私与安全性 → 辅助功能 中已授权。平时已在做人工点选的终端通常已授权。
- **屏幕录制权限**：`screencapture` 截窗需要（用截窗工作流的终端一般已具备）。
- **无人值守注意**：脚本会退出并重启 OneTV、抢占鼠标键盘约 40 秒，运行期间不要操作机器。
- 登录：脚本先截图判别是否停在登录页（左导航行带检测），**只有真在登录页才键入**
  默认账号 `admin / 12345`（用户名框有 autoFocus，Tab 切密码框，Return 提交，
  全程不点表单坐标）。会话持久化时应用直接进主界面，脚本不会盲打键盘——
  这一点很重要，否则字符会打进主界面的输入框。若已改密，请同步改脚本顶部
  的 `USERNAME` / `PASSWORD`。

## 流程

1. 退出已运行 OneTV 实例（osascript quit，超时后 pkill 兜底）；
2. `open -a OneTV`，用 Quartz `CGWindowListCopyWindowInfo` 找
   `kCGWindowOwnerName ∈ {OneTV, onetv-desktop}` 且 `kCGWindowLayer==0` 的窗口（≤15s）；
3. 登录页检测（见上），必要时键盘登录；
4. 逐视图：点左侧导航（Warp + moved + mousedown/mouseup，间隔 180ms）→ 等 1.2s
   → `screencapture -x -o -l<windowid>` 截窗 → `sips -Z 1600` 缩放；
   点击后与前一张截图比对（缩至 320x200 求平均灰度差），界面无变化则 y+6px 重试
   （最多 3 次，防点进行间空隙）；
5. 断言：窗口存在；点击后界面确有切换；PNG > 30KB（白/黑屏通常极小）；
   PIL 可用时算灰度 stddev，< 3.0 判「疑似空白页」；
6. 写 `smoke_report.json`（时间戳、窗口 bounds、登录检查、图像→逻辑坐标换算因子、
   每视图 {ok, png 路径, 备注}）。

## 标定表维护（CALIBRATION）

脚本顶部的 `CALIBRATION = [(视图名, 实测逻辑 y @900 高窗口), ...]` 与 `NAV_X_RATIO = 0.041`
来自 2026-10-06 在 1440×900 逻辑窗口、OneTV v2.19.0 实机截图上的导航条文字带检测
（`--calibrate` 可随时重测），顺序与 `apps/desktop/src/App.tsx` 的 `NAV` 数组逐项核对一致：

| 视图 | 逻辑 y | | 视图 | 逻辑 y |
|---|---|---|---|---|
| 工作区 | 130 | | 资产 | 423 |
| 项目 | 163 | | 模型 | 457 |
| Agent 对话 | 227 | | Skills | 489 |
| 剧本 | 261 | | Hermes 连接 | 522 |
| 分镜 | 293 | | 任务 | 557 |
| 画布 | 326 | | 设置 | 619 |
| 时间线 | 359 | | | |

注意事项：

- 实测行距约 33 逻辑 px（`.nav-item` = 13px 字号 ×1.55 行高 + 7px×2 padding），
  分区标题（工作区/创作/管理/系统）独占一行——**不要**按行距自行推算 y。
- ⚠️ 早期人工标定值（119/155/253/…/687）与 v2.19.0 实际 UI 偏差随行号增大
  （首行 +11px，末行 −68px，系顶栏高度变化所致），已全部按实测重标；
  升级改版（增删导航项、改顶栏）后请用 `--calibrate` 重测一遍。
- 导航是顶部锚定的固定高度布局，y 基本不随窗口高变化；脚本运行时仍按 H/900
  比例换算（H=900 时为精确值），窗口尺寸与 900 差异大时建议 `--calibrate` 重测。
- x 取窗口左缘 + 45~66 逻辑 px 的行首文字区（比例 0.041），避开 hover 高亮误导：
  合成事件下 WKWebView 的 `:hover` 有残留，判断命中与否只看主区内容，不看高亮框。
- 某视图连续报「点击后界面无变化」时，先 `--calibrate` 核对 y，再怀疑导航本身。

## 输出示例

```json
{
  "timestamp": "2026-10-06T12:00:00",
  "window_bounds": [176, 80, 1440, 900],
  "image_scale_factor": 0.9,
  "login": {"needed": false, "ok": true, "remark": "启动即主界面（会话已持久化），未键入账号密码"},
  "views": {"工作区": {"ok": true, "png": ".../screenshots/工作区.png", "remark": "412KB, stddev=28.4"}},
  "failed": 0
}
```

`image_scale_factor = 逻辑宽/图像宽`（动态计算），用于把截图上的坐标换算回窗口逻辑坐标。
`_login_before.png` / `_login_after.png` 是登录判别的诊断截图，可顺手人工复核。
