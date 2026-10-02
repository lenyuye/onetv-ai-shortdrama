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

- **Agent 不是聊天机器人**：Intent Router → Planner（结构化 Plan）→ Policy 检查 → Executor → Reviewer，每一步可审计。
- **画布节点**：Text / Script / Image / Video / Audio / Storyboard / Video-Clip / Review / Export 节点，DAG 编排。
- **Provider 与厂商解耦**：业务层只请求能力（chat / image_generation / video_generation / tts），不锁定任何厂商。内置 OpenAI-compatible、Ollama、自定义 HTTP、ComfyUI、Mock 驱动。
- **本地优先**：项目是 `.ytv` 工程文件夹（JSON + SQLite），可直接拷贝迁移；成片用本机 FFmpeg 合成，不依赖云端。
- **安全边界**：API Key 只进系统钥匙串；网络只去用户配置的 Provider；每次出站前展示 Egress Preview；Local-only 模式可完全断云。

## 快速开始（开发）

要求：Node ≥ 20、pnpm ≥ 9、Rust 1.7x+、FFmpeg/FFprobe（`brew install ffmpeg`）。

```bash
pnpm install
pnpm dev            # 开发模式（Vite + Tauri）
pnpm tauri build    # 产出 .app / .dmg（macOS）
cargo test --workspace   # Rust 单元测试
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
migrations/       # SQLite 迁移
tests/            # fixtures / e2e / security / golden
docs/             # 设计文档
```

## 安全与隐私（硬承诺）

- 默认无遥测：代码中不存在任何分析/上传 SDK，`telemetry` 字段硬编码为 `false`。
- API Key 仅存 macOS Keychain / Windows Credential Manager，不落 SQLite、project.json、日志、导出包。
- Agent 无法读取原始 Key，网络请求只能经 Provider Gateway 并通过 Network Policy 校验。
- 日志自动脱敏 Authorization / X-API-Key / Cookie / token。
- Local-only 模式下策略引擎直接拒绝公网请求（不是从 UI 隐藏）。

详见 [PRIVACY.md](PRIVACY.md) 与 [SECURITY.md](SECURITY.md)。

## License

Apache-2.0。对标 LibTV 公开能力，独立实现，未复制任何私有源码或受限资源。
