/**
 * OneTV 核心领域类型定义。
 *
 * 这里是前后端共享的“契约层”。Rust 侧的 serde 结构体字段与本文件保持一致；
 * 任何 schema 变化必须同步更新 schemaVersion 并提供 migration。
 */

export const SCHEMA_VERSION = "1.0";

/* ------------------------------------------------------------------ */
/* 通用                                                                */
/* ------------------------------------------------------------------ */

export type ID = string;

export interface EgressRecord {
  providerId: string;
  endpoint: string;
  assets: string[];
  textFields: string[];
  model?: string;
  timestamp: string;
}

/* ------------------------------------------------------------------ */
/* Workspace / Project / Episode                                       */
/* ------------------------------------------------------------------ */

export interface WorkspaceInfo {
  id: ID;
  name: string;
  rootPath: string;
  createdAt: string;
}

export interface ProjectMeta {
  id: ID;
  title: string;
  logline?: string;
  coverAssetId?: ID;
  createdAt: string;
  updatedAt: string;
  aspectRatio: AspectRatio;
  targetPlatform?: string;
  privacy: { telemetry: false; cloudSync: false };
}

export interface ProjectManifest {
  schemaVersion: string;
  project: ProjectMeta;
  providerProfiles: string[];
  episodes: EpisodeRef[];
}

export interface EpisodeRef {
  id: ID;
  number: number;
  title: string;
  script: string;
  storyboard: string;
  canvas: string;
}

export type EpisodeStatus = "draft" | "scripting" | "storyboard" | "generating" | "composing" | "done";

export interface EpisodeInfo {
  id: ID;
  projectId: ID;
  number: number;
  title: string;
  status: EpisodeStatus;
}

/* ------------------------------------------------------------------ */
/* Story Bible                                                         */
/* ------------------------------------------------------------------ */

export interface StoryBible {
  story: {
    title: string;
    genre: string;
    era: string;
    location: string;
    theme: string;
    targetDurationSec: number;
    targetPlatform: string;
    aspectRatio: AspectRatio;
    visualStyle: string;
  };
  characters: CharacterProfile[];
  locations: LocationProfile[];
  props: PropProfile[];
  continuity: string[];
}

export type AspectRatio = "16:9" | "9:16" | "1:1";

export interface CharacterProfile {
  id: ID;
  name: string;
  ageRange?: string;
  role?: string;
  appearance?: string;
  hair?: string;
  outfit?: string;
  palette?: string;
  personality?: string;
  speechStyle?: string;
  forbiddenChanges?: string[];
  refAssetId?: ID;
  variants?: { assetId: ID; label: string }[];
  locked?: boolean;
}

export interface LocationProfile {
  id: ID;
  name: string;
  timeOfDay?: string;
  space?: string;
  lighting?: string;
  colorTone?: string;
  keyProps?: string[];
  ambience?: string;
  refAssetId?: ID;
}

export interface PropProfile {
  id: ID;
  name: string;
  material?: string;
  color?: string;
  size?: string;
  usage?: string;
  episodes?: number[];
}

/* ------------------------------------------------------------------ */
/* Script / Shot                                                       */
/* ------------------------------------------------------------------ */

export interface ScriptDocument {
  schemaVersion: string;
  episodeId: ID;
  title: string;
  logline?: string;
  scenes: SceneBlock[];
  updatedAt: string;
}

export interface SceneBlock {
  id: ID;
  heading: string;
  synopsis: string;
  dialogues: DialogueLine[];
}

export interface DialogueLine {
  characterId?: ID;
  characterName: string;
  line: string;
  parenthetical?: string;
}

/** 镜头 JSON —— 规格 §6.3 */
export interface Shot {
  shotId: string;
  episodeId?: ID;
  scene: string;
  time?: string;
  durationSec: number;
  shotSize: ShotSize;
  camera: { movement: string; angle: string; lens?: string };
  characters: ID[];
  action: string;
  expression?: string;
  dialogue?: string;
  subtitle?: string;
  sfx?: string[];
  musicCue?: string;
  transition?: string;
  prompt: string;
  negativePrompt?: string;
  referenceAssets: ID[];
  generation: {
    type: "text_to_video" | "image_to_video";
    model?: string;
    duration: number;
    aspectRatio: AspectRatio;
  };
  status?: ShotStatus;
  outputAssetId?: ID;
}

export type ShotSize = "远景" | "全景" | "中景" | "近景" | "特写" | "大特写" | string;
export type ShotStatus = "draft" | "approved" | "generating" | "ready" | "failed";

export interface StoryboardDocument {
  schemaVersion: string;
  episodeId: ID;
  shots: Shot[];
  updatedAt: string;
}

/* ------------------------------------------------------------------ */
/* Assets                                                              */
/* ------------------------------------------------------------------ */

export type AssetKind = "image" | "video" | "audio" | "subtitle" | "document" | "other";

export interface AssetInfo {
  id: ID;
  sha256: string;
  path: string;
  kind: AssetKind;
  mime: string;
  sizeBytes: number;
  metadata?: Record<string, unknown>;
  refName?: string;
  createdAt: string;
}

/* ------------------------------------------------------------------ */
/* Canvas / Nodes                                                      */
/* ------------------------------------------------------------------ */

export type NodeType =
  | "text"
  | "script"
  | "image"
  | "video"
  | "audio"
  | "storyboard"
  | "video-clip"
  | "condition"
  | "review"
  | "export";

export interface NodePortDef {
  port: string;
  accept: string[];
  multiple?: boolean;
}

export interface NodeTypeDef {
  nodeType: NodeType;
  title: string;
  inputs: NodePortDef[];
  outputs: NodePortDef[];
  params: Record<string, unknown>;
  permissions: { network: string; filesystem: string };
}

export interface CanvasNode {
  id: ID;
  episodeId: ID;
  type: NodeType;
  title: string;
  config: Record<string, unknown>;
  position: { x: number; y: number };
}

export interface CanvasEdge {
  id: ID;
  episodeId: ID;
  source: ID;
  target: ID;
  sourcePort: string;
  targetPort: string;
}

export interface CanvasDocument {
  schemaVersion: string;
  episodeId: ID;
  nodes: CanvasNode[];
  edges: CanvasEdge[];
  updatedAt: string;
}

/* ------------------------------------------------------------------ */
/* Providers（规格 §22.2）                                             */
/* ------------------------------------------------------------------ */

export type ProviderDriver =
  | "openai-compatible"
  | "custom-http"
  | "ollama"
  | "mock"
  | "comfyui"
  | "stable-diffusion"
  | "plugin";

export type Capability =
  | "chat"
  | "vision"
  | "structured_output"
  | "image_generation"
  | "image_edit"
  | "video_generation"
  | "video_edit"
  | "video_extend"
  | "tts"
  | "music"
  | "embedding";

export type AuthType = "bearer" | "api-key" | "custom-header" | "none";

export interface ProviderAuth {
  type: AuthType;
  keyRef?: string;
  headerName?: string;
}

export interface ModelBinding {
  modelId: string;
  displayName: string;
  capabilities: Capability[];
  endpoint?: string;
  inputTypes?: string[];
  outputTypes?: string[];
  pricing?: { unit: string; perCall?: number; perSecond?: number };
  limits?: { maxConcurrency?: number; maxDurationSec?: number };
}

export interface ProviderProfile {
  id: ID;
  name: string;
  driver: ProviderDriver;
  baseUrl: string;
  auth: ProviderAuth;
  models: ModelBinding[];
  timeoutMs: number;
  concurrency: number;
  enabled: boolean;
  networkPolicyId: string;
  createdAt: string;
}

export type ProviderHealth =
  | "unknown"
  | "healthy"
  | "degraded"
  | "unauthorized"
  | "rate_limited"
  | "unreachable"
  | "disabled";

export interface ProviderStatusInfo {
  providerId: ID;
  health: ProviderHealth;
  hasKey: boolean;
  lastOkAt?: string;
  lastErrorAt?: string;
  lastError?: string;
}

/* ------------------------------------------------------------------ */
/* Jobs（规格 §11.1）                                                  */
/* ------------------------------------------------------------------ */

export type JobState =
  | "QUEUED"
  | "VALIDATING"
  | "AWAITING_APPROVAL"
  | "SUBMITTING"
  | "RUNNING"
  | "DOWNLOADING"
  | "POST_PROCESSING"
  | "SUCCEEDED"
  | "FAILED"
  | "RETRY_WAIT"
  | "CANCELED";

export interface JobInfo {
  id: ID;
  nodeId?: ID;
  episodeId?: ID;
  kind: Capability | "timeline.render" | "import" | "export";
  providerId?: string;
  model?: string;
  state: JobState;
  progress: number;
  title: string;
  egress?: EgressRecord;
  costEstimate?: Record<string, unknown>;
  error?: string;
  createdAt: string;
  updatedAt: string;
  remoteJobId?: string;
  idempotencyKey?: string;
}

export interface JobEvent {
  id: number;
  jobId: ID;
  seq: number;
  eventType: string;
  payload: Record<string, unknown>;
  time: string;
}

/* ------------------------------------------------------------------ */
/* Timeline / Export（规格 §12）                                       */
/* ------------------------------------------------------------------ */

export interface TimelineClip {
  asset: string;
  start: number;
  duration: number;
  volume?: number;
  text?: string;
}

export interface TimelineTrack {
  id: string;
  type: "video" | "audio" | "subtitle";
  clips: TimelineClip[];
}

export interface TimelineDocument {
  schemaVersion: string;
  fps: number;
  tracks: TimelineTrack[];
}

export type ExportPreset = "douyin_vertical" | "xhs_vertical" | "horizontal_1080p" | "square" | "master";

export interface ExportOptions {
  preset: ExportPreset;
  burnSubtitle: boolean;
  includeSrt: boolean;
  outputPath?: string;
}

/* ------------------------------------------------------------------ */
/* Agent（规格 §5）                                                    */
/* ------------------------------------------------------------------ */

export type IntentType =
  | "chat"
  | "project.create"
  | "script.generate"
  | "storyboard.generate"
  | "image.generate"
  | "video.generate"
  | "video.edit"
  | "video.extend"
  | "timeline.compose"
  | "asset.link"
  | "memory.update"
  | "export"
  | "video.understand";

export interface PlanStep {
  id: string;
  tool: string;
  input: Record<string, unknown>;
  dependsOn: string[];
  approval?: "required" | "auto";
  description?: string;
}

export interface AgentPlan {
  planId: ID;
  intent: IntentType;
  summary: string;
  estimated: { jobs: number; remoteCalls: number; risk: "low" | "medium" | "high" };
  steps: PlanStep[];
  createdAt: string;
  status: "draft" | "approved" | "executing" | "done" | "rejected";
}

export interface AgentMessage {
  id: ID;
  role: "user" | "assistant" | "system";
  content: string;
  planId?: ID;
  time: string;
}

/* ------------------------------------------------------------------ */
/* Skills                                                              */
/* ------------------------------------------------------------------ */

export interface SkillManifest {
  id: string;
  name: string;
  version: string;
  description?: string;
  author?: string;
  license?: string;
  permissions: { network: string[]; filesystem: string[] };
  inputs: string[];
  outputs: string[];
  entry: string;
  trustLevel?: 0 | 1 | 2 | 3;
}

/* ------------------------------------------------------------------ */
/* Settings                                                            */
/* ------------------------------------------------------------------ */

/* ---------------- 生成模型设置（v2.3.5，对应 Rust settings.model_defaults） ---------------- */

/** 能力 → 默认模型的引用（Rust 侧 ModelRef { provider_id, model_id }，camelCase 序列化） */
export interface ModelRef {
  providerId: string;
  modelId: string;
}

/** 「生成模型设置」四个能力键（与 Rust settings.model_defaults 的 HashMap key 一致） */
export type ModelDefaultCapability = "chat" | "image" | "video" | "tts";

/**
 * 各能力默认生成模型表。
 * 值允许 null：经 IPC 传 null 表示清除该能力的默认（undefined 会被 JSON 序列化丢弃，
 * 后端对非对象值 / 缺 providerId|modelId 的对象一律执行删除该 key）。
 */
export type ModelDefaults = Partial<Record<ModelDefaultCapability, ModelRef | null>>;

export interface AppSettings {
  schemaVersion: string;
  theme: "dark" | "light";
  language: string;
  offlineMode: boolean;
  /** 自动记忆（v2.26.15）：对话后自动提取 + 生成时注入上下文 */
  autoMemory: boolean;
  telemetry: false;
  ffmpegPath?: string;
  ffprobePath?: string;
  maxConcurrentJobs: number;
  autoSaveIntervalSec: number;
  defaultProjectFolder?: string;
  /** v2.1 自定义皮肤图片（应用数据 themes/ 内文件名） */
  skin?: string;
  /** v2.1 皮肤不透明度 0-1 */
  skinOpacity?: number;
  /** v2.3.5 各能力默认生成模型；缺省 key = 自动路由 */
  modelDefaults?: ModelDefaults;
  /** v2.10 预算守卫：远程生成（生图/生视频/配音）调用额度 */
  costGuard?: { enabled: boolean; dailyRemoteLimit: number; projectTotalLimit: number };
  /** v2.22 出站 Webhook 回调（任务终态 POST） */
  webhookOut?: { enabled: boolean; url: string; secret: string };
}

/* ------------------------------------------------------------------ */
/* 事件总线（规格 §15.2）                                              */
/* ------------------------------------------------------------------ */

export type AppEventName =
  | "job.created"
  | "job.progress"
  | "job.awaitingApproval"
  | "job.succeeded"
  | "job.failed"
  | "node.updated"
  | "asset.added"
  | "asset.removed"
  | "agent.plan.created"
  | "agent.plan.approved"
  | "agent.message"
  | "security.egress.preview"
  | "security.egress.sent";

export interface AppEvent<T = unknown> {
  name: AppEventName;
  payload: T;
  time: string;
}
