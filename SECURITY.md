# Security Policy（安全政策）

## 支持版本

| 版本 | 支持 |
| --- | --- |
| 0.1.x | ✅ |

## 安全模型

威胁模型与对策详见规格书 §9 与 docs/ARCHITECTURE.md。要点：

1. **密钥**：API Key 仅存 OS Secret Store；Agent/Skill/Plugin 均不可读取原始 Key；日志与调试信息自动脱敏（Authorization / X-API-Key / Cookie / token）。
2. **网络**：默认拒绝一切非白名单域名；localhost/私网放行；Local-only 模式连白名单域名也拒绝；mock 驱动不出网。
3. **Skill/Plugin 沙箱**：manifest 声明权限；filesystem 只允许 project；network 只允许 provider 或 none；L3+（shell/任意文件）默认禁止。
4. **审计**：出站记录（EgressRecord）与关键动作写入本地 JSONL 审计日志。

## 报告漏洞

请通过 GitHub Issues（标记 `security`）或项目维护者邮箱报告。本产品为本地应用，
不处理支付/身份数据；影响最大的问题类别是：密钥泄漏、策略绕过、路径穿越、供应链。

## 自动化安全测试

- `crates/security` 单元测试：策略默认拒绝、离线拦截、白名单、脱敏正则。
- `tests/security/`：E2E 级别断言（无隐藏网络调用、导出包无密钥）。
