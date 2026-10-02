/**
 * OneTV Provider SDK —— 能力协议（规格 §8/§22）。
 * 业务层只依赖 Capability 与 Model Schema，不依赖具体厂商。
 */
import type { Capability, ProviderDriver, ProviderProfile } from "@onetv/shared-types";

export interface CapabilityRequest {
  capability: Capability;
  preferredModel?: string | null;
  constraints?: {
    aspectRatio?: string;
    durationSec?: number;
    maxCost?: number;
  };
  policy?: {
    allowFallback?: boolean;
    requireApproval?: boolean;
  };
}

export interface ProviderDriverInfo {
  driver: ProviderDriver;
  label: string;
  description: string;
  defaultBaseUrl: string;
  defaultTimeoutMs: number;
  supportsModelListing: boolean;
  capabilities: Capability[];
}

/** 内置驱动注册表（与 Rust 端 driver factory 对应） */
export const PROVIDER_DRIVERS: ProviderDriverInfo[] = [
  {
    driver: "openai-compatible",
    label: "OpenAI 兼容",
    description: "任何遵循 /chat/completions 与 /models 的服务（中转、聚合、自建网关均可）",
    defaultBaseUrl: "https://api.example.com/v1",
    defaultTimeoutMs: 180000,
    supportsModelListing: true,
    capabilities: ["chat", "vision", "structured_output", "embedding", "image_generation"],
  },
  {
    driver: "ollama",
    label: "Ollama（本地）",
    description: "本机 Ollama 服务，不出流量，Local-only 模式可用",
    defaultBaseUrl: "http://127.0.0.1:11434",
    defaultTimeoutMs: 600000,
    supportsModelListing: true,
    capabilities: ["chat", "vision", "structured_output", "embedding"],
  },
  {
    driver: "custom-http",
    label: "自定义 HTTP",
    description: "通过请求模板 + 响应映射接入任意 HTTP API（含异步任务轮询）",
    defaultBaseUrl: "https://api.example.com",
    defaultTimeoutMs: 300000,
    supportsModelListing: false,
    capabilities: ["image_generation", "video_generation", "tts", "chat"],
  },
  {
    driver: "stable-diffusion" as ProviderDriver,
    label: "Stable Diffusion（本地）",
    description: "AUTOMATIC1111 / Forge WebUI（与 ComfyUI 同为本地直连、免鉴权、Local-only 可用），本机生图辅助资产",
    defaultBaseUrl: "http://127.0.0.1:7860",
    defaultTimeoutMs: 600000,
    supportsModelListing: true,
    capabilities: ["image_generation", "image_edit"] as Capability[],
  },
  {
    driver: "comfyui",
    label: "ComfyUI（本地）",
    description: "本地 ComfyUI 工作流，用于生图/生视频（P1）",
    defaultBaseUrl: "http://127.0.0.1:8188",
    defaultTimeoutMs: 600000,
    supportsModelListing: false,
    capabilities: ["image_generation", "video_generation"],
  },
  {
    driver: "mock",
    label: "Mock（离线演示）",
    description: "内置离线模拟 Provider，用本地素材模拟生成结果，用于开发与验收测试",
    defaultBaseUrl: "mock://local",
    defaultTimeoutMs: 30000,
    supportsModelListing: true,
    capabilities: [
      "chat",
      "vision",
      "structured_output",
      "image_generation",
      "video_generation",
      "tts",
      "embedding",
    ],
  },
];

export interface CostEstimate {
  currency?: string;
  amount?: number;
  unknown?: boolean;
  note?: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

export function maskBaseUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}${u.pathname.replace(/\/$/, "")}`;
  } catch {
    return url;
  }
}

export type { ProviderProfile, Capability, ProviderDriver };
