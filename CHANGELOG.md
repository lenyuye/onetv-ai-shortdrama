# Changelog

本文件记录 OneTV 的阶段性交付。每个 Phase 完成：设计文档 → 实现 → 单元测试 → 构建 → 冒烟测试 → 更新本文件。

## [2.26.0] — v2.26.0：对话双消息修复 + 表单内自动获取模型

### 修复
- **💬 Agent 对话「问一次回两条」**（用户反馈）：对话意图（低风险自动执行）不再插入「已自动执行：对话回复…」计划卡——回复气泡随后即到，双消息重复；其他意图（需审批/批量任务）计划卡保留。

### 追加
- **⚡ 表单内「自动获取模型」按钮**（用户需求）：新增/编辑 Provider 弹窗中，只要填了 Base URL（和 API Key）即可点击直接拉取远端 /models 并自动填入模型 ID（按 modelId 去重，不覆盖已填行）——无须先保存。实现：新增 `provider_fetch_models` 命令，临时 Key 走固定钥匙串条目用后即删（不落盘/日志），Base URL 主机按 provider_save 同语义加入白名单；支持 OpenAI 兼容 / Ollama / SD / ComfyUI。

## [2.25.1] — v2.25.1：用户反馈三连修（预设分组文案 / 驱动描述 / 模型列表限高）

### 修复
- 平台预设「通用」分组名称简化为 **「通用功能」**（去掉「对话 / 文本」后缀，用户反馈）。
- 驱动「自定义 / OpenAI 兼容」描述精简为「自定义接入国产模型、GPT、中转等（遵循 /chat/completions 与 /models 协议即可）」（用户反馈：不要长串例子）。
- **Provider 卡模型列表限高**：模型数 >8 时列表区最高 220px 内部滚动，不再把页面无限拉长（用户反馈；方舟 /models 目录一拉 100+ 模型时尤其明显）。
- 数据修复：多实例并存时旧实例退出会用内存注册表覆盖 providers.json（本次 Seedream/豆包 条目丢失即此因），已按原 Provider ID 重建（钥匙串 Key 无缝对接），豆包 Provider 仅保留两个已验证可用的模型（doubao-seed-2-1-lite-260915 / deepseek-v4-flash-ga-260731）。

## [2.25.0] — v2.25.0：模型接入体验批（通用对话预设 / 驱动更名 / 自动拉模型 / FFmpeg 卡布局）

### 追加
- **💬 平台预设库新增「通用（对话 / 文本）」分类**（5 个 OpenAI 兼容官方 API 预设）：DeepSeek（deepseek-chat/reasoner）、Kimi 月之暗面（kimi-k2）、通义千问 Qwen（百炼 compatible-mode）、豆包（火山方舟，与 Seedream/Seedance 同 Key）、ChatGPT（OpenAI 官方）。套用即填驱动/Base URL/默认模型/对话能力，用于剧本、拆分、结构化输出等一切文本生成。
- **🔄 创建 Provider 后自动拉取远端模型列表并合并**（OpenAI 兼容 / Ollama / SD 驱动）：保存 + Key 写入后自动请求 /models，按 modelId 去重并入模型行并二次保存（provider_save 不触碰钥匙串）；失败静默不影响保存。配合方舟类平台可直接看到账号实际已开通的模型/接入点 ID。
- 驱动下拉「OpenAI 兼容」更名 **「自定义 / OpenAI 兼容」**，说明列明 DeepSeek/Kimi/千问/豆包/ChatGPT 官方 API、中转站、聚合网关均可（即用户要的「自定义」选项——自定义 HTTP 模板驱动仍保留给任意非 OpenAI 形状的 API）。
- Seedream/Seedance 预设说明刷新（补充 4.0/pro 版模型 ID 与计价说明）。
- FFmpeg 卡：自定义路径与「保存并重新检测」上移紧随能力瓷贴，消除中部大空白（用户反馈）。

## [2.24.2] — v2.24.2：全面软件测试修复批（P0 钥匙串 + 对话回复显示）

### 修复
- **🔴 P0：API Key 从未真正写入 macOS 钥匙串（v2.1 起所有真实付费 API 均不可用的根因）**。`Cargo.toml` 中 `keyring = "3"` 未启用平台 feature——keyring v3 在 macOS 无 `apple-native` feature 时静默回退到**内存 mock 凭据库**，且每个凭据实例数据私有：写入成功、实例随用随弃，「API Key 已写入系统钥匙串」的提示与 `secret stored` 日志全部失真，真实钥匙串无任何条目，任何真实 API 任务执行时必报「密钥未配置：<Provider名>」，重启后 Key 全部丢失，「测试连接」显示 0ms 假成功。修复：`keyring = { version = "3", features = ["apple-native"] }`。升级后此前填过的 Key 需重新填写一次。
- **🟠 P1：Agent 对话回复不渲染 / 顶栏任务徽标不动 / 流式打字机失效（共同根因）**。Tauri v2 事件名只允许字母数字与 `- / : _`，**含 `.` 的事件名（`job.*`、`agent.message(.delta)`、`hermes.inbound`、`webhook.*`）在 `emit()` 时被拒绝**，而事件桥 `let _ = h2.emit(...)` 把错误静默吞掉——所有带点事件自始至终从未到达前端：对话回复气泡不显示（后端已生成回复）、任务徽标恒为 0、任务列表只能靠 15 秒轮询兜底、菜单事件（`menu:*` 冒号合法）则一直正常。修复：事件桥统一把事件名中的 `.` 映射为 `:` 后再 emit（webhook 出站回调仍按原始事件名匹配），前端全部订阅同步改名（`agent:message`、`job:created` 等）。

## [2.24.1] — v2.24.1：剧本场景右键菜单接线 + 全面盘点清理（最终盘点批）

### 追加
- **📝 剧本场景右键菜单接线**：场景卡片右键 → 📄 复制场景 / ⧉ 克隆副本 / 📋 粘贴到末尾(有剪贴板时) / 🗑 删除场景(立即保存)——v2.17 拆分时已实现但未接线的场景实体操作全部生效,与画布/分镜右键体验对齐。
- 🧹 清理「关于」卡 checkUpdate 死代码(v2.11 起无 UI 引用;真实更新源属外部条件待接入)。

## [2.24.0] — v2.24.0：设置页 FFmpeg/存储位置卡重设计（用户拍板方案 A）

### 重设计（v2.23 预览拍板:FFmpeg=方案A,存储=方案A）
- **🎞️ FFmpeg 卡「状态仪表」**：绿色就绪横幅（指示灯+就绪文案+大版本号;未检测到时转橙色警示）+ 三格能力瓷贴（ffmpeg=拼接·转码·混音 / ffprobe=时长·分辨率·音轨探测 / 字幕滤镜=缺 libass 自动降级）+ 自定义路径与重新检测保留。卡片 flex column 拉满,消除留白。
- **💾 存储位置卡「路径卡」**：两块大路径条——应用数据目录（🗄️ 固定,附"随系统用户隔离"说明）/ 默认项目文件夹（📁 可配置,未设置时提示,清除按钮保留）+ 绿色"所有数据只存本机"横幅。消除留白。
- 新增 12 条界面翻译;探测/保存/选择/清除逻辑零变化。

## [2.23.0] — v2.23.0：用户反馈修复批（5 项代码修复 + 2 项设计预览待拍板）

### 修复
- **🐛 删除会话时界面跟着 toast 顶起(根因修复)**:`global.css` 的 `.app-shell > *:not(.skin-layer) { position:relative }` 把作为 app-shell 直接子元素的 Toaster 的 `position:fixed` 劫持成 relative——toast 变成网格布局内的普通元素,每增删一条就把整个界面推挤一下、且贴左错位。改为显式枚举布局子元素(.topbar/.app-body/.bottombar/.login-card)。另:toast 栈上限 3(连续操作丢最旧)、modal-overlay 层级 900→1100(通知永不遮盖确认框)。
- **🎨 节点生成面板输入框太小**:min-height 52→112px(上限 280px),并随内容自适应增高。
- **🕸️ 画布节点面板拖拽失效**:WKWebView 对 HTML5 DnD 不可靠——改为指针式自绘拖拽(mousedown→move>6px→mouseup),松手落在画布内即按光标位置建节点,带拖拽幽灵预览;普通点击行为不变。
- **💬 会话右键菜单**:右键会话 → 重命名 / 删除(与悬停 × 等效,连续删除更快)。
- **🛰️ Hermes 发送指令输入框**:宽度占满卡片(width:100%),高度 88→180px。

### 预览(待拍板后实施)
- 设置页「FFmpeg / 存储位置」两卡留白过多——各出 2 版设计(状态仪表/渲染管线;路径卡/数据地图),预览图在 Desktop/OneTV/preview/,用户选定后实现。

## [2.22.0] — v2.22.0：出站 Webhook + 画布运行面板 + 性能/可达性（backlog 批三，主线程实现）

### 追加
- **🔗 出站 Webhook 回调**：任务终态（succeeded/failed，retry_wait 不回调）POST JSON 到用户配置 URL——HMAC-SHA256 签名（X-OneTV-Signature）+ X-OneTV-Event 头，失败自动重试 2 次（2s/8s）；本地/私网地址直发，公网地址经 Gateway 策略校验且启用时主机自动加入 allowed_hosts；全程审计（delivered/failed/skipped）。设置 → 任务引擎卡片新增启用/URL/密钥配置。核心逻辑在 crates/core/src/webhook_out.rs（签名/载荷/本地判定/重试投递均可单测，含本地 TcpListener 集成测试 7 项）。
- **▶ 画布批量运行面板（Phase 2）**：运行期间左下浮层实时统计（每 2s 拉取画布文档，后端逐节点落盘）——进度条 + 完成/失败/跳过/总数 + 失败节点清单（标题+原因）；「↻ 重试失败节点」复用 resume 语义（非 done 节点自动重跑）；运行结束保留终态视图。
- **⚡ 流式渲染隔离**：对话历史气泡抽为 memo 组件——流式 delta 只重渲染打字气泡，长会话不再整列表重放。

### 可达性
- 全局 :focus-visible 焦点环（键盘导航可见，鼠标点击不打扰）。

## [2.21.0] — v2.21.0：AES 加密工程包 + Plugin SDK 完整实现（backlog 批二）

### 追加
- **🔐 AES 加密工程包**：`ONETVENC1` 格式（PBKDF2-HMAC-SHA256 120k 轮 + AES-256-GCM）——导出可选密码加密，导入自动探测密包并弹密码框（错误密码/篡改可读报错）；无密码导出与旧版字节级兼容；加解密全在 spawn_blocking。项目页「🔐 加密」与导入密码框。
- **🧩 Plugin SDK 最小完整版**：`plugins/` 提示词包（plugin.json：id/semver/kind 白名单/prompts 模板）——plugin_list 升级（坏插件标错不崩）+ plugin_get + plugin_render_prompt（`{{input}}`/`{{project.name}}`/`{{episode.title}}` 渲染，纯文本拼接零代码执行，路径 canonicalize 双保险）；大＋菜单恢复「插件」面板（列表/详情/{{input}} 输入/渲染插入输入框/打开插件目录）。附带示例插件一枚（app_data/plugins/demo-pack）。
- **ComfyUI 测试扩展**：Mock 服务器新增 8 场景（error/failed/node_errors/HTTP 500/view 404/超时注入/vars 边界/seed 随机性）；**修复真 bug**：/history 返回 `failed` 状态时此前只识别 `error`，会白轮询 30 分钟才超时；轮询预算参数化（生产路径行为不变）。
- 清理全部 unused 类 clippy warning（6 处历史遗留）。

## [2.20.0] — v2.20.0：省盘入库 + UI 冒烟脚本化 + i18n 收尾 + 开源准备（backlog 批一）

### 追加
- **💾 成片零拷贝入库**：新 `register_asset`（与 import_asset 共用内核，sha256 幂等）——导出成片/时间线成片（新旧两分支）登记资产不再拷贝进 assets/（renders/ 唯一副本），几十 MB 视频不再双倍占盘；delete 零拷贝资产只删 DB 行不删 renders/ 文件；生成类小文件仍走拷贝隔离。golden_pipeline 断言强化（成片 path 指向 renders/ 且 assets/ 无副本）。
- **🤖 UI 冒烟脚本化**：scripts/smoke/onetv_smoke.py——Quartz 遍历 13 视图（动态标定表+--calibrate 一键重测、登录页检测、点击后切换断言、空白页方差检测），产出 screenshots/ 与 smoke_report.json；本轮实测 13/13 通过，并借此修正了旧手工标定的整体行位偏移。
- **.privacy**：补 PRIVACY.md（README 引用缺失）；README 功能清单/测试/目录结构更新到 v2.20 现状；打 tag v2.16.0~v2.19.0。

### 修复
- 聊天消息时间戳改存 ISO、显示侧按界面语言格式化（en-US/zh-CN），旧会话持久化时间串容错原样显示。

## [2.19.0] — v2.19.0：多版本导出 + backlog 清剿批

### 追加
- **📦 多版本导出**：新命令 `export_render(episode, presets[], burnSubtitle, includeSrt)`——按所选画幅预设(抖音竖版/小红书竖版/横版/方形/母版)批量创建导出任务；新 `ExportDialog` 弹窗（预设多选+烧录字幕+SRT 侧车），入口在分镜页与时间线页工具栏；导出源三层兜底（sourcePath 预留 → assets 最新成片 → renders/ 目录按 mtime 扫描，修复时间线渲染产物未入库导致导不到的缺口）；导出产物登记进资产库（kind videos，sha256 幂等）；**修复 master 预设 scale=0:0 非法滤镜**（保持源画幅）。
- 前端 28 项 / Rust 74 项测试全绿（新增导出参数校验 2 例）。

### 修复（拆分 backlog 清剿）
- 会话删除增加二次确认（ConfirmDialog）；剧本 refreshDoc 依赖补 t；任务页/剧本版本时间格式随界面语言（en-US/zh-CN）；画布连线报错（端口类型不兼容三条完整文案）接入字典；isLocalProvider 补 IPv6 回环([::1]/::1)；applyPreset 清空残留 ComfyUI 工作流模板；MemoryRow 无效 onEdit 死代码移除；ModelsView/JobsView 多处 i18n t 变量遮蔽改名。

## [2.18.0] — v2.18.0：多轨时间线编辑器（第一二类清单：项 19，最后一件）

### 追加（规格 §12.2 时间线数据结构落地）
- **🎞️ TimelineView 多轨编辑器**：新增「时间线」视图（创作区）——视频/音频/字幕三条泳道 + 时间标尺（缩放 20~200 px/s），片段拖拽移动（0.1s 吸附）、左右缘拖拽修剪（trimIn/duration），检查器精确编辑 start/duration/trimIn/音量(0~2)/转场(淡入淡出 0.5s)/字幕文本；轨头「+ 添加」从资产库点选（视频/音频自动 ffprobe 真实时长）；从分镜一键生成时间线（outputAssetId 镜头顺序排列 + shot.subtitle 生成字幕轨）；800ms 防抖自动保存（分集切换冲刷防串写）；渲染成片按钮建 TimelineRender 任务并轮询进度（顶栏「渲染中 p%」徽标）。
- **后端多轨渲染引擎**：crates/media/src/timeline.rs——schemaVersion 2.0 文档走新引擎：视频轨片段归一化（-ss trimIn/淡入淡出滤镜/按 clip volume 保留或静音源音频）+ 黑场片段补隙；音频混合单 filter_complex（volume+adelay+amix 全部参与片段）；字幕轨→SRT；复用 concat_clips 流复制 + finalize（硬字幕降级/混音 mux）。
- **四个新命令**：timeline_get / timeline_save（原子写）/ timeline_render（入任务队列，Agent 意图 timeline.render 共用）/ timeline_probe_asset（ffprobe 时长/分辨率/音轨）。timeline_render_handler 双分支：2.0 走多轨引擎，旧文档保持线性逻辑兼容。
- **测试**：Rust 63 项全绿（含 2 个 FFmpeg 集成测试：混音+字幕+转场时间线端到端、黑场补隙时长断言）；前端 28 项 vitest（新增归一化/从分镜生成 5 项）。
- 版本号升至 2.18.0（第一二类 10/10 完成）。

## [2.17.0] — v2.17.0：五大千行组件拆分（第一二类清单：项 30）

### 重构（行为零变化）
- **五个千行视图全部拆为「组合根 + hooks + 子组件」**，主文件合计 6449 行 → 2108 行：
  - CanvasView 1341→495（7 个 hooks：文档/撤销重做/批量运行/右键菜单/剪贴板/节点面板/快捷键 + 4 个画布子组件）；
  - AgentChatView 1319→426（会话侧栏/消息列表/计划卡/大+菜单/附件 chips 等 10 个子组件 + 4 个 hooks）；
  - SettingsView 1294→131（9 张卡片子组件 + 测试时钟钩子 useTimeHook）；
  - ModelsView 1256→530（Provider 编辑器 hook + 4 个子组件）；
  - ScriptView 1239→526（版本 hook + 场景操作 hook + 6 个子组件；PlanPanel 保持从原文件 re-export 供 StoryboardView 复用）。
- 所有 t() 中文键、DOM/className、交互时序、持久化数据结构逐字保留（子智能体做了字符串 multiset diff 与 CSS 逐字 diff 验证）；typecheck 0 错误、vitest 23 项全绿。

### 重构中记录未改的疑似问题（ backlog ）
- 剧本页场景右键菜单为死代码（未接线）；会话删除无确认弹窗；refreshDoc 闭包捕获旧 t（切语言后 toast 文案滞后）；ScriptView 无防抖保存（显式保存 + 实体操作立即落盘）。

## [2.16.0] — v2.16.0：i18n 字典层（第一二类清单：项 35）

### 追加
- **🌐 i18n 字典层**：以「中文原文为键」的轻量方案——`src/i18n.ts` 提供 `t(text, vars)` 与 `useT()`（useSyncExternalStore 订阅语言切换触发重渲染）；缺译自动回退中文原文，永不白屏。翻译按视图分片存 `src/i18n/en/*.ts`（9 个片段、1000+ 键，与视图一一对应避免合并冲突）。
- **全量替换**：24 个前端文件（全部视图/画布组件/命令面板/api 层）的用户可见中文 UI 字符串收敛为 t() 调用（约 900+ 处）；持久化/比较耦合的字符串（画幅枚举、节点类型、默认标题、后端错误匹配等）严格保持原值不动，仅在显示侧翻译。
- **语言切换**：设置 → 外观设置 → 界面语言（中文 / English），偏好存 localStorage('onetv-lang')；命令面板过滤同时匹配原文与译文。
- **字典完整性测试**（src/i18n.test.ts）：无空译文、跨分片同键不同译必须经 OVERRIDES 裁决、OVERRIDES 无过期键三重守护；本轮裁决 24 处风格级冲突。

### 边界说明
- 日期/时间格式化（toLocaleString("zh-CN")）、LLM 指令 payload、导出文件内容保持现状；画布连线兼容性报错（node-sdk 动态文案）暂未接入。

## [2.15.0] — v2.15.0：视频理解 VLM 自动探测 + Webhook 入向 + Plugin SDK 框架

### 追加（第一二类清单：项 20/26）
- **🧠 视频理解 VLM 语义分析（项20）**：自动探测已配置 Vision 能力的 Provider（走能力路由 + 离线模式约束），对前 4 个关键帧逐帧多模态分析（OpenAI 兼容 chat：text+image_url），严格 JSON 回填景别/运镜/场景/角色/动作/色调字段；单帧失败自动跳过；未配置 Vision 时保持原确定性管线（notes 动态标注分析结果）。
- **🔗 Webhook 入向（项26，规格 §22.5 最小版）**：本机回环 HTTP 监听（默认关闭，端口/token 独立配置）——POST /webhook?token=…：token 未配置 403 拒绝（与 Hermes 同安全策略）、不匹配 401；白名单动作 create_image 直建生图任务，其余事件转发为 app 事件（webhook.event/received）供前端/技能订阅，全程审计。
- **🧩 Plugin SDK 框架（项26）**：plugin_list 命令 + 插件清单（app_data/plugins/*/plugin.json）——与 Skill 相同安全模型（提示词包，不加载任意代码），为后续插件生态铺底。
- 版本号升至 2.15.0（第一二类 6/9 完成；35/30/19 见续传点）。

## [2.14.0] — v2.14.0：画布批量运行引擎 + 预算金额化 + 记忆语义搜索

### 追加（第一二类清单：项 25/16/18/28）
- **▶ 画布批量运行引擎（项25，规格 §7 condition/review 语义落地）**：工具栏「▶ 运行全图」按拓扑顺序执行——text 节点标记完成；image/video/audio 节点创建生成任务并等待完成后产物回填节点（单任务 20 分钟上限）；**condition 节点求值 `contains:关键词`**（对照上游文本，未命中自动裁剪 fail 分支下游）；**review 节点暂停批次**等待人工批准（检查器内「✓ 批准并继续运行」→「↻ 恢复运行」自动跳过已完成节点）；失败中止并保留已完成进度。生成节点缺提示词自动跳过并标注原因。
- **节点禁用/锁定（项25）**：检查器新增 ⏸ 禁用（批量运行跳过）与 🔒 锁定（禁删除/禁编辑）开关；节点卡片显示徽标；面板直发与删除均受保护。
- **💰 预算守卫金额化（项16）**：模型页每个模型可配「单价 ¥/次」→ 任务成功后按 `{providerId}/{modelId}` 累计金额；守卫新增「每日金额上限 / 累计金额上限（¥，0=不限）」；超限拦截文案带金额；看板瓷贴显示今日/累计花费。未配置单价的模型只计次数不受影响。
- **video.extend 路由参数（项18，最小版）**：生视频任务 input 增加 mode（extend/generate）——Mock extend 走参考图延续，Custom HTTP 模板可用 `${input.mode}` 区分续写端点。
- **记忆语义搜索（项28）**：意识模块搜索升级——字符二元组 TF 向量 + 余弦相似度排序（纯本地、无外部 embedding 依赖、中文友好），含 includes 兜底；新增 `memory_search` 命令。
- 版本号升至 2.14.0。

## [2.13.0] — v2.13.0：规格缺口落地批 + 体验批（审查清单二/三/四可执行项）

### 追加（规格缺口）
- **L4 Reviewer（轻量版）**：执行计划生成后自动启发式复核——离线模式与远程调用冲突、生图/生视频缺提示词、远程调用 ≥10 次的成本提示；备注显示在计划卡（🔎 前缀）。
- **Continuity Validator（最小版）**：拆分镜时校验镜头角色是否在 Story Bible 登记，未登记写入分镜表 continuityWarnings（生成参考图无法绑定的前瞻提示）。
- **多版本导出生效**：export 真正消费 burnSubtitle/includeSrt——烧录字幕（ffmpeg subtitles 滤镜，缺 SRT 侧车时报可读错误）与 SRT 随导出复制。
- **自动 QC 扩展**：新增音轨存在性检测（无音轨在任务页 QC 徽标中标出）。
- **Recreate Planner（最小版）**：新增「从视频重建画布」——把视频理解的镜头结果一键重建为画布文本节点（网格布局，旧画布自动备份），项目页入口。
- **Provider 配置导入/导出（API-11）**：模型页「📤 导出配置 / 📥 导入配置」——JSON 含全部 Provider 结构（不含 API Key，导入后需重填；导入走驱动-能力校验）。
- **Skill Git 安装**：Skills 页输入仓库地址（可选 tag/branch）→ git clone --depth 1 → 同一 manifest 校验安装链路。
- **Custom HTTP Mock Server E2E（API-03）**：集成测试实测 submit→poll（jobId 注入校验）→ 产物下载全链路。

### 改进（体验批，含 v2.11.0 后遗留）
- **轮询统一**：删除 App 5s 全量轮询（纯事件驱动），任务页兜底轮询 2s→15s。
- **CanvasView job.succeeded 闭包过期修复**（ref 镜像模式）。
- **useTauriEvent hook**：统一「卸载早于 listen resolve」竞态处理，HermesView/App 全部事件接入。
- **window.confirm 全部替换为自定义对话框**（3 处，删除工程带红色确认按钮）。
- **视图状态持久化**：记住上次页面与右栏折叠态。
- **文档纠偏**：ARCHITECTURE.md 状态描述、README tests/ 描述、删除空 migrations/ 目录。

### 工程化
- CI 新增 cargo clippy 报告步骤；前端测试扩面（17 项）。

### 说明（诚实延期项，见 44 项清单）
- 16 Cost Guard 金额化（需模型定价 UX）、18 video.extend 平台级路由、19 可视化时间线编辑器、20 OCR/ASR/VLM、25 condition/review 执行引擎、26 Webhook 与 Plugin SDK、28 sqlite-vec、30 巨型组件拆分、35 i18n、37 更新发布源、39 Windows、40 git 仓库、43/44 真机实测（外部条件）。
- 版本号升至 2.13.0。

## [2.12.0] — v2.12.0：安全与稳定性尾巴清零（审查清单一 1-14）

### 修复
- **Gateway 重定向防护**：携带鉴权头的请求不再自动跟随 302（此前白名单 Provider 可把密钥转投任意域名）——手动逐跳跟随（≤3 跳），每一跳重新过策略引擎 + 重新挂鉴权；download 场景保持允许重定向（无鉴权头）。
- **is_local_base 前缀绕过修复**：`http://localhost.evil.com` 此前被误判为本机（Hermes token 可泄露）——改为精确解析 host 比对，新增仿冒域名测试。
- **Hermes 反向控制鉴权**：未设置 token 时 `/invoke` 从无鉴权放行改为 403 拒绝（仅 /health 放行）。
- **测试时钟钩子加门禁**：release 构建调用 `debug_set_time_offset` 直接报错。
- **Job 落库失败不再静默**：persist/add_event 失败写 error 日志（此前 `let _ =` 吞掉，状态机退化为纯内存无告警）。
- **错误重试分类**：新增 `From<GatewayError> for JobError`——密钥缺失/策略拒绝/解析失败/4xx 一律不重试；网络错误/超时/5xx/429 才退避重试（此前 401 也重试 3 次白扣费），生成链路 8 个调用点接入。
- **未打开项目时 Chat 不再静默丢失**：直接返回可读错误（此前回退 temp 目录 → job 永不执行）。
- **onetv-asset 协议异步化 + Range 支持**：视频播放走 206 分段（单段 ≤8MB），不再主线程整文件读入内存。
- **阻塞调用包 spawn_blocking**：成片合成（分钟级）、导出转码、视频理解场景检测、工程包导出导入——不再饿死 tokio worker。
- **关键文档原子写**：project.json / episodes/*.json（剧本/分镜/画布/时间线）/ doc_save 全部 tmp+rename，防崩溃半截 JSON。
- **Skill 安装校验修复**：version semver 校验从恒 false 死代码变为真实校验；copy_dir 跳过符号链接（防自引用无限递归）。
- **JobKind 未知值留痕**：不再静默按 Chat 兜底，写 warn 日志。
- **杂项**：concat_list.txt 单引号转义（路径含引号不再断）、ComfyUI /view 查询参数 percent-encode、zip 解压 2GB 上限（zip bomb 防护）。
- **日志轮转**：audit.jsonl >10MB / hermes_log.jsonl >5MB 自动轮转为 .old，不再无限增长。

## [2.11.1] — v2.11.1：预算守卫卡片填充（实时用量看板）

### 改进
- **预算守卫卡片下半空白填充**（用户反馈）：复用隐私卡同款瓷贴风格，加入四块实时数据看板——📊 今日已用 X 次（含每日上限与守卫状态）、💰 项目累计 X 次（含累计上限）、🛒 超限自动拦截说明、🏠 本地任务不计数说明；新增 `costs_get` 命令读取当前项目 costs.json 真实用量，打开设置页自动刷新。卡片尺寸不变，内容随高度铺满。

## [2.11.0] — v2.11.0：体验打磨（窗口记忆 / ⌘K / 无障碍 / 死代码清理）

### 追加
- **窗口状态记忆**：接入 tauri-plugin-window-state——窗口大小/位置/全屏态关闭时自动保存、下次启动恢复（此前每次固定 1440×900 居中）。
- **⌘K 命令面板（Codex 式快速跳转）**：全局 ⌘K（Windows Ctrl+K）呼出，输入过滤页面名，↑↓ 选择 / Enter 跳转 / Esc 关闭。
- **导航键盘可达**：左侧导航项从 div 改为原生 button（Tab 聚焦 + aria-current + focus-visible 轮廓）——纯键盘用户此前完全无法切换模块。
- **浅色模式原生控件修复**：index.html 写死 color-scheme: dark 导致浅色模式下原生滚动条/表单控件仍按深色渲染，改为随主题动态设置。
- Agent 对话输入框占位符注明「Enter 发送 / Shift+Enter 换行」。

### 清理（审查遗留死代码/死依赖）
- 移除未使用的 `@tanstack/react-query` 依赖（全仓零使用）。
- 移除不可达的 PLACEHOLDER_VIEWS / PlaceholderView 占位分支。
- 移除大＋菜单中永久 disabled 的「插件（暂无可用插件）」入口。
- 隐藏无发布源的假「检查更新」按钮（待接入 tauri-plugin-updater 后恢复）。

### 变更
- 版本号升至 2.11.0。巨型组件拆分与 i18n 收敛仍为待办（工程量大，未在本轮）。

## [2.10.0] — v2.10.0：Cost Guard 预算守卫 + 自动 QC（规格 §11/§14 P0）

### 追加
- **💰 Cost Guard 预算守卫**：设置页新增「预算守卫」卡片——按项目限制远程生成（生图/生视频/配音）调用次数（每日上限 + 项目累计上限，默认 100/1000，可关）。执行前检查额度，超限任务以可读文案拦截（不执行、不计费）；任务成功后计数写入项目 `costs.json`（本机）。本地 Mock/ComfyUI/Ollama 不计数，只护钱包不碍本地创作。配置随 settings 实时同步到任务引擎。
- **🔍 自动 QC（§14.1 最小集）**：视频类任务（生视频/合成成片/导出）产出后自动执行 FFmpeg blackdetect（黑帧 ≥0.5s）+ silencedetect（静音 ≥2s @-40dB）+ 时长探测，结果随任务落库（result_json.qc）并写 job_events（qc.report）；任务页标题下显示「🔍 QC 通过」或「⚠️ QC：黑帧 X.Xs · 静音 Y.Ys」徽标。检测纯本地、失败不拦截任务（advisory）。
- 新增 `crates/core/src/qc.rs`（含 stderr 解析单测）；jobs 引擎新增媒体定位器与预算配置同步接口。
- 版本号升至 2.10.0。

### 测试
- 新增：预算拦截端到端单测（预算 0 → 任务失败且处理器不执行）、blackdetect/silencedetect 解析单测、QC 阈值判断单测。

## [2.9.1] — v2.9.1：ComfyUI Wan 工作流实测调优

### 追加
- **Mock ComfyUI 端到端集成测试**（本机无 ComfyUI/Wan 权重、Intel Mac 无法跑视频生成，采用内嵌 HTTP Mock 实测驱动管线）：真实走 ComfyUI 协议全链路——首帧图 multipart 上传 → /prompt 提交（断言：__prompt__/__negative__ 已替换、seed=0 已随机化、__width__/__height__/__frames__ 已变数字、LoadImage 收到上传文件名）→ /history 轮询（running→completed 状态迁移）→ images/gifs 双产物收集 → /view 下载内容校验 → 进度回调触发。CI 可跑（无 GPU 依赖）。
- **数值占位符 patch_workflow_vars**：`__width__` / `__height__` / `__frames__` 由画幅（9:16→480×832、16:9→832×480、1:1→624×624，480p 档）与时长（16fps，帧数=时长×16+1，33~121）自动推导，Wan 工作流无须手填。
- **生成进度上报**：ComfyUI 轮询期间按超时预算上报 job progress（15%~85%），任务页进度条不再恒定。
- **内置 Wan2.1 图生视频示例工作流**：模型页 ComfyUI 模板区「📥 载入 Wan 图生视频示例」一键填入（原生节点 UNETLoader/CLIPLoader/VAELoader/CLIPVisionEncode/WanImageToVideo/KSampler/SaveWEBM；480p fp8 权重名按本机实际下载修改）。
- 版本号升至 2.9.1。

## [2.9.0] — v2.9.0：前端测试体系 + CI（测试抓到并修复 2 个真 Bug）

### 追加
- **前端 vitest 测试（16 项，此前前端 11k 行零测试）**：agentChatStore 全量（多会话 CRUD / localStorage 持久化与 v1 迁移 / 流式增量收尾 / jobId 归档）+ api-story 归一化纯函数（normalizeScript 的 snake/camel 容错）+ normalizeBible + errMsg。`pnpm test`（root 聚合）可跑。
- **GitHub Actions CI**（.github/workflows/ci.yml）：前端 typecheck+vitest、Rust 全 workspace 测试（含 Tauri Linux 系统依赖与 golden pipeline E2E），push/PR 触发。
- vitest 配置显式绑 127.0.0.1（本机 /etc/hosts 的 localhost 映射损坏，历史遗留）。

### 修复（由新测试抓出）
- **appendTo 兜底创建会话用了新随机 id 而非目标 id**：jobId 归档表过期后到达的回复会被写进一条永远匹配不上的会话。
- **api-story.errMsg 不识别 Tauri CommandError 对象**：Agent 对话/任务报错在界面上显示为「[object Object]」——现在正确提取 message（与 LoginView 本地实现对齐）。
- 版本号升至 2.9.0。

## [2.8.0] — v2.8.0：Story Bible 编辑器 + AI 生成（角色一致性上游）

### 追加
- **Story Bible 编辑器**：「项目」页 Bible 卡片新增「✏️ 编辑设定 / AI 生成」——结构化编辑 剧名/题材/时代/地域/主题/平台/视觉风格 + 角色（人设 + 外形 appearance）+ 场景 + 道具 + 连续性规则四张表；保存原子写（tmp+rename）至 `bible/story.json`，与剧本生成的风格注入、分镜角色参考绑定（name → refAssetId）链路完全兼容。
- **AI 一键生成**：填一句话需求 → 单次 LLM 调用（chat 能力，走 Gateway/审计）产出完整圣经 JSON（剥代码围栏容错解析），回填表单可任意修改后保存；画幅/时长/平台等本地设置在生成时保留。
- 后端新增 `bible_get` / `bible_save` / `bible_generate` 三命令（v2.6 审查发现的「bible.generate 已注册无 handler」以独立命令落地）。
- 版本号升至 2.8.0。

## [2.7.2] — v2.7.2：可灵 JWT 签名内置（官方 API 直连打通）

### 追加
- **可灵开放平台鉴权内置**：Gateway 新增 `kling-jwt` 鉴权类型——密钥以「AK:SK」格式存钥匙串，每次请求现场签发 30 分钟有效 JWT（HS256，payload iss/exp/nbf，base64url），走既有 Gateway/审计链路。此前可灵预设因官方强制短期 JWT 而需要自建代理，现已直连（签名纯本地计算，离线单测覆盖结构与签名验证）。
- 可灵预设更新：鉴权类型切换为 kling-jwt，说明改为「AK:SK 拼接填入即用」。
- core 新增 hmac 依赖（JWT 签名用）。
- 版本号升至 2.7.2（v2.7 生产硬能力线第 2 刀）。

## [2.7.1] — v2.7.1：修复 Agent 对话打开白屏 + 会话操作全部静默失效（同一根因）

### 修复
- **⭐ 根因：后端出站 DTO 序列化为 snake_case、前端按 camelCase 读取**。`ProjectInfo.root_path` → 前端 `rootPath` 恒为 undefined → Agent 对话的 `chatKey`（项目 root）为空：
  - v2.6.1-2.6.3 表现为「对话选择器快照不稳定 → 无限重渲染 → **打开即白屏**」（用户报告的问题）；
  - 2.7.1 第一版修掉白屏后，进一步真机验证发现**新建会话/发送消息/清空对话全部静默无效**——所有动作都被 `!chatKey` 守卫拦下。真机 UI 驱动 + node 直测 store 定位到该根因。
  - 一并修复同类的 `FfmpegStatus.ffmpeg_path`（设置页 FFmpeg 路径显示空白）、`RecentDto.last_opened_at`；`AgentChatResult`/`EpisodeDto` 加 rename 对齐（此前前端靠 snake_case 回退兜底）。AppInfo/HermesConfig 此前已有 rename 不受影响。
- **Agent 对话选择器不稳定引用（白屏直接原因）**：zustand v5 选择器 `?? []` 每次返回新数组 → 快照永不相等 → 无限重渲染。改为模块级稳定空数组常量。
- **新增视图级错误边界（ViewErrorBoundary）**：任何视图渲染崩溃时显示可读错误卡（错误信息 + 重试/重新加载）并记录控制台，不再整窗白屏。

### 变更
- 版本号升至 2.7.1。

## [2.7.0] — v2.7.0：ComfyUI 本地链路（FLUX 出图 + Wan 生视频，零 API 成本）

### 追加
- **ComfyUI 通用工作流运行器**：在 ComfyUI 排好工作流 →「Save (API Format)」导出 JSON 粘贴进 Provider 配置，OneTV 自动完成：占位符替换（`__prompt__` / `__negative__`）→ seed/noise_seed=0 自动随机 → 首帧参考图上传（自动填入所有 LoadImage 类节点）→ 提交 `/prompt` → 轮询 `/history` → 收集全部节点产物（images/gifs/videos，兼容 SaveImage / SaveAnimatedWEBP / VHS_VideoCombine）→ `/view` 下载入库。全程本机直连、不出公网。
- **FLUX 出图**：ComfyUI Provider 配置工作流模板后，生图走模板工作流（FLUX/SDXL/任意自定义），未配置保持内置 SD 工作流。
- **Wan2.x 本地生视频**：视频任务新增 ComfyUI 驱动分支——配置工作流模板（Wan 图生视频工作流）即可本地出视频，图生视频的首帧来自分镜参考图（自动上传）。
- **能力校验放宽**：ComfyUI 驱动配置工作流模板后允许勾选「生视频」（保存时校验：无模板勾生视频会被拒绝并给出指引）；前端能力白名单与模型行同步放开。

### 变更
- reqwest 启用 multipart（首帧图上传用）。
- 版本号升至 2.7.0（v2.6 体验线收束，进入 v2.7 生产硬能力线；下一刀：可灵 JWT 签名内置）。

## [2.6.4] — v2.6.4：生成平台预设模板库（图片 + 视频，一键接入）

### 追加
- **平台预设一键填充**（依据用户提供的短剧团队常用平台清单）：「新增 Provider」弹窗新增预设选择器，选平台 → 套用 → 填 API Key → 保存即用，Custom HTTP 模板按各平台 API 结构预排好。
  - 🖼️ **图片**：Nano Banana（Google Gemini，base64 响应自动入库）、Seedream（火山方舟）、FLUX（BFL 官方 API，x-key 头鉴权）、Midjourney（经 midjourney-proxy 自建/第三方服务）。
  - 🎬 **视频**：海螺 H3（MiniMax Hailuo-02）、可灵 Kling（⚠️ 官方要求 AK/SK 签发短期 JWT，模板已排好、待内置签名）、即梦 Seedance（火山方舟）、通义万相 Wan（阿里百炼，异步轮询）、Pika（经 fal.ai 队列）、Runway（Gen-4）。
- **图生视频首帧注入**：视频任务把首帧参考图读为 data URI 注入模板变量 `input.firstFrameBase64`（≤12MB），各预设通过 `${input.firstFrameBase64?}` 可选链自动携带——分镜图 → 视频 → 口型/动作的主流工作流打通。
- **Custom HTTP 结果落盘增强**：`response.result_b64` 映射此前只声明未实现，现已支持（Gemini 式内联 base64 解码保存为 PNG）；预设映射键统一为 serde 实际字段名（job_id/result_url/result_b64），并新增测试守住「键名写错被静默忽略 → 轮询失效」这一类隐患。

### 说明
- 预设是「可用基线」：各平台 API 会演进，套用后可按官方文档微调模板（白名单变量不变）；预设详情内附官方文档直达链接与注意事项。
- Wan2.x / 混元等本地开源权重的 ComfyUI 视频工作流支持在后续版本（当前 ComfyUI 驱动仅生图）。
- 版本号升至 2.6.4（按顺序推进第 5 刀）。

## [2.6.3] — v2.6.3：Agent 会话列表体系 + 会话上下文记忆

### 追加
- **多会话支持（对标 Codex 会话列表）**：Agent 对话页新增左侧会话侧栏——「＋ 新会话」、会话切换、双击重命名、悬停删除（删除当前会话自动落到最近一个会话，全删后自动新建）；每个项目独立维护最多 30 个会话，会话标题自动取首条用户消息（可改）。
- **会话上下文记忆**：发送时自动携带本会话最近 8 轮 user/assistant 文本（`history` 参数），后端 chat 意图将其拼入 LLM 消息上下文（单条截断 2000 字、总量上限 16 条）——同一个会话里追问「再改短一点」能接住上下文了；仅 chat 意图注入，剧本/生图等结构化任务不受历史污染。
- **事件按会话归档**：jobId 归档表升级为 jobId → 项目+会话；流式打字气泡与完整回复都会精确落入发起会话，切会话/切项目期间到达的回复不丢不错位。

### 变更
- 对话持久化格式升级 v2（项目 → 会话列表 + 当前会话指针），v2.6.1 的旧消息自动迁移为每项目一个「默认会话」。
- 版本号升至 2.6.3（按顺序推进第 4 刀；下一刀：视频生成预设模板库）。

## [2.6.2] — v2.6.2：Agent 对话流式输出（打字机效果）

### 追加
- **对话流式输出**：OpenAI 兼容 Provider 的对话回复逐 token 实时渲染——后端 Gateway 新增 `send_json_stream`（策略校验/审计与普通请求完全一致），OpenAI 驱动新增 `chat_stream`（SSE 解析、跨 chunk 行缓冲、`[DONE]` 终止），JobContext 新增 `stream_delta` 回调，以 `agent.message.delta` 事件推送（带 jobId）。
- **打字机气泡**：前端事件桥收 delta 增量渲染「正在输入…」气泡（光标闪烁），完整回复（`agent.message`）到达后自动替换为正式 Markdown 气泡；未支持流式的驱动（Mock/Ollama/CustomHTTP）行为不变，只显示完整回复。
- **quiet 任务不推流**：画布节点面板直发（quiet）的流式增量不进入 Agent 对话流，回复仍由面板轮询消费，避免串流。

### 说明
- 流式仅在对话意图（chat）生效；剧本 JSON 生成等结构化任务仍整体返回（需要完整 JSON 校验，不适合流式）。
- 版本号升至 2.6.2（按顺序推进第 3 刀；下一刀：会话列表体系）。

## [2.6.1] — v2.6.1：Agent 对话持久化 / 停止生成 / Markdown 渲染

### 追加
- **Agent 对话持久化（切视图/重启不丢）**：消息与忙碌态从组件 useState 提升到模块级 store（`agentChatStore.ts`，zustand）——切换视图不再丢失对话与待批准计划卡；消息按项目落 localStorage（每项目上限 400 条，超容量自动截半重试），重启后恢复；「清空对话」按钮同步清理。
- **回复按 jobId 归档（不串项目/不丢回复）**：后端所有 `agent.message` 事件补发 `jobId` 字段（chat/剧本/分镜/合成/导出/视频理解六个发射点）；前端在 App 生命周期注册一次全局事件桥，按 jobId → 发起项目归档，未知 jobId 落当前项目——切换视图甚至切换项目期间到达的回复都会进入正确项目的对话流。
- **停止生成**：发送后 busy 期间显示「⏹ 停止」按钮，取消当前对话创建的任务（job_cancel），并写入系统提示条。
- **助手消息 Markdown 渲染**：接入 react-markdown + remark-gfm——标题/列表/表格/引用/代码块，代码块右上角「复制」按钮，链接新窗打开；每条消息悬停出现「复制原文」；用户/系统消息保持纯文本 pre-wrap。

### 修复
- store.ts 头注释「业务数据走 TanStack Query」与实际不符（仓库无此依赖的任何使用），改为如实描述。

### 变更
- 版本号升至 2.6.1（v2.6 线第 2 刀；按顺序推进：对话体验 → 流式 → 会话列表 → 视频驱动模板库 → Story Bible → 测试/CI）。

## [2.6.0] — v2.6.0：健壮性修复批次（全库审查后第一轮）

### 修复（重要）
- **邮箱验证码功能下线（按用户决策简化）**：修改账户 / 忘记密码不再要求邮箱验证码，仅校验邮箱地址（与 auth.rs 规格注释一致）；SMTP 邮件发送设置与 auth_send_code 命令保留，便于后续恢复。登录页与设置页的验证码输入/发送 UI 同步移除。
- **SMTP 邮箱配置 100% 保存失败的隐藏 Bug**：钥匙串条目 ID 只允许字母数字和 `-_`，而 `mail/<email>` 含 `@ . /` 全部被拒——所有邮箱配置保存必然报「providerId 不合法」。改为 URL-safe Base64 编码邮箱后存储（此前从未保存成功过，无旧数据迁移问题）。
- **任务「取消后仍翻转为成功」**：处理器返回 Ok 时未检查取消标志，用户已取消（远程可能已扣费）的任务会被无条件写成 Succeeded。现在 Ok 分支先检查取消标志，已取消则不采纳结果。
- **任务成功后 Provider/Model 列丢失**：成功落库使用调度时的旧快照，`ON CONFLICT` 会把 set_meta 刚写入的 provider/model 覆盖回空。现在以 DB 最新记录合并后再落库。
- **数据库迁移非原子**：migration 的 DDL 与版本号写入不在事务内，若中途崩溃工程库会因 "duplicate column" 永久打不开。现在每个 migration 在事务内执行，并对修复前的残留库自愈（识别 duplicate column 后补记版本号）。
- **HermesView 事件监听泄漏**：`hermes.inbound` 监听未处理「卸载早于 listen promise resolve」竞态（其余 5 处均已处理），组件提前卸载后监听器永久泄漏并对已卸载组件 setState。补齐 cancelled 标志。
- **邮件文案单位错误**：验证码邮件写「300 分钟内有效」（CODE_TTL_SECS=300 为秒），改按分钟计算输出「5 分钟内有效」。
- **同步命令阻塞主线程（历史同类问题的残余）**：`project_delete`（整工程目录删除，可含数 GB 资产）、`agent_attach_path` / `agent_attach_data`（≤50MB 文件 SHA-256 全量哈希 + 复制）、`ffmpeg_status`（真实执行 `ffmpeg -version` 子进程）全部改为 async + `spawn_blocking`，UI 不再卡死。

### 变更
- 画布工具栏「运行选中」按钮不再弹「Phase 2」占位提示，改为引导双击节点打开生成面板运行（面板链路已实装）；tooltip 同步说明。
- 版本号升至 2.6.0。

## [2.5.0] — v2.5.0：设置页布局整齐化（上下左右全对齐）

### 修复
- **隐私/意识模块行与上下模块不对齐**：撤销 2.4.6 的跨双列弹性容器（其宽度与标准网格列存在细微偏差），回归普通网格自动布局——列宽与上下行完全一致。
- **同行等高**：隐私卡与意识模块卡显式 `align-self: stretch; height: 100%`，行高取较大一方、两卡同时填满——上下左右四边都对齐；隐私瓷贴与记忆列表区随剩余高度自动伸展。
- 交付前已用窗口级截屏自检对齐效果（逐边核对列边界）。

### 追加（2.5 内修复 · 二）
- **画布节点生成面板（LibTV 式节点聊天框）**：双击节点或右键「⚡ 生成 / 对话…」打开——预览区（已有产物直接展示图/视频/音频，未生成时给「尝试」快捷项：图生图/图片高清/图生视频/视频续写/台词配音）＋ 风格 chips（赛博朋克/写实/水墨/动漫/胶片一键插入）＋ ＋参考上传（任意格式入资产库）＋ 提示词输入（⌘+Enter）＋ 底栏模型选择（按节点能力过滤）/画幅/发送；发送即建对应生成任务并轮询进度，成功后自动把产物回填节点（outputAssetId/status ready）并就地预览。图片/视频/音频节点支持直发；面板位置锚定节点。
- **工具栏布局修正（方案一 · 纯图标行）**：小＋改为左下角纯 🔗 图标（无边框，悬停亮蓝，tooltip 说明）；大＋去掉外圈圆圈，改为纯 ＋ 符号（悬停变色、菜单打开时高亮）；两＋之间细分隔线，各自独立互不触发。
- **Agent 对话双＋号职责分离**：小＋「添加参考」= 全格式资料上传（图/视频/音频/文本/文件），严格执行参考规则（自动存入项目资产库供生成引用）；大＋ = **Codex 式功能菜单**——上传任意格式文件、添加链接、@绑定画布节点（读取当前项目全部分集的画布节点，LibTV 风格）、调用技能（读取已安装 Skill 清单）、调用工具（九类生成/合成工具指令模板，选择即插入输入框）、插件入口（占位）。两类条目统一计入 10 个上限、统一 chip 展示与移除；两个＋号完全独立互不触发；菜单支持点外部/Esc 关闭。

### 变更
- 版本号升至 2.5.0（2.4.x 线收束）。

## [2.4.6] — v2.4.6：隐私卡片改用方案 A 数据看板 + 严格等高对称

### 改进
- **隐私卡片改用方案 A「数据看板」**（用户实测方案 B 后仍不对称，改用 A）：四块安全状态瓷贴——遥测 SDK 0 个 / API Key 只进钥匙串 / 项目 100% 本机 / 出站先经策略引擎，随卡片高度自动铺满。
- **隐私 + 意识模块严格等高对称**：两张卡改入显式双列弹性容器（跨双列），行高取两者较大值、两卡同时拉伸填满——无论右侧记忆列表多长，左边永远对称。

### 变更
- 版本号升至 2.4.6。

## [2.4.5] — v2.4.5：隐私卡片数据边界流程图（已被 2.4.6 的方案 A 取代）

## [2.4.4] — v2.4.4：皮肤通栏大图预览

### 改进
- **当前皮肤预览升级为通栏大图**：占满卡片宽度（高 300px），清晰度遮罩与滑杆实时联动，底部悬浮信息条（皮肤名 + 当前清晰度%），效果即主界面所见；外观卡片整体更饱满，与右侧账户卡片视觉平衡。

### 变更
- 版本号升至 2.4.4。

## [2.4.3] — v2.4.3：画布节点全面中文化 / 外观卡片高度修复

### 修复 / 改进
- **画布节点卡片对标即梦/LibTV 风格**：移除节点上的端口文字标签（in/out/prompt/ref… 全部不再显示），连接点改为纯圆点——输入输出类型由节点底层自行判断（配合 v2.4.1 的自由连线，任意素材可互连）；右上角类型标识改中文（text/image/video → 文本/生图/生视频）；参数摘要改中文且不再显示 "∅"（model=∅ · aspectRatio=16:9 → 模型：未设置 · 画幅：16:9；空参数显示"参数未设置"）。技术端口名保留在连接点悬停提示中。
- **外观设置卡片下方大片空白**：双列网格中等高拉伸导致，改为按内容自适应高度。

### 变更
- 版本号升至 2.4.3。

## [2.4.2] — v2.4.2：添加参考可点击区域修复

### 修复
- Agent 对话「＋ 添加参考」文字标签此前是纯展示元素（只有旁边的圆＋按钮可点），点击文字无反应。现在文字与圆＋合并为一个完整可点击按钮，悬停高亮。

### 变更
- 版本号升至 2.4.2。

## [2.4.1] — v2.4.1：画布连线自由化 / 意识模块 Codex 式升级 / 文件对话框修复 / 皮肤预览

### 修复（重要）
- **「＋ 添加参考」点击无反应（真机日志定位）**：所有文件对话框此前使用插件 blocking API 在 async 命令中调用，macOS 上会静默失败（立即返回空 → 前端按"已取消"静默 → 按钮看似失灵；用户日志中两次复现实锤）。全部重写为**回调 API + oneshot 通道**并挂主窗口为父级——添加参考、上传皮肤、导入导出、素材导入等所有对话框入口一次性修复。
- Agent 对话文案统一「附件」→「参考」（占位符、计数、toast、气泡标记、预览标题）。

### 新增 / 改进
- **画布连线自由化**：生成类节点（生图/生视频/片段合成/剧本/分镜/配音/导出）的输入端口全部放宽为「文本+图片+视频+音频」混合类型并集且允许多条入边聚合——多图生视频、多文+多图生视频、多图生图、混合素材生成等全部合法；语义端口名保留，旧画布数据天然兼容；text 节点等严格端口保留 MIME 校验。
- **意识模块（记忆）对标 Codex 式重做**：统计条（总条数/最近更新/仅存本机徽标）+ 内容搜索 + 时间线样式列表（相对时间/圆点/竖线）+ 条目级 编辑（⌘+Enter/Esc、字数统计）/复制/删除 + 多选批量删除 + 导出 Markdown + 从 .txt/.md 导入（空行分段）+ Codex 式常驻输入区（⌘+Enter 保存）+ 设计感空态引导。
- **皮肤清晰度下方新增当前皮肤缩略图预览**：随滑杆实时联动（含清晰度遮罩），不再空白。

### 变更
- 版本号升至 2.4.1（2.3.8~2.4.0 预留未用）。

## [2.3.7] — v2.3.7：UI 重设计 / 模型页调序 / Codex 式对话输入框

### 界面重设计
- **select 选择框全软件统一重设计（方案 A · 双主题自适应玻璃）**：替换 macOS 系统银色原生样式——去系统外观、自绘细 chevron、深蓝黑半透明底（浅色主题自动切换白色玻璃 + 深色字）、hover 边框变亮、聚焦柔光圈。此前"银色按钮看不清字"的问题全软件（生成模型设置/模型选择器/分集选择等所有下拉）一次性解决。
- **模型页调序**：API/Provider 设置置顶，「🎯 生成模型设置」移至页面底部。

### Agent 对话输入框（Codex 式）
- 附件入口内嵌输入框：容器内右侧「＋」按钮（原外置 📎 移除），附件 chip 显示在输入框内部上方；
- 支持**任意格式文件拖入**输入框（拖拽悬停高亮）与**文件粘贴**导入；
- 每个附件支持：查看（应用内预览：文本内容 / 图片显示 / 元信息）、打开（系统默认应用即编辑）、在 Finder 中显示、移除；
- 发送组装、模型选择器、上限（10 个/条）等既有逻辑不变。

### 变更
- 版本号全面升至 2.3.7。

## [2.3.6] — v2.3.6：意识模块 / Hermes 双向桥 / 遥测交互修复

### 新增
- **设置 → 意识模块（记忆）**：按项目存储的记忆条目管理——查看、就地编辑、删除（确认）、新增；数据随工程文件保存在本机（memories 表）。
- **🛰️ Hermes 连接（任务与 Skills 之间新导航页）**：OneTV ↔ Hermes agent 双向桥。
  - 出向：配置 Hermes 地址（仅允许本机/局域网回环）+ Token（钥匙串存储）+ 测试连接 + 发送指令并查看回复；
  - 入向：本机回环监听（默认 8766，默认关闭），Hermes 可 POST /invoke 反向控制 OneTV——动作白名单：status / job_list / job_status / create_image（建生图任务）/ agent_chat（走完整 Agent 链路）/ agent_approve（批准计划）；GET /health 探活；Token 不匹配返回 401；
  - 通信历史：双向日志持久化（hermes_log.jsonl）+ 页面实时展示（hermes.inbound 事件）。
- 隐私卡片「禁用遥测」改为可点击：点击给出明确解释（OneTV 代码中不存在任何遥测 SDK，该选项始终开启），不再出现"点了没反应"的困惑。

### 变更
- 版本号全面升至 2.3.6。

## [2.3.5] — v2.3.5：测试钩子 / 全格式附件 / 右键菜单体系 / 剧本库 / 模型体系

### 新增
- **时间边界测试钩子（SESSION-005~008 解除阻塞）**：测试时钟偏移只影响会话过期判断，不改系统时钟。入口：环境变量 `ONETV_TEST_TIME_OFFSET_SEC`（启动）或设置 → 关于 OneTV → 连点版本号 5 次（运行中）。附边界测试：4天23:59:59 有效 / 5天整有效 / 5天+1秒过期清除。
- **Agent 对话全格式附件**：输入区 📎 按钮上传任意格式文件（图片/视频/音频/文本/文档），自动导入项目资产库；文本类（txt/md/json/srt 等）内容预览进入 LLM 上下文；支持纯附件发送，单条上限 10 个。
- **画布右键菜单**：空白处右键新建 10 种节点（文本/剧本/图片/视频/音频/分镜/视频片段/条件/审核/导出）+ 粘贴 + 适应视图；节点右键复制/粘贴/删除；连线右键删除；内部剪贴板支持多选复制与连线关系克隆。
- **剧本库（多版本）**：剧本页新增版本管理 —— AI 生成/上传剧本（所有文本格式）/新建剧本（粘贴内容）登记为版本；支持使用（切换）/复制副本（同一剧本最多 3 个副本）/删除；版本内嵌 script.json 向后兼容。
- **分镜镜头操作**：镜头卡片编辑/复制/生成副本/删除按钮 + 右键菜单（新建镜头/复制/粘贴/删除/上传分镜图）。
- **模型体系**：① Provider 多模型列表编辑（添加多个模型、逐行能力勾选、读取模型合并去重）；② 「🎯 生成模型设置」：对话·推理/图片/视频/音频四类能力的默认模型（即选即存）；③ Agent 对话、剧本 AI 生成、画布生成节点均可临时选择模型（临时选择优先于默认设置）。
- **删除能力**：工作区最近列表可删除工程（磁盘文件夹一并删除，双重确认文案）/移除记录；项目页分集可删除（分集目录与记录一并移除）。
- 剧本/分镜右键菜单（新建/复制/粘贴/删除/上传）。

### 修复
- 全局右键不再弹出 WKWebView 英文菜单（如 "Reload"）；输入框保留系统中文编辑菜单。
- 画布连线链路排查加固：重复连线去重、端口兼容性校验拒绝并提示、删除节点连带清理悬挂边、边删除同步文档（详见本次排查汇报）。
- 日志 0 字节/时间戳等 v2.3.4 已修项回归通过。

### 变更
- 版本号全面升至 2.3.5。

## [2.3.4] — v2.3.4：黑盒验收全量 BUG 修复（36+8 条）

### P0（核心流程阻断）
- **新建项目 100% 失败**：`project_create` 输入结构体缺 `#[serde(rename_all = "camelCase")]`，前端 camelCase 入参在 serde 反序列化时全部丢失（`missing field 'workspace_path'`）。同根因连带修复「默认画幅未落盘」（aspectRatio 同样被丢弃）。
- **批准执行后零任务产生**：任务幂等去重此前把「已成功」的旧任务也静默复用，重复批准同一计划时不产生任何新任务、无任何提示。现在幂等只拦截「仍在途」任务（排队/运行中），已完成的任务允许重新执行。
- **对话任务"已完成"但回复丢失**：chat 处理器只发实时事件且回写 `outputs=[]`。现在回复文本随任务落库（jobs.result_json + reply 事件），对话流（agent.message）与任务事件双通道可追溯。

### P1
- 登录页密码框假密码点（placeholder `••••••` 误显示为已填）→ 改为「请输入密码」。
- 计划卡批准后按钮不消失/文案自相矛盾 → 批准/拒绝后按钮替换为状态标签；低风险自动执行的计划不再显示批准按钮。
- 合成成片/导出竖版确认弹窗串用批量生图文案 → 三入口各自专属文案。
- 取消导入对话框报「导入失败：[object Object]」→ 全前端统一 `errMsg()` 提取 CommandError.message，取消操作静默。
- 模型配置缺驱动-能力校验 → SD/ComfyUI 驱动保存时校验能力位，不支持「对话」等能力直接拒绝并给出中文说明。
- Local-only 下云端 Provider 未变灰 → 卡片置灰、显示「Local-only 下不可用」标签、禁用启用勾选与测试连接。
- 设置页 FFmpeg「未找到」与「FFmpeg 就绪」矛盾 → FFmpeg/FFprobe 探测覆盖 PATH、/usr/local/bin、/opt/homebrew/bin、/usr/bin 并真实执行 `-version` 验证（GUI 进程无 shell PATH 也能命中）。
- Provider 连接失败直出 reqwest 英文原文/失败显示 0ms → 错误信息中文化，失败不再显示毫秒，显示「已连接/未连接」状态标签。
- 登出无审计记录 → 补 `auth.logout`。
- 忘记密码重置空表单报 `[object Object]` → 前端校验 + errMsg。

### P2
- 空项目名创建无反馈 → 按钮禁用 + toast 提示。
- 重启后不恢复上次项目 → settings 新增 `last_project`，启动时自动恢复（不存在则安全跳过）。
- 任务列表 Provider/模型列恒为 "—" → 处理器执行时回写 providerId/model（chat/script/image/video/tts 全链路），attempts 与结果元数据落库（migration 0002）。
- 任务标题前缀重复（"生成剧本：生成剧本：…"）→ 标题生成去重 + 展示层兜底折叠。
- 任务事件时间线转义 JSON 原文展示 → 解析后格式化。
- 分集表"剧本/分镜/画布"三列恒 "—" → 聚合真实内容（场景数/镜头数含已出图/节点数）。
- 镜头批准后缩略图消失、"已出图"计数反降 → 统计口径改为按 outputAssetId，与批准状态无关。
- 资产类型筛选计数不勾稽（references 资产任何 tab 筛不到）→ 唯一归 tab，计数总和恒等于总数；「文档/参考」tab 命中 references。
- 新建项目对话框初始目录与提示不符 → 初始目录改为 默认项目文件夹 → ~/Documents/OneTV → ~/Documents。
- 导出文件名与对话框不一致 → pkg 归一化 .zip 后缀（所见即所得）。
- 日志文件 42 个中 20 个 0 字节 → 根因：启动创建文件后无任何日志写入即退出。现在初始化幂等且必写 "app started" 行；日志时间戳统一本地时间；默认凭据不再明文入日志。
- 删除 Provider 无二次确认 → 删除前 confirm。
- 内置 Mock Provider 删除后不补种 → 启动按 id 检测补种（不再要求列表为空）。

### P3
- 版本号不一致（UI v2.2.0 / 包 2.3.0）→ UI 全部动态读取（2.3.2 已做）+ 版本统一升至 2.3.4。
- 文案混入开发术语（"Phase X 实现"）→ 全部替换为用户视角描述；副标题「第 1 集 · 第 1 集」去重。
- 任务类型列未本地化 → KIND_META 补全全部 kind 映射。
- themes 目录 0 字节皮肤残留 → 上传校验非空 + 回滚；启动时清理残留。
- 菜单栏设计缺陷 → 新增原生菜单：应用菜单「设置…」(⌘,)、文件（新建项目 ⌘N/打开项目 ⌘O/导出工程包 ⌘E）、帮助「OneTV 使用说明」。
- 皮肤清晰度滑杆失焦丢值 → 补 onBlur 提交。
- FFmpeg 路径提示与预填值误导 → 文案/placeholder 修正。
- 顶栏「任务 0」硬编码不更新（O7）→ 顶栏/底栏实时任务计数与进度（事件驱动 + 轮询兜底）。

### 变更
- 版本号全面升至 2.3.4。

## [2.3.2] — v2.3.2：登录页布局修复 / 皮肤主界面透出 / 版本信息与存储位置

### 新增
- **设置 → 关于 OneTV**：显示当前版本号（动态读取，登录页副标题与主界面底栏同步为真实版本，不再硬编码）；新增「检查更新」按钮，点击后提示「这已经是最新版本」（本地版本阶段无更新服务器，后续接入发布源后返回真实结果）。
- **设置 → 存储位置**：显示应用数据目录与默认项目文件夹，可自定义默认项目文件夹（系统目录选择器）。设置后「工作区 → 创建项目」直接创建到该文件夹，不再每次弹窗选择。

### 修复
- **登录页底部「设置 → 账户安全」提示被「忘记密码？」截断**：提示文字与右侧 nowrap 链接在同一 flex 行竞争空间导致视觉截断。改为提示文字整行换行、「忘记密码？」独立右对齐成行。
- **自定义皮肤只在登录界面显示、主界面不显示**：主界面各表面（顶栏/侧栏/主区/卡片）为不透明背景，把底层皮肤层全部盖住。现在有自定义皮肤时（`body.has-skin`）主界面表面转为半透明让皮肤透出；无皮肤时保持原实色，可读性不受影响；明暗主题各有对应透明度。
- **登录页头像照片与圆框之间留白**：logo 源图自带约 10–13% 透明边距。已裁切透明边并重制 logo.png，配合 `object-fit: cover` 让照片铺满圆形框。
- **外观设置「默认渐变背景」按钮不生效**：原实现往 `settings_update` 传 `skin: undefined`（JSON 序列化时被丢弃，后端也无对应处理）。现改为直接调用 `theme_clear_skin` 清除皮肤。

### 变更
- 版本号全面升至 2.3.2。

## [2.3.0] — v2.3：登录会话保持 / 设置回读修复 / 皮肤显示修复 / 应用图标更换

### 新增
- **登录会话保持**：登录成功后生成会话（session.json 仅存随机 token，不含任何凭据），5 天内启动应用免登录自动进入；连续 5 天未使用、主动退出登录、或修改用户名/密码后需重新登录。附会话生命周期测试（创建/顺延/过期/登出/改密作废）。

### 修复
- **皮肤清晰度滑杆「固定值」（重要）**：后端 `AppSettings` 序列化为 snake_case（`skin_opacity`），前端按 camelCase（`skinOpacity`）读取导致永远取默认值。现 Rust 端统一 `rename_all = "camelCase"`，并保留旧 snake_case 磁盘格式的别名兼容（旧 settings.json 可正常加载，附回归测试）。滑杆拖动 → 松手提交 → 回读显示现已闭环。
- **自定义皮肤不显示（重要）**：CSP `img-src` 未放行 `onetv-app:` 协议，皮肤背景图被安全策略拦截。已加入白名单；同时皮肤应用逻辑在登录状态切换后重新执行（登录会重建 `.skin-layer` 节点）。
- **「打开已有项目」误选普通文件夹提示生硬**：现在检测到所选文件夹缺少 project.json 时，主动询问是否就地新建同名工程，避免「新建/打开」混淆导致创建失败。

### 变更
- 应用图标更换为用户提供的 v2.3 版（顶栏 logo 同步更新）。
- 版本号全面升至 2.3.0。

## [2.2.0] — v2.2：邮箱验证码 / ComfyUI 独立驱动 / Agent 路由与皮肤修复

### 新增
- **邮箱验证码（本机 SMTP 直发）**：设置中修改用户名/密码、登录页忘记密码均支持验证码校验。6 位数字码 5 分钟有效，存哈希不存明文、验证一次即失效、最多 5 次尝试防暴力猜码；SMTP 授权码只进 OS 钥匙串；常见服务商预设（QQ/163/126/Gmail/Outlook）+ 自定义；未配置 SMTP 时降级为仅校验邮箱地址。
- **ComfyUI 独立 Provider 驱动**：与 Stable Diffusion 并列的独立选项（各自连接配置、各自实现），默认 http://127.0.0.1:8188，免鉴权本地直连、Local-only 可用，具备生图能力。
- **Agent 对话视图**：自然语言驱动创作——对话流 + 结构化计划卡 + 远程调用批准/拒绝。

### 修复
- **Agent chat 路由选错驱动（重要）**：chat 能力曾被路由到不支持 chat 的本地生图 Provider。根因是 `provider_save` 往返丢失 `created_at`（空字符串在排序中被当成最早，新加的本地 Provider 抢占默认）。现空 `created_at` 视为最新，新加 Provider 不再抢占既有默认路由。
- **自定义皮肤透明度滑杆回跳**：拖动时每个 tick 直接写盘导致受控回跳，改为拖动只改本地 state、松手才提交。
- **自定义图片皮肤字体发糊**（Intel WKWebView 低分辨率合成问题）。

### 变更
- Stable Diffusion 与 ComfyUI 统一为「本地免鉴权直连」接入方式，但保持完全独立的两个选项。
- 版本号全面升至 2.2.0；测试共 47 项全绿（含黄金管线 E2E）。

## [2.1.0] — v2.1：登录门 / 外观主题 / SD 本地驱动 / 对话框修复

### 修复
- **文件选择器冻结（重要）**：Tauri 同步命令运行在主线程，v2.0 在命令内阻塞等待对话框回调，导致原生文件面板打开后整个应用无响应（无法选择也无法取消）。现所有涉及对话框的命令改为 async，并使用插件的 blocking API 在独立模态循环中运行 —— 面板期间主线程保持响应，可正常选择/取消。

### 新增
- **登录界面**：本地账户门（默认 admin / 12345），启动必须登录；凭据存本机 auth.json（加盐 SHA-256 ×12000 迭代哈希，绝不存明文）；用户名比较大小写不敏感。
- **账户安全**：修改用户名/密码必须已绑定邮箱（或在同一次提交中绑定）；忘记密码凭绑定邮箱重置（本地应用如实实现：仅校验邮箱地址一致，无验证码下发）；默认密码 12345 强制提醒，不可改回默认密码。
- **外观设置**：暗色（默认）/ 浅色一键切换，浅色主题完整配色。
- **主题皮肤**：内置「暗色霓虹」「浅色晨雾」两套主题 + 自定义图片皮肤（上传图片作为全局背景，可调不透明度，类似 Aion UI 的自定义皮肤），图片仅存本机 themes/ 目录，经 onetv-app:// 协议加载（限应用数据目录，防路径穿越）。
- **Stable Diffusion 本地驱动**：接入 AUTOMATIC1111 / Forge WebUI（默认 http://127.0.0.1:7860），支持 txt2img（生成分镜/资产）与 img2img（图生图重绘）、模型列表读取、健康检查；本地不出公网，Local-only 模式可用。

### 变更
- 应用图标更换为 v2.1 圆形版（用户提供的新图）。
- 版本号全面升至 2.1.0。
- 测试新增：账户（默认账户/登录/改凭据/邮箱重置/邮箱校验/明文不落盘）、工程包导入穿越防护等，共 43 项。

## [0.1.0] — 完整实现（Phase 0-10）


### Phase 0 工程基础
- pnpm monorepo：`apps/desktop`（Tauri 2 + React 19 + Vite 7 + TS strict）+ `packages/*` 五个协议包（shared-types / node-sdk / provider-sdk / agent-engine / skill-sdk）。
- Rust cargo workspace：`crates/core|media|security|project`。
- 三栏布局 + 顶栏 + 底部任务栏（规格 §2.1），深色霓虹设计系统；用户提供的赛博朋克图标生成 icon.icns / logo。
- SQLite 17 表 + 迁移框架；.ytv 工程目录（§4.1 全量子目录）。
- macOS 钥匙串命令（值永不回传前端）；FFmpeg/FFprobe 探测与自定义路径。

### Phase 1 项目 / 资产 / 画布
- 工作区：新建/打开 `.ytv`、最近项目（无需账号）。
- 资产库：导入（SHA-256 去重）、类型筛选、onetv-asset:// 本地资源协议（仅服务打开工程内文件，防路径穿越）。
- 画布：React Flow DAG、10 类节点（Node SDK 协议）、端口类型兼容校验（不兼容提示原因）、自动保存（镜像到 SQLite nodes/edges）、撤销/重做、MiniMap。

### Phase 2 Agent 引擎
- L1 Intent Router（关键词规则，可审计离线可用）→ L2 Planner（结构化 Plan JSON，含 jobs/remoteCalls/risk 估算）→ L3 Executor（拓扑执行，本地工具即时、远程入队）→ 工具注册表（权限声明）。
- 人工批准流：远程调用计划必须展示「批准执行 / 拒绝」。

### Phase 3 Provider 体系（v1.1 核心）
- Provider Gateway：**唯一出网组件**，每次请求前 NetworkPolicy 校验 + Egress 审计（脱敏）；错误体回显脱敏。
- 驱动：OpenAI-compatible（chat/models/vision JSON/image/tts）、Ollama（本地）、Mock（离线演示全流程）、Custom HTTP（请求模板 + 响应映射 + 异步轮询，模板变量白名单 input/model/secret.apiKey/jobId）。
- Provider Registry（providers.json，keyRef only）；Model Router（能力路由、本地优先、fallback 链、Local-only 拒绝公网）。
- API Playground（脱敏响应 + 延迟 + Network Preview）；测试连接分层报告。

### Phase 4 剧本 / 分镜
- Script Agent：LLM 生成结构化 ScriptDocument（schema 校验、JSON 围栏容错）；剧本视图场景/台词渲染与表单编辑。
- Shot 拆分（本地启发式：场景交代镜头 + 台词镜头，时长/景别/运镜启发）+ 角色参考绑定（Bible 关联）。
- 分镜网格：批量生图（逐镜 prompt 组装）+ 镜头卡编辑（prompt/景别/时长/台词）+ 批准（§14.2 人工 QC）。

### Phase 5 Job 队列
- 状态机 QUEUED→VALIDATING→(AWAITING_APPROVAL)→SUBMITTING→RUNNING→DOWNLOADING→POST_PROCESSING→SUCCEEDED / FAILED→RETRY_WAIT→QUEUED / CANCELED，全量持久化 SQLite。
- 并发信号量、指数退避（2s/8s/32s，仅可重试错误）、取消、重启恢复（幂等键防重复扣费）、job_events 审计、任务视图（进度/事件时间线/Egress 预览批准）。

### Phase 6 合成 / 导出
- 本地渲染引擎（crates/media/render）：图片→片段（补边缩放）、concat、硬字幕（有 libass）/ 软字幕 mov_text 降级 + SRT 侧车、配音混入。
- 导出预设：抖音竖版 1080×1920 / 小红书 1080×1440 / 横版 1920×1080 / 方形 / 母版。
- 工程包导出/导入（zip：WAL checkpoint、路径穿越防护、schemaVersion 校验、重名自动去重）。

### Phase 7 安全 / 审计
- NetworkPolicy：默认拒绝公网、白名单（Provider 域名）、localhost/私网放行、Local-only 全拦截；mock 不出网。
- 日志/审计/调试输出统一脱敏（Authorization / X-API-Key / Cookie / token / bearer / query key / JSON 递归）。
- 审计日志 JSONL（egress.sent / egress.download / 关键动作）；Skill 安装校验（filesystem 仅 project、network 仅 provider/none，不可自我提权，卸载保留项目数据）。
- CSP：default-src 'self'，img/media 允许 onetv-asset:；无任何遥测路径（telemetry 硬编码 false）。

### Phase 8 视频理解（P1）
- 确定性管线：FFprobe 元数据 → 场景切分（scene 阈值）→ 关键帧抽取 → 结构化 Shot JSON（时间戳/时长/画幅/转场/recreationPrompt/关键帧路径）→ 写入 episodes/<ep>/understanding.json。
- VLM 语义分析预留 Provider 能力位（Vision）。

### Phase 9 Skill Hub / 高级 Provider（P1）
- Skill Hub UI：内置 4 个 Skill（short-drama / storyboard / video-recreation / tvc）自动预置、本地文件夹安装（校验+信任分级）、卸载。
- Custom HTTP 模板编辑器（Provider 表单内）；Fallback 链（Router）；Provider Plugin SDK 为 P1 预留（driver=plugin 占位）。

### Phase 10 打包 / 验收
- `pnpm tauri build` 产出 macOS .app / .dmg（Intel x86_64）。
- 测试：Rust 39 项单元/集成测试 + **黄金管线 E2E**（创建项目→Mock LLM 剧本→镜头拆分→批量分镜图→FFmpeg 合成→资产入库→幂等防重）全绿；前端 tsc strict 零错误。
- 真机冒烟（Intel Mac 实跑）：创建项目 → AI 剧本 → 拆分 → 批量出图 → 合成 21s 1080×1920 MP4 + SRT → 工程包导出。

### 安全红线执行情况
- ✅ API Key 仅存 Keychain；导出包/SQLite/日志不含密钥（有测试）。
- ✅ Agent/前端永远拿不到原始 Key（唯一读取点在 Gateway）。
- ✅ 所有出站经 Gateway + Policy；未授权域名请求失败并留审计。
- ✅ 无遥测、无隐藏回传；CSP 收紧；secret redaction 全覆盖。

### 已知边界
- 视频生成的 OpenAI-compatible 无统一标准：视频生成请用 Custom HTTP 模板或 Mock；图像走 /images/generations。
- 本机 FFmpeg 无 libass 时自动降级软字幕（SRT 侧车始终输出）。
- Webhook 回调、AES 加密工程包、ComfyUI 深度适配为后续 P1/P2。
