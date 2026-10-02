# 贡献指南

## 开发流程

1. Fork → 分支（`feat/xxx` / `fix/xxx`）。
2. 每个 Phase / Epic 一个 PR；遵循规格书 §18.2 的 Issue 模板（目标/输入/输出/必须通过/禁止/验收）。
3. 提交前：

```bash
pnpm typecheck && pnpm build
cargo test --workspace
cargo clippy --workspace -- -D warnings
```

## 硬性红线（违反即拒收）

- 不得新增任何遥测、匿名埋点、后台同步、崩溃上传。
- 不得把 API Key / Authorization header 写入日志、SQLite、project.json、导出包。
- 不得绕过 NetworkPolicy 发起网络请求；新增出站必须走 Provider Gateway 并有测试。
- 不得为“跑通 demo”硬编码任何厂商私有 API；新 Provider 必须实现统一 Adapter 接口 + mock 测试。
- schema 变更必须带 schemaVersion 与 migration。

## 代码风格

- Rust：标准 fmt + clippy 干净；错误用 thiserror；公共 API 写 doc 注释。
- TS：strict 模式零错误；领域类型放 `@onetv/shared-types`，UI 不直接 `invoke`（走 `src/api.ts`）。
- UI 文案：简体中文优先。
