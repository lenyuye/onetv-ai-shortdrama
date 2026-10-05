/**
 * PlaygroundBlock —— API Playground（规格 §22.9，ModelsView 子组件）。
 *
 * 选 Provider + 模型 + 测试 Prompt → Network Preview（按驱动推导端点、密钥行
 * 永不展示原始 Key）→ 发送测试（请求经 Rust 网关审计，响应自动脱敏截断）。
 * 纯展示：状态与请求编排留在 ModelsView 主组件，经 props 回调上抛。
 */
import type { ProviderDto } from "../../api-providers";
import type { PlaygroundResult } from "../../api-providers";
import { t, useT } from "../../i18n";
import { driverLabel } from "../../hooks/useProviderEditor";

/** Playground 按驱动推导请求端点（Network Preview 展示用） */
function playgroundEndpoint(p: ProviderDto): string {
  const base = p.baseUrl.replace(/\/+$/, "");
  switch (p.driver) {
    case "openai-compatible":
      return `POST ${base}/chat/completions`;
    case "ollama":
      return `POST ${base}/api/chat`;
    case "mock":
      return t("mock://local（本地模拟，不出网）");
    case "custom-http":
      return p.httpTemplate ? t("按 HTTP 模板定义的 method/url 发送") : `POST ${base}`;
    default:
      return p.baseUrl;
  }
}

/** Playground 密钥行（永不展示原始 Key） */
function keyLine(p: ProviderDto): string {
  if (p.hasKey) {
    if (p.authType === "api-key") return t("X-API-Key: ••••••••（隐藏）");
    if (p.authType === "custom-header") return t("自定义 Header: ••••••••（隐藏）");
    return t("Authorization: Bearer ••••••••（隐藏）");
  }
  return p.authType === "none" ? t("无（本地 / 模拟服务）") : t("未配置 API Key");
}

export function PlaygroundBlock({
  providers,
  pgProv,
  pgProvider,
  pgModel,
  pgPrompt,
  pgBusy,
  pgResult,
  onChangeProvider,
  onChangeModel,
  onChangePrompt,
  onSend,
}: {
  providers: ProviderDto[];
  pgProv: ProviderDto | null;
  pgProvider: string;
  pgModel: string;
  pgPrompt: string;
  pgBusy: boolean;
  pgResult: PlaygroundResult | null;
  onChangeProvider: (id: string) => void;
  onChangeModel: (id: string) => void;
  onChangePrompt: (text: string) => void;
  onSend: () => void;
}) {
  const t = useT();
  return (
    <div className="card pg-card">
      <h3>{t("🧪 API Playground")}</h3>
      <div className="hint" style={{ marginBottom: 10 }}>
        {t("手动向单个 Provider 发起一次测试调用；请求经 Rust 网关审计，响应自动脱敏截断")}
      </div>
      <div className="pg-row">
        <select value={pgProvider} onChange={(e) => onChangeProvider(e.target.value)}>
          <option value="">{t("选择 Provider…")}</option>
          {providers.filter((p) => p.enabled).map((p) => (
            <option key={p.id} value={p.id}>{p.name}（{driverLabel(p.driver)}）</option>
          ))}
        </select>
        <select value={pgModel} onChange={(e) => onChangeModel(e.target.value)} disabled={!pgProv}>
          <option value="">{pgProv ? t("选择模型…") : t("先选择 Provider")}</option>
          {(pgProv?.models ?? []).map((m) => (
            <option key={m.modelId} value={m.modelId}>{m.modelId}</option>
          ))}
        </select>
      </div>
      <div className="field">
        <label>{t("测试 Prompt")}</label>
        <textarea
          value={pgPrompt}
          placeholder={t("输入测试文本，例如：用一句话介绍赛博朋克风格")}
          onChange={(e) => onChangePrompt(e.target.value)}
        />
      </div>
      {pgProv && (
        <div className="pg-preview">
          <div className="pg-line"><span className="k">Network</span><span className="mono">{playgroundEndpoint(pgProv)}</span></div>
          <div className="pg-line"><span className="k">{t("数据")}</span>{t("文本（Prompt 将原样发往该端点）")}</div>
          <div className="pg-line"><span className="k">{t("密钥")}</span>{keyLine(pgProv)}</div>
        </div>
      )}
      <div className="pg-actions">
        <button
          className="btn blue"
          disabled={pgBusy || !pgProv || !pgModel || !pgPrompt.trim()}
          onClick={onSend}
        >
          {pgBusy ? t("请求中…") : t("发送测试")}
        </button>
      </div>
      {pgResult && (
        <div className={`pg-out ${pgResult.ok ? "ok" : "err"}`}>
          <div className="pg-out-head">
            {pgResult.ok ? t("✅ 请求成功") : t("❌ 请求失败")} · {t("延迟 {n} ms · 响应已脱敏", { n: pgResult.latencyMs })}
          </div>
          <pre>{pgResult.response}</pre>
        </div>
      )}
    </div>
  );
}
