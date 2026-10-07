/**
 * ProviderCard —— Provider 卡片（ModelsView 子组件）。
 *
 * 展示：驱动 tag / Base URL（host 展示，完整地址 tooltip）/ 多模型与能力 tag /
 * 启用开关 / 钥匙串 Key 状态 / 测试连接结果 / 「读取模型」结果 / 操作按钮。
 * 纯展示：全部行为经 props 回调上抛，由 ModelsView 主组件编排。
 */
import type { ProviderDto, ProviderTestResult } from "../../api-providers";
import * as api from "../../api-providers";
import { t, useT } from "../../i18n";
import { driverLabel } from "../../hooks/useProviderEditor";

/** Base URL 只展示 host（完整地址放在 tooltip） */
function hostOf(url: string): string {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}

/** 净化连接失败文案：reqwest 原文（如 "error sending request for url (…)"）改为可读中文 */
const cleanTestMessage = (m: string): string =>
  m.replace(/error sending request for url\s*\([^)]*\)/gi, t("无法连接到服务（请确认服务已启动且开启 API）"));

export function ProviderCard({
  p,
  test,
  testBusy,
  reading,
  fetched,
  offlineBlocked,
  onToggle,
  onTest,
  onRead,
  onEdit,
  onDelete,
  onClearKey,
  onCopyModel,
}: {
  p: ProviderDto;
  test?: ProviderTestResult;
  testBusy: boolean;
  reading: boolean;
  fetched: string[];
  offlineBlocked: boolean;
  onToggle: () => void;
  onTest: () => void;
  onRead: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onClearKey: () => void;
  onCopyModel: (modelId: string) => void;
}) {
  const t = useT();
  return (
    <div className={`card pv-card ${p.enabled ? "" : "pv-off"} ${offlineBlocked ? "pv-cloud-off" : ""}`}>
      <div className="pv-head">
        <div className="pv-title">
          <span className="pv-name">{p.name}</span>
          <span className="tag blue">{driverLabel(p.driver)}</span>
          {!p.enabled && <span className="tag">{t("已停用")}</span>}
          {offlineBlocked && <span className="tag amber">{t("Local-only 下不可用")}</span>}
          {test && (test.ok
            ? <span className="tag green">{t("已连接")}</span>
            : <span className="tag red">{t("未连接")}</span>)}
        </div>
        <div className="pv-switch">
          <span className={`pv-key ${p.hasKey ? "on" : ""}`} title={p.hasKey ? t("API Key 已存入系统钥匙串") : t("未配置 API Key")}>
            {p.hasKey ? t("🟢 已配置 Key") : t("⚪ 未配置 Key")}
          </span>
          <label className="checkbox-row" title={t("停用后任务引擎不再调度该 Provider")}>
            <input type="checkbox" checked={p.enabled} onChange={onToggle} disabled={offlineBlocked} />
            {t("启用")}
          </label>
        </div>
      </div>

      <div className="pv-url" title={p.baseUrl}>
        🌐 {hostOf(p.baseUrl)}
        <span className="pv-url-more">{" · "}{t("超时 {n}s · 并发 {c}", { n: Math.round(p.timeoutMs / 1000), c: p.concurrency })}</span>
      </div>

      <div className="pv-models" style={p.models.length > 8 ? { maxHeight: 220, overflowY: "auto" } : undefined}>
        {p.models.length === 0 ? (
          <span className="hint">{t("未配置模型，可「编辑」添加或「读取模型」后手工填入")}</span>
        ) : (
          p.models.map((m, i) => (
            // key 拼上序号：历史数据可能出现重复 modelId，避免 React key 冲突导致渲染缺失
            <div className="pv-model" key={`${m.modelId}-${i}`}>
              <span className="tag mono">{m.modelId}</span>
              {m.displayName && m.displayName !== m.modelId && <span className="pv-disp">{m.displayName}</span>}
              {m.capabilities.map((c) => (
                <span key={c} className="tag pink">{api.capabilityLabel(c)}</span>
              ))}
            </div>
          ))
        )}
      </div>

      {fetched.length > 0 && (
        <div
          className="pv-fetched"
          style={fetched.length > 8 ? { maxHeight: 200, overflowY: "auto" } : undefined}
        >
          <span className="hint">
            {fetched.length > 8
              ? t("远端模型 {n} 个（点击可复制 modelId；列表可滚动，编辑时自动合并进模型列表）：", { n: fetched.length })
              : t("远端模型（点击可复制 modelId；编辑时自动合并进模型列表）：")}
          </span>
          {fetched.map((id) => (
            <span key={id} className="tag blue pv-copy" title={t("点击复制 {id}", { id })} onClick={() => onCopyModel(id)}>
              {id}
            </span>
          ))}
        </div>
      )}

      {test && (
        <div className={`pv-test ${test.ok ? "ok" : "err"}`}>
          {test.ok ? "✅" : "❌"} {cleanTestMessage(test.message)}
          {test.ok
            ? (test.latencyMs != null ? ` · ${test.latencyMs} ms` : "")
            : ` · ${t("连接失败")}`}
        </div>
      )}

      <div className="pv-actions">
        <button
          className="btn sm"
          disabled={testBusy || offlineBlocked}
          title={offlineBlocked ? t("Local-only 模式下云端 Provider 不可测试") : undefined}
          onClick={onTest}
        >
          {testBusy ? t("测试中…") : t("测试连接")}
        </button>
        <button className="btn sm" disabled={reading} onClick={onRead}>{reading ? t("读取中…") : t("读取模型")}</button>
        {p.hasKey && (
          <button className="btn sm danger" onClick={onClearKey} title={t("从钥匙串删除该 Provider 的 API Key")}>
            {t("清除密钥")}
          </button>
        )}
        <span style={{ flex: 1 }} />
        <button className="btn sm" onClick={onEdit}>{t("编辑")}</button>
        <button className="btn sm danger" onClick={onDelete}>{t("删除")}</button>
      </div>
    </div>
  );
}
