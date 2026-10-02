# Privacy Policy（隐私说明）

OneTV 是本地优先的桌面应用。本页以工程事实（而非承诺）说明数据流向。

## OneTV 自己不收集任何数据

- 无账号系统、无中央服务器、无用户资料库。
- 代码中不存在遥测/埋点/崩溃上传 SDK；`settings.json` 的 `telemetry` 恒为 `false` 且无法通过界面打开。
- 项目（剧本、人物、分镜、素材、生成历史）只保存在你选择的本地文件夹（`.ytv` 工程目录）。
- API Key 只写入操作系统钥匙串（macOS Keychain / Windows Credential Manager），不写入项目文件、SQLite、日志或导出包。

## 什么时候数据会离开你的电脑

只有一种情况：**你调用了云端模型 Provider**（如某个 OpenAI 兼容 API、图像/视频生成服务）。
此时，该任务所需的输入（prompt、参考图/视频等）会发送给你自己配置的服务商地址。

- 每次出站前，OneTV 展示 **Egress Preview**（发给谁、哪个模型、哪些资产、哪些文本、预计调用数）。
- 出站记录写入本地审计日志（`Application Support/OneTV/audit/audit.jsonl`），密钥字段自动脱敏。
- OneTV 不转发、不代理、不缓存你的云端请求到任何第三方。
- Local-only 模式开启后，公网请求在策略引擎层直接失败，只剩本机服务（Ollama / ComfyUI / 局域网自建）可用。

## 你可以随时

- 导出整个工程包（JSON + SQLite + 素材），在另一台机器恢复；
- 删除项目 = 删除工程文件夹，无后台残留；
- 导出/查看完整审计日志。

## 第三方服务商

云端 Provider 的数据留存政策由其服务条款决定。OneTV 在 Provider 设置页展示其 Base URL，
不伪称“零留存”。请自行查阅所接入服务商的隐私政策。
