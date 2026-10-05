/**
 * 模型视图 —— Provider 管理 / 生成模型设置 / API Playground（规格 §22.1 / §22.9）。
 *
 * - 🎯 生成模型设置卡片：对话/图片/视频/配音四个能力的默认模型（settings.modelDefaults），
 *   即选即存；选「自动路由」即清除该 key（IPC 传 null，undefined 会被 JSON 序列化丢弃）
 * - Provider 卡片：驱动 / Base URL（host 展示）/ 多模型与能力 tag / 启用开关 /
 *   钥匙串 Key 状态 / 测试连接 / 读取模型 / 编辑 / 删除
 * - 新增 / 编辑 modal：驱动下拉（PROVIDER_DRIVERS，切换自动填默认 Base URL），
 *   API Key 只写系统钥匙串（secure_key_set），模型区域为**多模型列表编辑**
 *   （每行 modelId + 显示名 + 能力多选 checkbox + 删除；「读取模型」结果按 modelId
 *   去重合并进列表而非覆盖）；SD / ComfyUI 驱动仅允许勾选生图（后端拒绝非法组合）；
 *   custom-http 驱动额外提供 httpTemplate JSON 模板（白名单变量 ${input.*} / ${model.id} / ${secret.apiKey} / ${jobId}）
 * - API Playground：选 Provider + 模型 + prompt → Network Preview → 发送测试（响应经 Rust 端脱敏）
 *
 * 复用 global.css 设计系统，布局细节用本组件内 scoped <style> 补充（无法修改 global.css）。
 */
import { useCallback, useEffect, useState } from "react";
import { PROVIDER_DRIVERS } from "@onetv/provider-sdk";
import type {
  Capability,
  ModelDefaultCapability,
  ModelDefaults,
  ModelRef,
  ProviderDriver,
} from "@onetv/shared-types";
import * as api from "../api-providers";
import * as extrasApi from "../api-extras";
import type { ProviderDto, ProviderTestResult } from "../api-providers";
import { useApp } from "../store";
import { t, useT } from "../i18n";

/* ---------------- 表单草稿类型 ---------------- */

interface ModelRow {
  modelId: string;
  displayName: string;
  capabilities: Capability[];
  /** 单价（元/次），v2.14 金额化预算守卫 */
  pricePerCall?: number | null;
}

interface EditorDraft {
  id: string | null; // null = 新增
  name: string;
  driver: ProviderDriver;
  baseUrl: string;
  apiKey: string; // 仅提交时使用，不回显
  timeoutMs: number;
  concurrency: number;
  enabled: boolean;
  models: ModelRow[];
  httpTemplateText: string; // custom-http 的 JSON 模板
  workflowTemplateText: string; // comfyui 的 API 格式工作流 JSON（FLUX/Wan）
}

const driverInfo = (d: ProviderDriver) => PROVIDER_DRIVERS.find((x) => x.driver === d);
const driverLabel = (d: ProviderDriver) => driverInfo(d)?.label ?? d;

/** auth.type 由驱动推导：本地/模拟服务无密钥，其余走 Bearer */
// 本地驱动（Ollama/ComfyUI/Stable Diffusion/Mock）一律免鉴权直连
const authTypeOf = (d: ProviderDriver): string =>
  d === "ollama" || d === "mock" || d === "comfyui" || d === "stable-diffusion" ? "none" : "bearer";

/** Wan2.1 图生视频示例工作流（ComfyUI API 格式，原生节点）。
 *  权重文件名按本机 ComfyUI models 目录实际下载的为准；
 *  __prompt__/__negative__ 为提示词占位，seed=0 每次随机，
 *  __width__/__height__/__frames__ 由画幅与时长自动推导。 */
const WAN_I2V_EXAMPLE = {
  "1": { class_type: "UNETLoader", inputs: { unet_name: "wan2.1_i2v_b_480p_fp8_e4m3fn.safetensors" } },
  "2": { class_type: "CLIPLoader", inputs: { clip_name: "umt5_xxl_fp8_e4m3fn_scaled.safetensors", type: "wan" } },
  "3": { class_type: "VAELoader", inputs: { vae_name: "wan_2.1_vae.safetensors" } },
  "4": { class_type: "CLIPVisionLoader", inputs: { clip_name: "clip_vision_h.safetensors" } },
  "5": { class_type: "CLIPVisionEncode", inputs: { clip_vision: ["4", 0], image: ["12", 0], crop: "center" } },
  "6": { class_type: "CLIPTextEncode", inputs: { text: "__prompt__", clip: ["2", 0] } },
  "7": { class_type: "CLIPTextEncode", inputs: { text: "__negative__", clip: ["2", 0] } },
  "8": { class_type: "LoadImage", inputs: { image: "__IMAGE__" } },
  "9": { class_type: "WanImageToVideo", inputs: { positive: ["6", 0], negative: ["7", 0], vae: ["3", 0], width: "__width__", height: "__height__", length: "__frames__", batch_size: 1, clip_vision_output: ["5", 0], start_image: ["8", 0] } },
  "10": { class_type: "KSampler", inputs: { seed: 0, steps: 25, cfg: 6.0, sampler_name: "uni_pc", scheduler: "simple", denoise: 1.0, model: ["1", 0], positive: ["9", 0], negative: ["9", 1], latent_image: ["9", 2] } },
  "11": { class_type: "VAEDecode", inputs: { samples: ["10", 0], vae: ["3", 0] } },
  "12": { class_type: "SaveWEBM", inputs: { images: ["11", 0], filename_prefix: "onetv_wan", codec: "vp9", fps: 16, quality: 85 } },
};

function newDraft(): EditorDraft {
  return {
    id: null,
    name: "",
    driver: "openai-compatible",
    baseUrl: driverInfo("openai-compatible")?.defaultBaseUrl ?? "",
    apiKey: "",
    timeoutMs: driverInfo("openai-compatible")?.defaultTimeoutMs ?? 180_000,
    concurrency: 2,
    enabled: true,
    models: [{ modelId: "", displayName: "", capabilities: ["chat"] }],
    httpTemplateText: "",
    workflowTemplateText: "",
  };
}

function draftFrom(p: ProviderDto, fetched: string[] = []): EditorDraft {
  const rows: ModelRow[] = p.models.length
    ? p.models.map((m) => ({
        modelId: m.modelId,
        displayName: m.displayName,
        capabilities: [...m.capabilities],
        pricePerCall: m.pricing?.perCall ?? null,
      }))
    : [];
  // 「读取模型」拉取过的远端模型自动合并进列表（按 modelId 去重），而非要求用户逐个手工复制
  return {
    id: p.id,
    name: p.name,
    driver: p.driver,
    baseUrl: p.baseUrl,
    apiKey: "",
    timeoutMs: p.timeoutMs,
    concurrency: p.concurrency,
    enabled: p.enabled,
    models: mergeFetchedModels(rows, fetched, p.driver).rows,
    httpTemplateText: p.httpTemplate ? JSON.stringify(p.httpTemplate, null, 2) : "",
    workflowTemplateText: p.workflowTemplate ? JSON.stringify(p.workflowTemplate, null, 2) : "",
  };
}

/** 新合并行的默认能力：SD / ComfyUI 只能生图，其余默认对话 */
function defaultCapsForDriver(d: ProviderDriver): Capability[] {
  return api.driverAllowedCaps(d) ? ["image_generation"] : ["chat"];
}

/** 按驱动约束净化能力（SD / ComfyUI 仅生图；全被过滤掉时回退为白名单首个能力） */
function sanitizeCaps(caps: Capability[], driver: ProviderDriver): Capability[] {
  const allowed = api.driverAllowedCaps(driver);
  if (!allowed) return caps;
  const kept = caps.filter((c) => allowed.includes(c));
  return kept.length ? kept : [...allowed];
}

/** 远端模型列表合并进模型行（按 modelId 去重，不覆盖既有行） */
function mergeFetchedModels(rows: ModelRow[], ids: string[], driver: ProviderDriver): { rows: ModelRow[]; added: number } {
  const seen = new Set(rows.map((r) => r.modelId.trim()).filter(Boolean));
  const add: ModelRow[] = [];
  for (const raw of ids) {
    const id = raw.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    add.push({ modelId: id, displayName: id, capabilities: defaultCapsForDriver(driver) });
  }
  return { rows: [...rows, ...add], added: add.length };
}

/** Base URL 只展示 host（完整地址放在 tooltip） */
function hostOf(url: string): string {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}

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

/** HTTP 模板提示（UI 文案，渲染期经 i18n；注意：${jobId} 等为模板变量原文，非 t() 占位符） */
const httpTemplateHint = () =>
  t("模板变量白名单：${input.*}、${model.id}、${secret.apiKey}、${jobId}；禁止任意脚本执行。") +
  t('示例：{"method":"POST","url":"https://api.example.com/v1/generate","headers":{"Authorization":"Bearer ${secret.apiKey}"},"body":{"prompt":"${input.prompt}","jobId":"${jobId}"}}');

/** Tauri 命令 Err 时前端拿到 {message} 对象，统一提取可读文案 */
const errMsg = (e: unknown): string => {
  if (typeof e === "string") return e;
  if (e && typeof e === "object" && "message" in e) return String((e as { message: unknown }).message);
  try { return JSON.stringify(e); } catch { return String(e); }
};

/** 净化连接失败文案：reqwest 原文（如 "error sending request for url (…)"）改为可读中文 */
const cleanTestMessage = (m: string): string =>
  m.replace(/error sending request for url\s*\([^)]*\)/gi, t("无法连接到服务（请确认服务已启动且开启 API）"));

/** 本地驱动 / 本机地址的 Provider（Local-only 下仍然可用） */
const LOCAL_DRIVERS: readonly ProviderDriver[] = ["mock", "ollama", "comfyui", "stable-diffusion"];
const isLocalProvider = (p: ProviderDto): boolean =>
  LOCAL_DRIVERS.includes(p.driver) ||
  /^(https?:\/\/)?(127\.0\.0\.1|localhost|192\.168\.|10\.|172\.)/i.test(p.baseUrl);

/* ---------------- Provider 卡片 ---------------- */

function ProviderCard({
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

      <div className="pv-models">
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
        <div className="pv-fetched">
          <span className="hint">{t("远端模型（编辑时自动合并进模型列表；点击可复制 modelId）：")}</span>
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

/* ---------------- 🎯 生成模型设置卡片（settings.modelDefaults，规格 §22.1） ---------------- */

function providerNameOf(id: string, providers: ProviderDto[]): string {
  return providers.find((p) => p.id === id)?.name ?? id;
}

function ModelDefaultsCard({
  providers,
  defaults,
  busy,
  onChange,
}: {
  providers: ProviderDto[];
  defaults: ModelDefaults | undefined;
  busy: boolean;
  onChange: (cap: ModelDefaultCapability, ref: ModelRef | null) => void;
}) {
  const t = useT();
  return (
    <div className="card md-card">
      <h3>{t("🎯 生成模型设置")}</h3>
      <div className="hint" style={{ marginBottom: 10 }}>
        {t("用于所有生成入口的默认模型；在对话/剧本/画布中也可临时选择其他模型，临时选择优先于这里")}
      </div>
      <div className="md-rows">
        {api.MODEL_DEFAULT_ROWS.map((row) => {
          const cap = api.MODEL_DEFAULT_CAP[row.key];
          const cur = defaults?.[row.key] ?? null;
          const curVal = cur ? api.modelOptionValue(cur) : "";
          // 选项 = 所有已启用 Provider 中具备该能力的模型，按 Provider 分组
          const usable = providers.filter(
            (p) => p.enabled && p.models.some((m) => m.capabilities.includes(cap)),
          );
          const curUsable =
            !!cur &&
            usable.some(
              (p) =>
                p.id === cur.providerId &&
                p.models.some((m) => m.modelId === cur.modelId && m.capabilities.includes(cap)),
            );
          return (
            <div className="md-row" key={row.key}>
              <label>{row.label}</label>
              <select
                value={curVal}
                disabled={busy}
                onChange={(e) => onChange(row.key, api.parseModelOptionValue(e.target.value))}
              >
                <option value="">{t("自动路由（默认）")}</option>
                {usable.map((p) => (
                  <optgroup key={p.id} label={p.name}>
                    {p.models
                      .filter((m) => m.capabilities.includes(cap))
                      .map((m, i) => (
                        <option
                          key={`${m.modelId}-${i}`}
                          value={api.modelOptionValue({ providerId: p.id, modelId: m.modelId })}
                        >
                          {p.name} · {m.modelId}
                        </option>
                      ))}
                  </optgroup>
                ))}
                {cur && !curUsable && <option value={curVal}>{t("{name} · {model}（当前不可用）", { name: providerNameOf(cur.providerId, providers), model: cur.modelId })}</option>}
              </select>
              {cur && !curUsable && (
                <span className="md-stale">{t("⚠️ 所选模型已停用/删除，任务将回退自动路由")}</span>
              )}
            </div>
          );
        })}
      </div>
      {providers.filter((p) => p.enabled).length === 0 && (
        <div className="hint" style={{ marginTop: 8 }}>
          {t("暂无已启用的 Provider —— 先在下方添加 / 启用，再回到这里选择默认模型")}
        </div>
      )}
    </div>
  );
}

/* ---------------- 主视图 ---------------- */

export default function ModelsView() {
  const { toast, settings, patchSettings } = useApp();
  const t = useT();
  const offlineMode = !!settings?.offlineMode;

  const [providers, setProviders] = useState<ProviderDto[]>([]);
  const [loading, setLoading] = useState(true);

  const [editor, setEditor] = useState<EditorDraft | null>(null);
  const [saving, setSaving] = useState(false);
  const [editorReading, setEditorReading] = useState(false);

  const [testResults, setTestResults] = useState<Record<string, ProviderTestResult>>({});
  const [testBusy, setTestBusy] = useState<Record<string, boolean>>({});
  const [reading, setReading] = useState<Record<string, boolean>>({});
  const [fetchedModels, setFetchedModels] = useState<Record<string, string[]>>({});

  const [mdBusy, setMdBusy] = useState(false);

  // Playground
  const [pgProvider, setPgProvider] = useState("");
  const [pgModel, setPgModel] = useState("");
  const [pgPrompt, setPgPrompt] = useState("");
  const [pgBusy, setPgBusy] = useState(false);
  const [pgResult, setPgResult] = useState<api.PlaygroundResult | null>(null);

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
      setTestResults((t) => ({ ...t, [p.id]: r }));
    } catch (e) {
      setTestResults((t) => ({ ...t, [p.id]: { ok: false, message: errMsg(e) } }));
    } finally {
      setTestBusy((b) => ({ ...b, [p.id]: false }));
    }
  };

  const doReadModels = async (p: ProviderDto) => {
    setReading((r) => ({ ...r, [p.id]: true }));
    try {
      const r = await api.providerModels(p.id);
      if (r.ok) {
        setFetchedModels((f) => ({ ...f, [p.id]: r.models }));
        toast(t("读取到 {n} 个模型；编辑该 Provider 时会自动合并进模型列表（按 modelId 去重）", { n: r.models.length }), "ok");
      } else {
        toast(t("读取模型失败：{msg}", { msg: r.message ?? t("未知错误") }), "err");
      }
    } catch (e) {
      toast(t("读取模型失败：{msg}", { msg: errMsg(e) }), "err");
    } finally {
      setReading((r) => ({ ...r, [p.id]: false }));
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

  const copyModelId = async (modelId: string) => {
    try {
      await navigator.clipboard.writeText(modelId);
      toast(t("modelId 已复制，可粘贴到编辑表单"), "ok");
    } catch (e) {
      toast(t("复制失败：{msg}", { msg: errMsg(e) }), "err");
    }
  };

  /* ---------- 表单编辑 ---------- */

  const patchDraft = (patch: Partial<EditorDraft>) =>
    setDraftSafe((d) => (d ? { ...d, ...patch } : d));

  // 包一层：draft 为 null 时安全忽略
  const setDraftSafe = (fn: (d: EditorDraft) => EditorDraft) =>
    setEditor((d) => (d ? fn(d) : d));

  /* ---------- 生成平台预设（v2.6.4） ---------- */
  const [presets, setPresets] = useState<api.GenPresetDto[]>([]);
  const [presetSel, setPresetSel] = useState("");
  useEffect(() => {
    if (!editor || presets.length > 0) return;
    api.providerPresetList().then(setPresets).catch(() => {});
  }, [editor, presets.length]);
  const applyPreset = (id: string) => {
    const p = presets.find((x) => x.id === id);
    if (!p || !editor) return;
    let origin = "";
    try {
      origin = new URL((p.template as { url?: string }).url ?? "").origin;
    } catch {
      origin = "";
    }
    setEditor({
      ...editor,
      id: null,
      name: editor.name.trim() || p.name,
      driver: "custom-http",
      baseUrl: origin,
      timeoutMs: 600_000,
      models: [
        {
          modelId: p.defaultModelId,
          displayName: p.defaultModelName,
          capabilities: [p.category === "image" ? "image_generation" : "video_generation"],
        },
      ],
      httpTemplateText: JSON.stringify(p.template, null, 2),
    });
    toast(t("已套用预设「{name}」：填好 API Key 即可保存（模板可按平台最新文档微调）", { name: p.name }), "ok");
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

  const changeDriver = (driver: ProviderDriver) => {
    const info = driverInfo(driver);
    setDraftSafe((d) => ({
      ...d,
      driver,
      baseUrl: info?.defaultBaseUrl ?? d.baseUrl,
      timeoutMs: info?.defaultTimeoutMs ?? d.timeoutMs,
      // 驱动-能力约束：SD / ComfyUI 仅允许生图（后端会拒绝非法组合，切换时同步净化已勾选项）
      models: d.models.map((m) => ({ ...m, capabilities: sanitizeCaps(m.capabilities, driver) })),
    }));
  };

  const toggleCap = (idx: number, c: Capability) =>
    setDraftSafe((d) => ({
      ...d,
      models: d.models.map((m, i) =>
        i === idx
          ? {
              ...m,
              capabilities: m.capabilities.includes(c)
                ? m.capabilities.filter((x) => x !== c)
                : [...m.capabilities, c],
            }
          : m,
      ),
    }));

  const patchModel = (idx: number, patch: Partial<ModelRow>) =>
    setDraftSafe((d) => ({
      ...d,
      models: d.models.map((m, i) => (i === idx ? { ...m, ...patch } : m)),
    }));

  const addModelRow = () =>
    setDraftSafe((d) => ({
      ...d,
      models: [...d.models, { modelId: "", displayName: "", capabilities: defaultCapsForDriver(d.driver) }],
    }));

  const removeModelRow = (idx: number) =>
    setDraftSafe((d) => ({ ...d, models: d.models.filter((_, i) => i !== idx) }));

  /** 编辑表单内「读取模型并合并」：拉取远端列表按 modelId 去重后并入，不覆盖已填行 */
  const readModelsIntoEditor = async () => {
    const d = editor;
    if (!d?.id) return;
    setEditorReading(true);
    try {
      const r = await api.providerModels(d.id);
      if (!r.ok) {
        toast(t("读取模型失败：{msg}", { msg: r.message ?? t("未知错误") }), "err");
        return;
      }
      const merged = mergeFetchedModels(d.models, r.models, d.driver);
      if (merged.added > 0) {
        setEditor((cur) => (cur && cur.id === d.id ? { ...cur, models: merged.rows } : cur));
        toast(t("已合并 {n} 个新模型（按 modelId 去重）", { n: merged.added }), "ok");
      } else {
        toast(t("远端模型均已存在于列表，无需合并"), "info");
      }
    } catch (e) {
      toast(t("读取模型失败：{msg}", { msg: errMsg(e) }), "err");
    } finally {
      setEditorReading(false);
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
              reading={!!reading[p.id]}
              fetched={fetchedModels[p.id] ?? []}
              offlineBlocked={offlineMode && !isLocalProvider(p)}
              onToggle={() => void toggleEnabled(p)}
              onTest={() => void doTest(p)}
              onRead={() => void doReadModels(p)}
              onEdit={() => setEditor(draftFrom(p, fetchedModels[p.id] ?? []))}
              onDelete={() => void doDelete(p)}
              onClearKey={() => void doClearKey(p)}
              onCopyModel={(id) => void copyModelId(id)}
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
      <div className="card pg-card">
        <h3>{t("🧪 API Playground")}</h3>
        <div className="hint" style={{ marginBottom: 10 }}>
          {t("手动向单个 Provider 发起一次测试调用；请求经 Rust 网关审计，响应自动脱敏截断")}
        </div>
        <div className="pg-row">
          <select value={pgProvider} onChange={(e) => changePgProvider(e.target.value)}>
            <option value="">{t("选择 Provider…")}</option>
            {providers.filter((p) => p.enabled).map((p) => (
              <option key={p.id} value={p.id}>{p.name}（{driverLabel(p.driver)}）</option>
            ))}
          </select>
          <select value={pgModel} onChange={(e) => setPgModel(e.target.value)} disabled={!pgProv}>
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
            onChange={(e) => setPgPrompt(e.target.value)}
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
            onClick={() => void sendTest()}
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
        <div className="modal-overlay" onClick={() => setEditor(null)}>
          <div className="modal" style={{ width: "min(780px, 94vw)" }} onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <span>{editor.id ? t("编辑 Provider · {name}", { name: editor.name }) : t("新增 Provider")}</span>
              <button className="btn sm ghost" onClick={() => setEditor(null)}>✕</button>
            </div>
            <div className="modal-body">
              <div className="field">
                <label>{t("名称 *")}</label>
                <input
                  type="text"
                  value={editor.name}
                  placeholder={t("例如：OpenAI 中转 / 本机 Ollama")}
                  onChange={(e) => patchDraft({ name: e.target.value })}
                />
              </div>

              <div className="field">
                <label>{t("驱动")}</label>
                <select value={editor.driver} onChange={(e) => changeDriver(e.target.value as ProviderDriver)}>
                  {PROVIDER_DRIVERS.map((d) => (
                    <option key={d.driver} value={d.driver}>{d.label} — {d.description}</option>
                  ))}
                </select>
              </div>

              {!editor.id && presets.length > 0 && (
                <div className="field" style={{ background: "var(--panel-2)", borderRadius: 8, padding: 12, border: "1px dashed var(--border-strong)" }}>
                  <label>{t("⚡ 平台预设一键填充（选平台 → 填 API Key → 保存即用）")}</label>
                  <div style={{ display: "flex", gap: 8 }}>
                    <select
                      value={presetSel}
                      onChange={(e) => setPresetSel(e.target.value)}
                      aria-label={t("选择平台预设")}
                      style={{ flex: 1 }}
                    >
                      <option value="">{t("选择平台预设（图片 / 视频生成）…")}</option>
                      <optgroup label={t("🖼️ 图片生成")}>
                        {presets.filter((x) => x.category === "image").map((x) => (
                          <option key={x.id} value={x.id}>{x.name}</option>
                        ))}
                      </optgroup>
                      <optgroup label={t("🎬 视频生成")}>
                        {presets.filter((x) => x.category === "video").map((x) => (
                          <option key={x.id} value={x.id}>{x.name}</option>
                        ))}
                      </optgroup>
                    </select>
                    <button className="btn blue" disabled={!presetSel} onClick={() => applyPreset(presetSel)}>
                      {t("套用")}
                    </button>
                  </div>
                  {(() => {
                    const p = presets.find((x) => x.id === presetSel);
                    if (!p) return null;
                    return (
                      <span className="sub" style={{ display: "block", marginTop: 6 }}>
                        {p.notes}
                        {"  "}
                        <a href={p.docsUrl} target="_blank" rel="noreferrer" style={{ color: "var(--blue)" }}>{t("官方文档 ↗")}</a>
                      </span>
                    );
                  })()}
                </div>
              )}

              <div className="field">
                <label>{t("Base URL *")}</label>
                <input
                  type="text"
                  value={editor.baseUrl}
                  placeholder="https://api.example.com/v1"
                  onChange={(e) => patchDraft({ baseUrl: e.target.value })}
                />
                <span className="sub">{t("切换驱动时自动填入该驱动的默认地址；Ollama 默认 http://127.0.0.1:11434")}</span>
              </div>

              <div className="mv-2col">
                <div className="field">
                  <label>{t("超时（毫秒）")}</label>
                  <input
                    type="number"
                    min={1000}
                    value={editor.timeoutMs}
                    onChange={(e) => patchDraft({ timeoutMs: Number(e.target.value) || 0 })}
                  />
                </div>
                <div className="field">
                  <label>{t("最大并发数")}</label>
                  <input
                    type="number"
                    min={1}
                    max={16}
                    value={editor.concurrency}
                    onChange={(e) => patchDraft({ concurrency: Number(e.target.value) || 1 })}
                  />
                </div>
              </div>

              <div className="field">
                <label>{t("API Key")} {editor.id && t("（留空保持不变）")}</label>
                <input
                  type="password"
                  value={editor.apiKey}
                  placeholder={editor.id ? "••••••••" : "sk-…"}
                  autoComplete="off"
                  onChange={(e) => patchDraft({ apiKey: e.target.value })}
                />
                <span className="sub">{t("🔒 Key 只存入 macOS 钥匙串（Keychain），不落 SQLite / 项目文件 / 日志")}</span>
              </div>

              <div className="field">
                <div className="mv-model-head">
                  <label>{t("模型管理（可配置多个：modelId + 显示名 + 能力）")}</label>
                  {editor.id ? (
                    <button
                      className="btn sm"
                      disabled={editorReading}
                      title={t("拉取该 Provider 远端模型列表，按 modelId 去重后合并进下方列表（不覆盖已填内容）")}
                      onClick={() => void readModelsIntoEditor()}
                    >
                      {editorReading ? t("读取中…") : t("⟳ 读取模型并合并")}
                    </button>
                  ) : (
                    <span className="sub">{t("保存后再打开「编辑」即可读取远端模型并合并")}</span>
                  )}
                </div>
                {editor.driver === "stable-diffusion" ? (
                  <span className="sub">
                    {t("⚠️ 该驱动仅支持「生图」能力（后端会拒绝其他组合），已自动限制可勾选项")}
                  </span>
                ) : null}
                {editor.driver === "comfyui" ? (
                  <span className="sub">
                    {t("生图恒可用；勾选「生视频」需在下方填写工作流模板（Wan 等本地工作流），保存时会校验")}
                  </span>
                ) : null}
                {editor.models.length === 0 && (
                  <span className="sub">{t("尚无模型：点击「➕ 添加模型」手工填写，或用「读取模型并合并」拉取")}</span>
                )}
                {editor.models.map((m, i) => {
                  const allowed = api.driverAllowedCaps(editor.driver);
                  // 表单外既有能力（vision / embedding 等）不在 checkbox 中展示，保存时原样保留
                  const extra = m.capabilities.filter(
                    (c) => !api.EDITOR_CAPABILITY_OPTIONS.some((o) => o.value === c),
                  );
                  return (
                    <div className="mv-model-row" key={i}>
                      <div className="mv-model-grid">
                        <input
                          type="text"
                          value={m.modelId}
                          placeholder={t("modelId，例如 gpt-4o / qwen2.5:7b")}
                          onChange={(e) => patchModel(i, { modelId: e.target.value })}
                        />
                        <input
                          type="text"
                          value={m.displayName}
                          placeholder={t("显示名（可留空）")}
                          onChange={(e) => patchModel(i, { displayName: e.target.value })}
                        />
                        <input
                          type="number"
                          min={0}
                          step="0.01"
                          style={{ maxWidth: 120 }}
                          title={t("单价（元/次）：预算守卫金额化的计价依据；不填则该模型不计金额")}
                          value={m.pricePerCall ?? ""}
                          placeholder={t("单价 ¥/次")}
                          onChange={(e) => patchModel(i, { pricePerCall: e.target.value === "" ? null : Number(e.target.value) })}
                        />
                        <button className="btn sm danger" onClick={() => removeModelRow(i)}>{t("删除")}</button>
                      </div>
                      <div className="mv-cap-checks">
                        {api.EDITOR_CAPABILITY_OPTIONS.map((c) => {
                          const blocked = !!allowed && !allowed.includes(c.value);
                          return (
                            <label
                              key={c.value}
                              className={`mv-cap-check ${blocked ? "off" : ""}`}
                              title={blocked ? t("该驱动不支持此能力（后端会拒绝非法组合）") : undefined}
                            >
                              <input
                                type="checkbox"
                                checked={m.capabilities.includes(c.value)}
                                disabled={blocked}
                                onChange={() => toggleCap(i, c.value)}
                              />
                              {c.label}
                            </label>
                          );
                        })}
                        {extra.length > 0 && (
                          <span className="mv-extra-caps" title={t("既有能力，保存时原样保留")}>
                            {extra.map((c) => (
                              <span key={c} className="tag pink">{api.capabilityLabel(c)}</span>
                            ))}
                          </span>
                        )}
                      </div>
                    </div>
                  );
                })}
                <div>
                  <button className="btn sm" onClick={addModelRow}>{t("➕ 添加模型")}</button>
                </div>
              </div>

              {editor.driver === "comfyui" && (
                <div className="field">
                  <label>{t("ComfyUI 工作流模板（API 格式 JSON；FLUX 出图 / Wan 生视频）")}</label>
                  <textarea
                    value={editor.workflowTemplateText}
                    style={{ minHeight: 140, fontFamily: "var(--mono)" }}
                    placeholder={t('在 ComfyUI 排好工作流 → 设置里开启「启用 Dev 模式 / API 格式」→ Save (API Format) 导出 JSON 粘贴到这里。\n占位符：文本节点写 __prompt__（正面）与 __negative__（负面）；seed / noise_seed 填 0 = 每次随机。\n图生视频/图生图：首帧参考图会自动上传并填入所有 LoadImage 类节点。')}
                    onChange={(e) => patchDraft({ workflowTemplateText: e.target.value })}
                  />
                  <div style={{ display: "flex", gap: 8, marginTop: 6 }}>
                    <button
                      className="btn sm"
                      title={t("填入 Wan2.1 图生视频的示例工作流（原生节点），权重文件名按你本机实际下载的改")}
                      onClick={() => patchDraft({ workflowTemplateText: JSON.stringify(WAN_I2V_EXAMPLE, null, 2) })}
                    >
                      {t("📥 载入 Wan 图生视频示例")}
                    </button>
                  </div>
                  <span className="sub">
                    {t("留空 = 内置 SD 工作流（仅生图）；填写后按工作流执行，产物（图片/视频）自动入库。本地直连不出公网。__width__/__height__/__frames__ 由画幅与时长自动推导，无须手填。")}
                  </span>
                </div>
              )}

              {editor.driver === "custom-http" && (
                <div className="field">
                  <label>{t("HTTP 请求模板（JSON）")}</label>
                  <textarea
                    value={editor.httpTemplateText}
                    style={{ minHeight: 120, fontFamily: "var(--mono)" }}
                    placeholder={httpTemplateHint()}
                    onChange={(e) => patchDraft({ httpTemplateText: e.target.value })}
                  />
                  <span className="sub">{httpTemplateHint()}</span>
                </div>
              )}
            </div>
            <div className="modal-foot">
              <button className="btn" onClick={() => setEditor(null)}>{t("取消")}</button>
              <button className="btn primary" disabled={saving} onClick={() => void saveEditor()}>
                {saving ? t("保存中…") : editor.id ? t("保存修改") : t("创建")}
              </button>
            </div>
          </div>
        </div>
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
