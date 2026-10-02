# OneTV 架构

> 规格：《开源短剧 Agent 桌面版 完整开发规格书 v1.1（自定义 API 版）》
> 本文档映射规格 → 实现，并记录有理由的偏差。

## 总体架构（规格 §3.2）

```
┌──────────────────────────── Desktop UI (React/TS) ───────────────────────────┐
│  Views: 工作区/项目/Agent/剧本/分镜/画布/资产/模型/Skills/任务/设置            │
│  状态: zustand(UI态) + TanStack Query(业务) + @onetv/* 协议包                 │
└───────────────────────────────┬──────────────────────────────────────────────┘
                                │ Tauri Commands / Events
┌───────────────────────────────▼──────────────────────────────────────────────┐
│  Rust Core                                                                   │
│  crates/project   .ytv 工程、SQLite、资产 SHA-256 去重                        │
│  crates/security  Keychain、NetworkPolicy、redaction、审计                    │
│  crates/media     FFmpeg/FFprobe（探测/缩略图/合成）                          │
│  crates/core      设置、数据目录、tracing                                     │
│  (Phase 2+) Agent Engine / Job Queue / Provider Gateway 在 crates/core 内扩展 │
└───────────────────────────────┬──────────────────────────────────────────────┘
                                │ 仅 Provider Gateway 可出网
                          Remote API（用户配置的 Provider）
```

## 数据流原则（规格 §3.3）

用户输入 → Intent Router（判断意图）→ Planner（结构化 Plan JSON，不发请求）
→ Policy Engine（权限/预算/离线/白名单）→ Executor（Plan → Job，写本地 Job Log）
→ Provider Adapter（最小数据外发）→ 结果落 Asset Store（记录模型/prompt/hash/时间）
→ Agent 汇总建议，高成本动作需用户批准。

## Provider 体系（规格 §8 / §22）

- 业务层只依赖 Capability（chat / vision / structured_output / image_generation / video_generation / tts / embedding / local_http）。
- 驱动（driver）：`openai-compatible`、`ollama`、`custom-http`（请求模板+响应映射+异步轮询）、`comfyui`、`mock`（离线演示/测试）、`plugin`（P1）。
- API Key 生命周期：前端 → `secure_key_set` → OS Keychain（service=OneTV, user=provider/<id>）。Agent 只拿 Provider handle。
- Model Router：Capability 请求 → 启用 Provider → 健康检查 → 约束过滤 → 成本/优先级 → Adapter。

## 关键偏差（已声明理由）

| 规格 | 实现 | 理由 |
| --- | --- | --- |
| crates 拆分为 core/media/security/project，Agent 引擎可放 TS Worker | Agent/Job/Provider Gateway 全部放 Rust `crates/core` | 网络出站、密钥、任务状态机必须与安全边界同进程同语言；避免 TS↔Rust 双实现漂移；Intel Mac 编译时间减半 |
| `providers/` 目录放 Adapter 实现 | `providers/` 放驱动预设/示例/文档，Adapter 代码在 `crates/core/src/providers` | 同上；目录保留，映射在 providers/README.md 说明 |
| 向量索引 sqlite-vec | Phase 0-1 暂用 memories 表文本存储，embedding 列预留 | P2 能力；避免 C 扩展拖慢 Intel 首编译 |

## 进程内并发模型

- UI ↔ Core：Tauri command（同步小操作）+ Tauri Event（job.progress / agent.message 等，规格 §15.2）。
- Job Queue：tokio 多任务 + 信号量并发上限 + 状态机（规格 §11.1）持久化于 jobs/job_events 表；重启后恢复 RUNNING/QUEUED 任务重新调度（幂等 key 防重复提交）。
- FFmpeg：std::process 子进程，超时与取消经由进程 kill。
