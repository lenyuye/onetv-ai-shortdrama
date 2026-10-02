# Changelog

本文件记录 OneTV 的阶段性交付。每个 Phase 完成：设计文档 → 实现 → 单元测试 → 构建 → 冒烟测试 → 更新本文件。

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
