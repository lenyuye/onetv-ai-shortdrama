# 隐私声明

OneTV 是本地优先的开源短剧 Agent 桌面工作台。本文件说明你的数据去向,与应用内「设置 → 隐私」卡片一致。

## 数据边界

```
创作数据(只存本机) → API 密钥(系统钥匙串) → 策略引擎审计(本地检查) → 云端服务商(你说了算)
```

- **创作数据**:项目(`.ytv` 工程文件夹)、剧本、分镜、时间线、资产、任务记录、会话与记忆,全部只存在你的电脑上,可整文件夹拷贝迁移、可随时删除。
- **API 密钥**:只存 macOS Keychain(Windows 为 Credential Manager),不落 SQLite、project.json、日志、导出包;Agent 与前端永远拿不到原始 Key,唯一读取点在 Provider Gateway。
- **网络出站**:所有请求经 Provider Gateway 与 Network Policy 校验,只去你配置的 Provider;每次出站前展示 Egress Preview;Local-only 模式直接拒绝公网请求(不是从 UI 隐藏)。
- **无遥测**:代码中不存在任何分析/上报 SDK,`telemetry` 字段硬编码为 `false`,遥测设置项始终开启且不可关闭。
- **日志脱敏**:Authorization / X-API-Key / Cookie / token 自动脱敏后落本机日志。

## 本地账户

- 默认账户 admin/12345,密码只存盐+SHA-256 迭代哈希,绝不明文;忘记密码保护、可绑定邮箱(邮箱验证码语义当前下线,仅验证地址)。
- 登录会话保存在本机;卸载应用或删除应用数据目录即全部清除。

## 入向监听(默认关闭)

- Hermes 桥与 Webhook 监听默认关闭;开启后仅绑定本机回环地址,token 未配置或校验失败一律拒绝,全程写审计日志。

## 账号数据之外

OneTV 不含账号系统、不连接任何统计服务、不申请任何云存储权限。你对 `<项目根>/` 与 `~/Library/Application Support/OneTV/` 的删除即是对数据的删除。

安全漏洞请见 [SECURITY.md](SECURITY.md)。
