# Changelog

本文件记录 OneTV 的阶段性交付。每个 Phase 完成：设计文档 → 实现 → 单元测试 → 构建 → 冒烟测试 → 更新本文件。

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
