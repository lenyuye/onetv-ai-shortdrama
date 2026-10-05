/**
 * useProviderEditor —— Provider 新增/编辑表单草稿状态（ModelsView 专用）。
 *
 * - 本模块同时导出表单草稿类型（ModelRow / EditorDraft）与纯函数工具
 *   （newDraft / draftFrom / mergeFetchedModels / sanitizeCaps / authTypeOf /
 *   driverLabel / errMsg），供 ModelsView 主组件与 components/models 子组件共用；
 * - hook 本身只管草稿状态与行级编辑动作（补丁/驱动切换/能力勾选/模型行增删/
 *   读取远端模型并合并/平台预设一键填充）；
 * - 保存编排（saveEditor）仍留在 ModelsView 主组件。
 */
import { useEffect, useState } from "react";
import { PROVIDER_DRIVERS } from "@onetv/provider-sdk";
import type { Capability, ProviderDriver } from "@onetv/shared-types";
import * as api from "../api-providers";
import type { ProviderDto } from "../api-providers";
import { t, useT } from "../i18n";
import { useApp } from "../store";

/* ---------------- 表单草稿类型 ---------------- */

export interface ModelRow {
  modelId: string;
  displayName: string;
  capabilities: Capability[];
  /** 单价（元/次），v2.14 金额化预算守卫 */
  pricePerCall?: number | null;
}

export interface EditorDraft {
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
export const driverLabel = (d: ProviderDriver) => driverInfo(d)?.label ?? d;

/** auth.type 由驱动推导：本地/模拟服务无密钥，其余走 Bearer */
// 本地驱动（Ollama/ComfyUI/Stable Diffusion/Mock）一律免鉴权直连
export const authTypeOf = (d: ProviderDriver): string =>
  d === "ollama" || d === "mock" || d === "comfyui" || d === "stable-diffusion" ? "none" : "bearer";

export function newDraft(): EditorDraft {
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

export function draftFrom(p: ProviderDto, fetched: string[] = []): EditorDraft {
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
export function defaultCapsForDriver(d: ProviderDriver): Capability[] {
  return api.driverAllowedCaps(d) ? ["image_generation"] : ["chat"];
}

/** 按驱动约束净化能力（SD / ComfyUI 仅生图；全被过滤掉时回退为白名单首个能力） */
export function sanitizeCaps(caps: Capability[], driver: ProviderDriver): Capability[] {
  const allowed = api.driverAllowedCaps(driver);
  if (!allowed) return caps;
  const kept = caps.filter((c) => allowed.includes(c));
  return kept.length ? kept : [...allowed];
}

/** 远端模型列表合并进模型行（按 modelId 去重，不覆盖既有行） */
export function mergeFetchedModels(rows: ModelRow[], ids: string[], driver: ProviderDriver): { rows: ModelRow[]; added: number } {
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

/** Tauri 命令 Err 时前端拿到 {message} 对象，统一提取可读文案 */
export const errMsg = (e: unknown): string => {
  if (typeof e === "string") return e;
  if (e && typeof e === "object" && "message" in e) return String((e as { message: unknown }).message);
  try { return JSON.stringify(e); } catch { return String(e); }
};

/* ---------------- 草稿状态 hook ---------------- */

export function useProviderEditor() {
  const { toast } = useApp();
  const t = useT();

  const [editor, setEditor] = useState<EditorDraft | null>(null);
  const [editorReading, setEditorReading] = useState(false);

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

  return {
    editor,
    setEditor,
    patchDraft,
    changeDriver,
    toggleCap,
    patchModel,
    addModelRow,
    removeModelRow,
    readModelsIntoEditor,
    editorReading,
    presets,
    presetSel,
    setPresetSel,
    applyPreset,
  };
}
