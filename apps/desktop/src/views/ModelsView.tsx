/**
 * 模型视图 —— Provider 管理 / 生成模型设置 / API Playground（规格 §22.1 / §22.9）。
 *
 * 本文件是组合根：providers 列表状态、保存/删除编排、能力校验（saveEditor 内
 * sanitizeCaps）与各卡片装配在此；展示子组件在 components/models/，表单草稿
 * 状态与行级编辑动作在 hooks/useProviderEditor。
 *
 * - 🎯 生成模型设置卡片（ModelDefaultsCard）：settings.modelDefaults，即选即存；
 *   选「自动路由」即清除该 key（IPC 传 null，undefined 会被 JSON 序列化丢弃）
 * - Provider 卡片（ProviderCard）：驱动 / Base URL（host 展示）/ 多模型与能力 tag /
 *   启用开关 / 钥匙串 Key 状态 / 测试连接 / 读取模型 / 编辑 / 删除
 * - 新增 / 编辑 modal（ProviderEditorModal）：驱动下拉切换自动填默认 Base URL；
 *   API Key 只写系统钥匙串（secure_key_set）；模型区域为多模型列表编辑；
 *   custom-http 的 httpTemplate JSON 模板（白名单变量 ${input.*} / ${model.id} /
 *   ${secret.apiKey} / ${jobId}）与 comfyui 的工作流 JSON（Wan2.1 图生视频示例）
 * - API Playground（PlaygroundBlock）：选 Provider + 模型 + prompt → Network
 *   Preview → 发送测试（响应经 Rust 端脱敏）
 *
 * 复用 global.css 设计系统，布局细节用本组件内 scoped <style> 补充（无法修改 global.css）。
 */
import { useCallback, useEffect, useState } from "react";
import type {
  ModelDefaultCapability,
  ModelDefaults,
  ModelRef,
  ProviderDriver,
} from "@onetv/shared-types";
import type { ProviderDto, ProviderTestResult } from "../api-providers";
import * as api from "../api-providers";
import * as extrasApi from "../api-extras";
import { ModelDefaultsCard } from "../components/models/ModelDefaultsCard";
import { PlaygroundBlock } from "../components/models/PlaygroundBlock";
import { ProviderCard } from "../components/models/ProviderCard";
import { ProviderEditorModal } from "../components/models/ProviderEditorModal";
import { useT } from "../i18n";
import {
  authTypeOf,
  draftFrom,
  errMsg,
  mergeFetchedModels,
  newDraft,
  sanitizeCaps,
  useProviderEditor,
} from "../hooks/useProviderEditor";
import { useApp } from "../store";

/** 本地驱动 / 本机地址的 Provider（Local-only 下仍然可用） */
const LOCAL_DRIVERS: readonly ProviderDriver[] = ["mock", "ollama", "comfyui", "stable-diffusion"];
const isLocalProvider = (p: ProviderDto): boolean =>
  LOCAL_DRIVERS.includes(p.driver) ||
  /^(https?:\/\/)?(127\.0\.0\.1|localhost|\[::1\]|::1|192\.168\.|10\.|172\.)/i.test(p.baseUrl);

/* ---------------- 主视图 ---------------- */

export default function ModelsView() {
  const { toast, settings, patchSettings } = useApp();
  const t = useT();
  const offlineMode = !!settings?.offlineMode;

  const [providers, setProviders] = useState<ProviderDto[]>([]);
  const [loading, setLoading] = useState(true);

  const [saving, setSaving] = useState(false);

  const [testResults, setTestResults] = useState<Record<string, ProviderTestResult>>({});
  const [testBusy, setTestBusy] = useState<Record<string, boolean>>({});

  const [mdBusy, setMdBusy] = useState(false);

  // Playground
  const [pgProvider, setPgProvider] = useState("");
  const [pgModel, setPgModel] = useState("");
  const [pgPrompt, setPgPrompt] = useState("");
  const [pgBusy, setPgBusy] = useState(false);
  const [pgResult, setPgResult] = useState<api.PlaygroundResult | null>(null);

  // 表单草稿（状态与行级编辑动作在 useProviderEditor）
  const {
    editor,
    setEditor,
    patchDraft,
    changeDriver,
    toggleCap,
    patchModel,
    addModelRow,
    removeModelRow,
  fetchModelsIntoEditor,
    editorReading,
    presets,
    presetSel,
    setPresetSel,
    applyPreset,
  } = useProviderEditor();

  const refresh = useCallback(async () => {
    try {
      const list = await api.providerList();
      setProviders(list);
    } catch (e) {
      console.error("providerList", e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  /* ---------- 🎯 生成模型设置（即选即存） ---------- */

  const saveModelDefault = async (cap: ModelDefaultCapability, ref: ModelRef | null) => {
    setMdBusy(true);
    try {
      // 带上既有 key 原样回传（后端只更新提供的 key）；清除某能力 = 该 key 传 null
      //（undefined 会被 JSON 序列化丢弃，后端收不到该 key，无法删除）
      const md: ModelDefaults = { ...(settings?.modelDefaults ?? {}) };
      md[cap] = ref;
      await patchSettings({ modelDefaults: md });
      const short = api.MODEL_DEFAULT_ROWS.find((r) => r.key === cap)?.short ?? cap;
      toast(ref ? t("已保存默认{short}模型", { short }) : t("已清除默认{short}模型，恢复自动路由", { short }), "ok");
    } catch (e) {
      toast(t("保存失败：{msg}", { msg: errMsg(e) }), "err");
    } finally {
      setMdBusy(false);
    }
  };

  /* ---------- 卡片操作 ---------- */

  const toggleEnabled = async (p: ProviderDto) => {
    try {
      await api.providerSave({
        id: p.id,
        name: p.name,
        driver: p.driver,
        baseUrl: p.baseUrl,
        models: p.models,
        timeoutMs: p.timeoutMs,
        concurrency: p.concurrency,
        enabled: !p.enabled,
        httpTemplate: p.httpTemplate ?? null,
        workflowTemplate: p.workflowTemplate ?? null,
        authType: p.authType,
      });
      await refresh();
      toast(p.enabled ? t("已停用 {name}", { name: p.name }) : t("已启用 {name}", { name: p.name }), "ok");
    } catch (e) {
      toast(t("操作失败：{msg}", { msg: errMsg(e) }), "err");
    }
  };

  const doTest = async (p: ProviderDto) => {
    setTestBusy((b) => ({ ...b, [p.id]: true }));
    try {
      const r = await api.providerTest(p.id);
      setTestResults((prev) => ({ ...prev, [p.id]: r }));
    } catch (e) {
      setTestResults((prev) => ({ ...prev, [p.id]: { ok: false, message: errMsg(e) } }));
    } finally {
      setTestBusy((b) => ({ ...b, [p.id]: false }));
    }
  };


  const doDelete = async (p: ProviderDto) => {
    if (!window.confirm(t("确定删除 Provider「{name}」吗？该操作不可恢复。", { name: p.name }))) return;
    try {
      await api.providerDelete(p.id);
      await refresh();
      toast(t("已删除"), "ok");
    } catch (e) {
      toast(t("删除失败：{msg}", { msg: errMsg(e) }), "err");
    }
  };

  const doClearKey = async (p: ProviderDto) => {
    if (!window.confirm(t("从系统钥匙串删除「{name}」的 API Key？", { name: p.name }))) return;
    try {
      await api.secureKeyDelete(p.id);
      await refresh();
      toast(t("密钥已从钥匙串删除"), "ok");
    } catch (e) {
      toast(t("删除密钥失败：{msg}", { msg: errMsg(e) }), "err");
    }
  };


  // Provider 配置导入导出（v2.13）
  const [importing, setImporting] = useState(false);
  const doExport = async () => {
    setImporting(true);
    try {
      const r = await extrasApi.providerExport();
      toast(t("已导出 {n} 个 Provider 配置：{path}", { n: r.count, path: r.path }), "ok");
    } catch (e) {
      if (!String(e).includes("已取消")) toast(t("导出失败：{msg}", { msg: errMsg(e) }), "err");
    } finally {
      setImporting(false);
    }
  };
  const doImport = async () => {
    setImporting(true);
    try {
      const r = await extrasApi.providerImport();
      toast(t("已导入 {n} 个 Provider（请重新填写 API Key）", { n: r.imported }), "ok");
      await refresh();
    } catch (e) {
      if (!String(e).includes("已取消")) toast(t("导入失败：{msg}", { msg: errMsg(e) }), "err");
    } finally {
      setImporting(false);
    }
  };

  const saveEditor = async () => {
    const d = editor;
    if (!d) return;
    if (!d.name.trim()) return toast(t("请填写 Provider 名称"), "warn");
    if (!d.baseUrl.trim()) return toast(t("请填写 Base URL"), "warn");
    // 过滤空行 + 按 modelId 去重（保留首个），避免「后者覆盖前者」的重复项进入后端
    const seen = new Set<string>();
    let droppedDup = 0;
    const models = d.models.filter((m) => {
      const id = m.modelId.trim();
      if (!id) return false;
      if (seen.has(id)) {
        droppedDup += 1;
        return false;
      }
      seen.add(id);
      return true;
    });
    if (models.length === 0) return toast(t("至少添加一个模型（填写 modelId）"), "warn");
    if (droppedDup > 0) toast(t("已忽略 {n} 个重复 modelId 的模型行", { n: droppedDup }), "warn");
    if (d.driver === "custom-http" && d.httpTemplateText.trim()) {
      try {
        JSON.parse(d.httpTemplateText);
      } catch {
        return toast(t("HTTP 模板不是合法 JSON"), "err");
      }
    }

    let httpTemplate: unknown = null;
    let workflowTemplate: unknown = null;
    if (d.driver === "custom-http" && d.httpTemplateText.trim()) {
      httpTemplate = JSON.parse(d.httpTemplateText);
    }
    if (d.driver === "comfyui" && d.workflowTemplateText.trim()) {
      try {
        workflowTemplate = JSON.parse(d.workflowTemplateText);
      } catch {
        return toast(t("ComfyUI 工作流模板不是合法 JSON"), "err");
      }
    }

    setSaving(true);
    try {
      const saved = await api.providerSave({
        id: d.id ?? undefined,
        name: d.name.trim(),
        driver: d.driver,
        baseUrl: d.baseUrl.trim(),
        models: models.map((m) => ({
          modelId: m.modelId.trim(),
          displayName: m.displayName.trim() || m.modelId.trim(),
          capabilities: sanitizeCaps(m.capabilities, d.driver),
          pricing: m.pricePerCall && m.pricePerCall > 0 ? { perCall: m.pricePerCall } : null,
        })),
        timeoutMs: Math.max(1_000, d.timeoutMs || 180_000),
        concurrency: Math.max(1, d.concurrency || 1),
        enabled: d.enabled,
        httpTemplate,
        workflowTemplate,
        authType: authTypeOf(d.driver),
      });
      const key = d.apiKey.trim();
      if (key) {
        await api.secureKeySet(saved.id, key);
        toast(t("API Key 已写入系统钥匙串"), "ok");
      }
      toast(d.id ? t("Provider 已更新") : t("Provider 已新增"), "ok");
      setEditor(null);
      await refresh();
    } catch (e) {
      toast(t("保存失败：{msg}", { msg: errMsg(e) }), "err");
    } finally {
      setSaving(false);
    }
  };

  /* ---------- Playground ---------- */

  const pgProv = providers.find((p) => p.id === pgProvider) ?? null;

  const changePgProvider = (id: string) => {
    setPgProvider(id);
    setPgModel("");
    setPgResult(null);
  };

  const sendTest = async () => {
    if (!pgProv || !pgModel || !pgPrompt.trim()) return;
    setPgBusy(true);
    setPgResult(null);
    try {
      const r = await api.playgroundTest(pgProv.id, pgModel, pgPrompt);
      setPgResult(r);
    } catch (e) {
      toast(t("测试失败：{msg}", { msg: errMsg(e) }), "err");
    } finally {
      setPgBusy(false);
    }
  };

  /* ---------- 渲染 ---------- */

  return (
    <div className="page">
      <style>{MODELS_CSS}</style>

      <div className="page-header">
        <div>
          <h1>{t("🧠 模型 / Provider 管理")}</h1>
          <div className="desc">
            {t("共 {a} 个 Provider · 已启用 {b} 个 · API Key 只存系统钥匙串", { a: providers.length, b: providers.filter((p) => p.enabled).length })}
          </div>
        </div>
        <button className="btn" disabled={importing} title={t("导出全部 Provider 配置为 JSON（不含 API Key，导入后需重新填写）")} onClick={() => void doExport()}>{t("📤 导出配置")}</button>
        <button className="btn" disabled={importing} title={t("从 JSON 导入 Provider 配置（不含密钥，导入后需重新填写 Key）")} onClick={() => void doImport()}>{t("📥 导入配置")}</button>
        <button className="btn primary" onClick={() => setEditor(newDraft())}>{t("+ 新增 Provider")}</button>
      </div>

      {loading ? (
        <div className="page hint">{t("加载中…")}</div>
      ) : providers.length === 0 ? (
        <div className="empty-state" style={{ padding: "60px 20px" }}>
          <div className="big">🧠</div>
          <h2>{t("还没有配置 Provider")}</h2>
          <p>{t("添加一个 OpenAI 兼容服务、本机 Ollama 或离线 Mock，开始使用 AI 能力")}</p>
          <button className="btn primary" onClick={() => setEditor(newDraft())}>{t("+ 新增 Provider")}</button>
        </div>
      ) : (
        <div className="pv-grid">
          {providers.map((p) => (
            <ProviderCard
              key={p.id}
              p={p}
              test={testResults[p.id]}
              testBusy={!!testBusy[p.id]}
              offlineBlocked={offlineMode && !isLocalProvider(p)}
              onToggle={() => void toggleEnabled(p)}
              onTest={() => void doTest(p)}
              onEdit={() => setEditor(draftFrom(p))}
              onDelete={() => void doDelete(p)}
              onClearKey={() => void doClearKey(p)}
            />
          ))}
        </div>
      )}

      {/* 🎯 生成模型设置（v2.3.7 调序：API/Provider 设置置顶，本卡片置底；即选即存，选「自动路由」= 清除该能力默认） */}
      <ModelDefaultsCard
        providers={providers}
        defaults={settings?.modelDefaults}
        busy={mdBusy}
        onChange={(cap, ref) => void saveModelDefault(cap, ref)}
      />

      {/* API Playground（规格 §22.9） */}
      <PlaygroundBlock
        providers={providers}
        pgProv={pgProv}
        pgProvider={pgProvider}
        pgModel={pgModel}
        pgPrompt={pgPrompt}
        pgBusy={pgBusy}
        pgResult={pgResult}
        onChangeProvider={changePgProvider}
        onChangeModel={setPgModel}
        onChangePrompt={setPgPrompt}
        onSend={() => void sendTest()}
      />

      {/* 底部安全提示 */}
      <div className="card pv-security">
        <h3>{t("🔐 安全说明")}</h3>
        <ul>
          <li>{t("API Key 只存系统钥匙串（Keychain），不落 SQLite / 项目文件 / 日志；")}</li>
          <li>{t("网络请求只允许发往 Provider 配置的域名（保存时自动加入白名单），其余出站一律拒绝；")}</li>
          <li>{t("Local-only 模式将拒绝所有公网 Provider，仅本机 Ollama / ComfyUI 可用。")}</li>
        </ul>
      </div>

      {/* 新增 / 编辑 Provider modal */}
      {editor && (
        <ProviderEditorModal
          editor={editor}
          presets={presets}
          presetSel={presetSel}
          setPresetSel={setPresetSel}
          applyPreset={applyPreset}
          patchDraft={patchDraft}
          changeDriver={changeDriver}
          toggleCap={toggleCap}
          patchModel={patchModel}
          addModelRow={addModelRow}
          removeModelRow={removeModelRow}
          fetchModelsIntoEditor={fetchModelsIntoEditor}
          editorReading={editorReading}
          saving={saving}
          onClose={() => setEditor(null)}
          onSave={() => void saveEditor()}
        />
      )}
    </div>
  );
}

/* ---------------- 视图局部样式（补充 global.css，深色一致） ---------------- */

const MODELS_CSS = `
.pv-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(360px, 1fr)); gap: 12px; margin-bottom: 14px; }
.pv-card { display: flex; flex-direction: column; gap: 8px; }
.pv-card.pv-off { opacity: 0.6; }
.pv-card.pv-cloud-off { opacity: 0.5; }
.pv-card.pv-cloud-off .pv-name { color: var(--muted); }
.pv-card.pv-cloud-off .pv-url,
.pv-card.pv-cloud-off .pv-models { pointer-events: none; }
.pv-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 8px; flex-wrap: wrap; }
.pv-title { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; min-width: 0; }
.pv-name { font-weight: 600; font-size: 13px; color: var(--text); }
.pv-switch { display: flex; align-items: center; gap: 10px; }
.pv-key { font-size: 11px; color: var(--muted); white-space: nowrap; }
.pv-key.on { color: var(--green); }
.pv-url { font-family: var(--mono); font-size: 11px; color: var(--text-dim); word-break: break-all; }
.pv-url-more { color: var(--muted); }
.pv-models { display: flex; flex-direction: column; gap: 4px; }
.pv-model { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.pv-disp { font-size: 11.5px; color: var(--text); }
.tag.mono { font-family: var(--mono); font-size: 10.5px; }
.pv-fetched {
  display: flex; flex-wrap: wrap; gap: 6px; align-items: center;
  background: var(--bg-deep); border: 1px dashed var(--border-strong);
  border-radius: var(--radius-sm); padding: 6px 8px;
}
.pv-copy { cursor: pointer; }
.pv-copy:hover { border-color: var(--cyan); color: var(--cyan); }
.pv-test { font-size: 11.5px; padding: 5px 8px; border-radius: var(--radius-sm); }
.pv-test.ok { color: var(--green); background: rgba(53, 208, 127, 0.08); }
.pv-test.err { color: var(--red); background: rgba(255, 84, 112, 0.08); word-break: break-all; }
.pv-actions { display: flex; gap: 6px; margin-top: auto; flex-wrap: wrap; padding-top: 4px; }
.pg-card { margin-bottom: 14px; }
.pg-row { display: flex; gap: 8px; margin-bottom: 10px; }
.pg-row select { flex: 1; }
.pg-preview {
  background: var(--bg-deep); border: 1px solid var(--border);
  border-radius: var(--radius-sm); padding: 8px 10px; margin-bottom: 10px;
  display: flex; flex-direction: column; gap: 4px;
}
.pg-line { font-size: 11.5px; color: var(--text-dim); display: flex; gap: 8px; }
.pg-line .k { color: var(--muted); min-width: 60px; flex-shrink: 0; }
.pg-line .mono { font-family: var(--mono); word-break: break-all; }
.pg-actions { margin-bottom: 10px; }
.pg-out { border: 1px solid var(--border-strong); border-radius: var(--radius-sm); overflow: hidden; }
.pg-out-head { padding: 6px 10px; font-size: 11.5px; border-bottom: 1px solid var(--border); color: var(--text-dim); }
.pg-out.ok .pg-out-head { color: var(--green); }
.pg-out.err .pg-out-head { color: var(--red); }
.pg-out pre {
  margin: 0; padding: 10px; font-family: var(--mono); font-size: 11.5px;
  color: var(--text-dim); white-space: pre-wrap; word-break: break-all;
  max-height: 220px; overflow: auto; user-select: text;
}
.pv-security { margin-bottom: 14px; }
.pv-security ul { margin-left: 18px; display: flex; flex-direction: column; gap: 3px; color: var(--text-dim); font-size: 12px; }
.mv-2col { display: flex; gap: 12px; }
.mv-2col .field { flex: 1; }
.mv-model-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-wrap: wrap; }
.mv-model-row {
  border: 1px solid var(--border); border-radius: var(--radius-sm);
  padding: 8px 10px; margin-bottom: 8px; background: var(--bg-deep);
}
.mv-model-grid { display: flex; gap: 8px; margin-bottom: 6px; }
.mv-model-grid input { flex: 1; min-width: 0; }
.mv-cap-checks { display: flex; flex-wrap: wrap; align-items: center; gap: 4px 14px; }
.mv-cap-check {
  display: flex; align-items: center; gap: 5px; cursor: pointer;
  font-size: 11.5px; color: var(--text-dim); user-select: none;
}
.mv-cap-check:hover { color: var(--text); }
.mv-cap-check input { accent-color: var(--cyan); cursor: pointer; }
.mv-cap-check.off { opacity: 0.38; cursor: not-allowed; }
.mv-cap-check.off input { cursor: not-allowed; }
.mv-extra-caps { display: flex; flex-wrap: wrap; gap: 4px; }
/* 🎯 生成模型设置卡片 */
.md-card { margin-bottom: 14px; }
.md-rows { display: flex; flex-direction: column; gap: 8px; }
.md-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.md-row > label { min-width: 96px; font-size: 12.5px; color: var(--text); flex-shrink: 0; }
.md-row > select { flex: 1; min-width: 220px; }
.md-stale { font-size: 11px; color: var(--amber, #ffb454); }
`;
