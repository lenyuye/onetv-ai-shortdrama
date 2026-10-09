<div align="center">

# OneTV

**本地优先的开源短剧 Agent 桌面工作台**

像视频剪辑软件一样可视化 · 像 Agent 一样会自己拆任务 · 像制片系统一样管理人物/场景/分镜 · 数据控制权在你手里

`macOS Intel / Apple Silicon` · `Windows x64` · `Tauri 2 + React + Rust + SQLite + FFmpeg`

</div>

---

## 这是什么

OneTV 是一款开源桌面应用，用于 AI 短剧的完整生产流程：

**一句话需求 → Story Bible → 剧本 → 镜头表 → 分镜图 → 生成视频 → 本地合成 → 多版本导出**

- **Agent 不是聊天机器人**：Intent Router → Planner（结构化 Plan）→ Policy 检查 → Executor → Reviewer（启发式复核），每一步可审计、高风险需人工批准。
- **画布节点**：Text / Script / Image / Video / Audio / Storyboard / Video-Clip / Review / Condition / Export 节点，DAG 编排；支持全图拓扑批量运行、节点禁用/锁定、节点级生成面板。
- **多轨时间线**：视频/音频/字幕三轨编辑器（拖拽、修剪、音量、淡入淡出转场），规格 §12.2 数据结构，FFmpeg 本地多轨渲染（混音/黑场补隙/字幕烧录降级）。
- **Provider 与厂商解耦**：业务层只请求能力（chat / image_generation / video_generation / tts / vision），不锁定任何厂商。内置 OpenAI-compatible、Ollama、Stable Diffusion、ComfyUI（FLUX/Wan 工作流）、自定义 HTTP 模板、Mock 驱动；内置短剧常用平台预设（可灵 JWT / 海螺 / Seedance / 万相 / Pika / Runway / Nano Banana / Seedream / FLUX / MJ）一键填充。
- **多版本导出**：抖音竖版 / 小红书竖版 / 横版 / 方形 / 母版按预设批量导出，烧录字幕与 SRT 侧车可选，产物自动入库。
- **成本与质量守卫**：Cost Guard 按次/按金额双维预算拦截；自动 QC（黑帧/静音/音轨检测）任务级徽标。
- **i18n**：界面语言中文/English 一键切换（约 1100 键字典层，缺译回退中文）。
- **本地优先**：项目是 `.ytv` 工程文件夹（JSON + SQLite），可直接拷贝迁移；成片用本机 FFmpeg 合成，不依赖云端。
- **安全边界**：API Key 只进系统钥匙串；网络只去用户配置的 Provider；每次出站前展示 Egress Preview；Local-only 模式可完全断云；入向 Webhook/Hermes 带 token 鉴权。
- **体验**：⌘K 命令面板、多会话对话（流式输出/附件/会话持久化）、意识模块（记忆语义检索）、Story Bible 编辑器、窗口状态记忆、视图级错误边界。

## 快速开始（开发）

要求：Node ≥ 22、pnpm ≥ 11、Rust 1.7x+、FFmpeg/FFprobe（`brew install ffmpeg`）。

```bash
pnpm install
pnpm dev            # 开发模式（Vite + Tauri）
pnpm tauri build    # 产出 .app / .dmg（macOS）
cargo test --workspace          # Rust 单元/集成测试（含黄金管线 E2E）
pnpm --filter onetv-desktop test  # 前端 vitest
python3 scripts/smoke/onetv_smoke.py  # 真机 UI 冒烟（macOS，见 scripts/smoke/README.md）
```

## 仓库结构

```
apps/desktop      # Tauri 2 + React 桌面端
crates/core       # Rust 核心：设置、日志、目录
crates/media      # FFmpeg / FFprobe 封装（探测、缩略图、合成）
crates/security   # Keychain、网络出站策略、日志脱敏、审计
crates/project    # .ytv 工程文件、SQLite schema、资产去重
packages/*        # TS 共享类型 / Node SDK / Provider SDK / Agent 协议 / Skill SDK
providers/        # Provider 预设与示例（openai-compatible / ollama / comfyui / custom-http）
skills/           # 内置 Skill 包（短剧 / 分镜 / 视频复刻 / TVC）
tests/            # 预留目录（fixtures / e2e / security / golden 子目录当前为空）
docs/             # 设计文档
```

## 测试

- Rust 侧：各 crate 内 `#[cfg(test)]` 单元测试 + `crates/core/tests/golden_pipeline.rs` 集成测试（建项目→Mock 剧本→拆分→出图→时间线合成→入库→幂等，`cargo test -p onetv-core -p onetv-project -p onetv-media -p onetv-security`，当前 104 项）。
- 前端：`apps/desktop/src/**/*.test.ts`（vitest，30 项，含 i18n 字典完整性守护）。
- 真机 UI 冒烟：`scripts/smoke/onetv_smoke.py`（Quartz 遍历 13 视图截图 + 基础健康断言）。
- CI：`.github/workflows/ci.yml`（typecheck + vitest + cargo test 核心 crates + release.yml 三平台 tauri 构建）。

## 安全与隐私（硬承诺）

- 默认无遥测：代码中不存在任何分析/上传 SDK，`telemetry` 字段硬编码为 `false`。
- API Key 仅存 macOS Keychain / Windows Credential Manager，不落 SQLite、project.json、日志、导出包。
- Agent 无法读取原始 Key，网络请求只能经 Provider Gateway 并通过 Network Policy 校验。
- 日志自动脱敏 Authorization / X-API-Key / Cookie / token。
- Local-only 模式下策略引擎直接拒绝公网请求（不是从 UI 隐藏）。

详见 [PRIVACY.md](PRIVACY.md) 与 [SECURITY.md](SECURITY.md)。

## License

本项目以 [**GNU AGPL-3.0**](LICENSE)（GNU Affero 通用公共许可证 v3.0）开源发布。

- 本许可适用于本项目的**全部版本**（历史版本、当前版本与未来版本），不因版本更替而变化。
- 任何对本项目的复制、修改、衍生作品或基于它的网络服务，分发时必须以 AGPL-3.0 相同许可开放完整源代码并保留版权声明。
- 对标 LibTV 公开能力，独立实现，未复制任何私有源码或受限资源。
