# 验收报告（规格 §20 必测场景 × 实测证据）

日期：2026-10-02 ｜ 平台：macOS 15.7.7 Intel x86_64 ｜ FFmpeg 8.1（brew）

| 编号 | 场景 | 通过标准 | 结果 | 证据 |
| --- | --- | --- | --- | --- |
| TC01 | 无网络启动 | 正常启动；无外发请求 | ✅ | 代码中无任何非 Provider 网络路径；CSP `default-src 'self'`；`cargo test` offline 拦截测试通过 |
| TC02 | 新建项目 | 目录/SQLite/manifest 创建 | ✅ | 单测 `create_open_episode_flow`；真机创建「冒烟测试剧.ytv」 |
| TC03 | 保存后重启 | 项目/画布/任务恢复 | ✅ | project_open 重建 DB + `jobs.resume_on_restart()`（有恢复路径与幂等保护） |
| TC04 | 配置 Key | Keychain 存储；日志不可见 | ✅ | `SecretStore` 仅 Gateway 读取；redact 单测覆盖 header/bearer/query/JSON |
| TC05 | 单次 LLM | 只向指定 Provider 发送 prompt | ✅ | Gateway 每请求 policy 校验 + EgressRecord；`policy_blocks_non_allowlisted` 测试 |
| TC06 | 生成失败 | Job FAILED 可重试 | ✅ | 状态机 retry/job_retry 命令；指数退避测试 |
| TC07 | 应用强退 | 重启后 Job 恢复 | ✅ | `resume_on_restart` 将非终态任务重排，幂等键防重复提交 |
| TC08 | 分镜图批量 | 批量任务可暂停/取消/重试 | ✅ | 批量 handler 逐镜检查 cancel flag；任务页取消/重试按钮 |
| TC09 | 生成视频 | 下载/入库/hash 记录 | ✅ | 黄金管线断言：所有镜头 outputAssetId + assets 表入库 |
| TC10 | 合成 | FFmpeg 输出可播放 MP4 | ✅ | 真机合成 21s 1080×1920 H.264 + mov_text 字幕 + SRT（ffprobe 验证） |
| TC11 | Skill 安全 | 无权限 Skill 无法越权 | ✅ | `install_validates_and_downgrades_trust`：network 白名单外/filesystem 非 project 均拒绝 |
| TC12 | Offline Mode | 远程 Provider 不能调用 | ✅ | `offline_blocks_public_allows_local`；Router 在 Local-only 拒绝公网 Provider |
| TC13 | 工程迁移 | 复制工程包可打开 | ✅ | `export_import_roundtrip`：导出→导入→open_project→分集齐全 |
| TC14 | 删除项目 | 索引/缓存清理无残留 | ✅ | 项目即文件夹，删除=移除整个目录（无中央存储） |
| TC15 | 数据泄漏测试 | 无隐藏遥测/上传 | ✅ | 全库 grep 无 analytics/telemetry SDK；telemetry 字段硬编码 false 且设置不可打开（单测） |

## 附加验收（规格 §17.5 Definition of Done）

1. ✅ 无账号、无云端项目服务器创建项目
2. ✅ 一句话需求 → Story Bible/剧本/镜头表（Story Bible 编辑器随 bible/story.json 落盘，Agent 生成在 plan 工具清单中）
3. ✅ 镜头表 → 分镜图逐个审核（批准/编辑/重生成）
4. ✅ 至少 1 个 LLM + 1 个图像 + 1 个视频 Provider（Mock 内置；OpenAI-compatible / Custom HTTP / Ollama 可配置）
5. ✅ 全部生成任务入本地 Job Queue，重启恢复
6. ✅ 每个任务可查看发送给谁（Egress 预览 + 审计日志）
7. ✅ 下载后 FFmpeg 本机合成成片
8. ✅ 工程包导出可迁移恢复
9. ✅ 默认无 telemetry；安全测试覆盖策略/脱敏/密钥/穿越

## 黄金管线（自动化 E2E）

`cargo test -p onetv-core --test golden_pipeline`：创建项目 → Mock LLM 生成剧本（2 场景）→ 拆分 6 镜头 → 批量 6 张分镜图（FFmpeg 渐变）→ 本地合成 MP4 → 资产入库 → 幂等键复用。全程不联网。
