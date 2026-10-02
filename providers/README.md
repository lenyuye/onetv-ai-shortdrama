# providers/ — Provider 驱动目录

业务层只依赖能力协议（Capability）与模型 Schema，不依赖厂商。
每个子目录包含该驱动的预设、示例与说明；Adapter 实现位于 `crates/core/src/providers`（理由见 docs/ARCHITECTURE.md 偏差表）。

| 目录 | 驱动 | 能力 | 说明 |
| --- | --- | --- | --- |
| openai-compatible | OpenAI 兼容 | chat / vision / structured_output / embedding / image_generation | 中转、聚合、自建网关通用 |
| local-ollama | Ollama | chat / vision / structured_output / embedding | 本机 http://127.0.0.1:11434 |
| local-comfyui | ComfyUI | image_generation / video_generation | 本机工作流（P1） |
| examples | custom-http 模板 | 任意 | 请求模板 + 响应映射 + 异步轮询示例 |

## 添加 Provider 的用户路径

设置 → AI Provider → 新增 → 选择驱动 → 填 Base URL / Key / 模型 → 测试连接 → 保存。
Key 只进系统钥匙串；导出 profile 时仅含 keyRef 不含密钥。
