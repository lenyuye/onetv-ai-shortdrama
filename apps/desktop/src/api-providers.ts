/**
 * Provider / 密钥 / Playground / 任务队列 IPC 封装。
 *
 * 独立于 api.ts：模型视图（ModelsView）与任务视图（JobsView）使用，UI 不直接接触 invoke。
 * 对应 Rust 侧命令：
 *   provider_list / provider_save / provider_delete / provider_test / provider_models
 *   secure_key_set / secure_key_delete / secure_key_exists
 *   playground_test
 *   job_list / job_events / job_cancel / job_retry / job_approve
 *
 * 序列化约定：Rust 端 ProviderProfile 结构体字段为 snake_case（base_url / model_id /
 * timeout_ms / ...），而 provider_list / job_list 的返回是手工构造的 camelCase JSON。
 * 因此这里是「读 camelCase、写 snake_case」，映射统一收在 providerSave 内。
 */
import { invoke } from "@tauri-apps/api/core";
import type {
  Capability,
  ModelDefaultCapability,
  ModelDefaults,
  ModelRef,
  ProviderDriver,
} from "@onetv/shared-types";

/* ---------------- 类型（与 Rust provider_public / job_list 的 JSON 输出一致） ---------------- */

export interface ProviderModelDto {
  modelId: string;
  displayName: string;
  capabilities: Capability[];
}

export interface ProviderDto {
  id: string;
  name: string;
  driver: ProviderDriver;
  baseUrl: string;
  /** bearer | api-key | custom-header | none */
  authType: string;
  models: ProviderModelDto[];
  timeoutMs: number;
  concurrency: number;
  enabled: boolean;
  /** Keychain 中是否已存有该 Provider 的 API Key */
  hasKey: boolean;
  httpTemplate: unknown;
}

export interface ProviderSaveInput {
  /** 缺省 = 新增（Rust 端自动生成 id） */
  id?: string;
  name: string;
  driver: ProviderDriver;
  baseUrl: string;
  models: { modelId: string; displayName: string; capabilities: Capability[] }[];
  timeoutMs?: number;
  concurrency?: number;
  enabled: boolean;
  httpTemplate?: unknown;
  /** 决定 auth.type；ollama/mock 应传 none，其余默认 bearer */
  authType?: string;
}

export interface ProviderTestResult {
  ok: boolean;
  message: string;
  latencyMs?: number;
}

export interface ProviderModelsResult {
  ok: boolean;
  models: string[];
  message?: string;
}

export interface PlaygroundResult {
  ok: boolean;
  latencyMs: number;
  /** 响应文本已经过 Rust 端 redact 脱敏并截断 */
  response: string;
}

export interface JobDto {
  id: string;
  kind: string;
  title: string;
  state: string;
  /** 0-1 */
  progress: number;
  providerId?: string | null;
  model?: string | null;
  episodeId?: string | null;
  error?: string | null;
  attempts?: number;
  outputs?: string[];
  createdAt: string;
  updatedAt: string;
}

export interface JobEventDto {
  type: string;
  payload: unknown;
  time: string;
}

/** Egress 记录（规格 §4.4/§11.3）—— Rust 侧为任意 JSON，这里按已知字段宽松读取 */
export interface EgressPreview {
  providerId?: string;
  endpoint?: string;
  model?: string;
  textFields?: unknown;
  assets?: unknown;
  timestamp?: string;
}

/* ---------------- Capability 常量表（与 shared-types 的 Capability 联合一致） ---------------- */

export const CAPABILITY_OPTIONS: { value: Capability; label: string }[] = [
  { value: "chat", label: "对话" },
  { value: "vision", label: "视觉理解" },
  { value: "structured_output", label: "结构化输出" },
  { value: "image_generation", label: "图像生成" },
  { value: "image_edit", label: "图像编辑" },
  { value: "video_generation", label: "视频生成" },
  { value: "video_edit", label: "视频编辑" },
  { value: "video_extend", label: "视频延展" },
  { value: "tts", label: "语音合成" },
  { value: "music", label: "音乐生成" },
  { value: "embedding", label: "向量嵌入" },
];

export const capabilityLabel = (c: Capability): string =>
  CAPABILITY_OPTIONS.find((o) => o.value === c)?.label ?? c;

/**
 * Provider 编辑表单「能力多选」的五项核心生成能力。
 * 其它既有能力（vision / image_edit / embedding 等）不在表单展示，但保存时原样保留。
 */
export const EDITOR_CAPABILITY_OPTIONS: { value: Capability; label: string }[] = [
  { value: "chat", label: "对话" },
  { value: "structured_output", label: "结构化输出" },
  { value: "image_generation", label: "生图" },
  { value: "video_generation", label: "生视频" },
  { value: "tts", label: "配音" },
];

/** 驱动-能力约束：SD / ComfyUI 后端只接受生图（lib.rs validate_driver_capabilities） */
const DRIVER_ALLOWED_CAPS: Partial<Record<ProviderDriver, readonly Capability[]>> = {
  "stable-diffusion": ["image_generation"],
  comfyui: ["image_generation"],
};

/** 返回该驱动允许的能力白名单；null = 不限制 */
export const driverAllowedCaps = (d: ProviderDriver): readonly Capability[] | null =>
  DRIVER_ALLOWED_CAPS[d] ?? null;

/* ---------------- 「生成模型设置」（settings.modelDefaults） ---------------- */

/** 四个能力键的行标签（卡片行 + toast 文案） */
export const MODEL_DEFAULT_ROWS: { key: ModelDefaultCapability; label: string; short: string }[] = [
  { key: "chat", label: "对话 / 推理", short: "对话" },
  { key: "image", label: "图片生成", short: "图片" },
  { key: "video", label: "视频生成", short: "视频" },
  { key: "tts", label: "音频配音", short: "配音" },
];

/** 能力键 → 下拉筛选模型所需的 Capability */
export const MODEL_DEFAULT_CAP: Record<ModelDefaultCapability, Capability> = {
  chat: "chat",
  image: "image_generation",
  video: "video_generation",
  tts: "tts",
};

/** select option 值编码：providerId 与 modelId 用 "::" 分隔（providerId 为 provider-<uuid>，不含冒号） */
export const modelOptionValue = (ref: ModelRef): string => `${ref.providerId}::${ref.modelId}`;

/** 解析 select option 值；非法返回 null（= 自动路由） */
export const parseModelOptionValue = (v: string): ModelRef | null => {
  if (!v) return null;
  const i = v.indexOf("::");
  if (i <= 0 || i === v.length - 2) return null;
  return { providerId: v.slice(0, i), modelId: v.slice(i + 2) };
};

/* ---------------- Providers ---------------- */

export const providerList = () => invoke<ProviderDto[]>("provider_list");

/**
 * 保存 Provider（传对象；无 id 时 Rust 端自动生成并新增）。
 * 同时把 Base URL 加入网络白名单（Rust 端逻辑）。
 */
export async function providerSave(profile: ProviderSaveInput): Promise<ProviderDto> {
  const wire = {
    id: profile.id ?? "",
    name: profile.name,
    driver: profile.driver,
    base_url: profile.baseUrl,
    auth: {
      type: profile.authType ?? "bearer",
      key_ref: null,
      header_name: null,
    },
    models: profile.models.map((m) => ({
      model_id: m.modelId,
      display_name: m.displayName || m.modelId,
      capabilities: m.capabilities,
    })),
    timeout_ms: profile.timeoutMs ?? 180_000,
    concurrency: profile.concurrency ?? 2,
    enabled: profile.enabled,
    network_policy_id: "default",
    http_template: profile.httpTemplate ?? null,
  };
  return invoke<ProviderDto>("provider_save", { profile: wire });
}

export const providerDelete = (id: string) => invoke<void>("provider_delete", { id });

export const providerTest = (id: string) => invoke<ProviderTestResult>("provider_test", { id });

export const providerModels = (id: string) => invoke<ProviderModelsResult>("provider_models", { id });

/* ---------------- Keychain（API Key 只存系统钥匙串） ---------------- */

export const secureKeySet = (providerId: string, key: string) =>
  invoke<void>("secure_key_set", { providerId, key });

export const secureKeyDelete = (providerId: string) =>
  invoke<void>("secure_key_delete", { providerId });

export const secureKeyExists = (providerId: string) =>
  invoke<boolean>("secure_key_exists", { providerId });

/* ---------------- API Playground（规格 §22.9） ---------------- */

export const playgroundTest = (providerId: string, model: string, text: string) =>
  invoke<PlaygroundResult>("playground_test", { providerId, model, text });

/* ---------------- 任务队列（规格 §11） ---------------- */

export const jobList = (limit = 200) => invoke<JobDto[]>("job_list", { limit });

export const jobEvents = (id: string) => invoke<JobEventDto[]>("job_events", { id });

export const jobCancel = (id: string) => invoke<void>("job_cancel", { id });

export const jobRetry = (id: string) => invoke<void>("job_retry", { id });

export const jobApprove = (id: string) => invoke<void>("job_approve", { id });
