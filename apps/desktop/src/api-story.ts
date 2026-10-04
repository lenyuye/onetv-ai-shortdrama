/**
 * 剧本 / 分镜 IPC 封装层（与 api.ts / api-canvas.ts 同风格，UI 不直接接触 invoke）。
 *
 * 后端命令契约（Rust 侧已提供，见 src-tauri/src/lib.rs）：
 * - doc_get(episode_id, kind: "script"|"storyboard"|"timeline") -> serde_json::Value
 * - doc_save(episode_id, kind, doc) -> ()
 * - agent_chat(text, provider_id?, model_id?) -> { plan, auto_executed, job_ids }   （snake_case 线上格式）
 * - agent_approve(plan_id) -> Vec<String>
 * - asset_list() -> Vec<AssetRecord>（复用 api-assets.ts）
 *
 * 后端 Plan/AgentChatResult 未做 camelCase rename，本文件负责把 snake_case
 * 归一为前端视图模型（planId / jobIds / remoteCalls …）；剧本与分镜文档的
 * 字段与 @onetv/shared-types 一致（characterName / shotId / durationSec …），
 * 归一化时对缺字段、旧 schema（schema_version）做容错。
 */
import { invoke } from "@tauri-apps/api/core";
import {
  SCHEMA_VERSION,
  type AspectRatio,
  type DialogueLine,
  type SceneBlock,
  type ScriptDocument,
  type Shot,
  type ShotStatus,
  type StoryboardDocument,
} from "@onetv/shared-types";
import { assetList, assetUrl, type AssetRecord } from "./api-assets";

/* ---------------- 基础 invoke ---------------- */

/** 文档类型 —— 与 Rust doc_get/doc_save 的 kind 完全一致 */
export type DocKind = "script" | "storyboard" | "timeline";

export const docGet = (episodeId: string, kind: DocKind) =>
  invoke<unknown>("doc_get", { episodeId, kind });

export const docSave = (episodeId: string, kind: DocKind, doc: unknown) =>
  invoke<void>("doc_save", { episodeId, kind, doc });

/** 资产列表 / URL 构造 —— 转发自 api-assets.ts，供分镜视图把 outputAssetId 映射为图片 */
export { assetList, assetUrl };
export type { AssetRecord };

/** 资产 id → 绝对路径 映射（分镜图 outputAssetId 解析用） */
export function buildAssetPathMap(records: AssetRecord[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const r of records) map.set(r.id, r.path);
  return map;
}

/* ---------------- Agent 计划（视图模型） ---------------- */

export interface AgentPlanStepView {
  id: string;
  tool: string;
  description: string;
  /** "auto" | "required"（后端为 String，原样透传） */
  approval: string;
}

export interface AgentPlanView {
  planId: string;
  intent: string;
  summary: string;
  estimated: { jobs: number; remoteCalls: number; risk: string };
  steps: AgentPlanStepView[];
}

export interface AgentChatResult {
  plan: AgentPlanView;
  autoExecuted: boolean;
  jobIds: string[];
}

/** 所选对话模型（null/undefined = 自动：模型页「生成模型设置」的默认模型或自动路由） */
export interface AgentChatModel {
  providerId: string;
  modelId: string;
}

/** 规划并返回执行计划；低风险 Chat 意图会被后端直接执行（autoExecuted=true）。
 *  model 非空时把 providerId/modelId 传给后端（计划步骤优先使用该模型），不传则走默认。
 *  history（v2.6.3）：本会话最近几轮 [{role, content}]，仅 chat 意图注入 LLM 上下文。 */
export async function agentChat(
  text: string,
  model?: AgentChatModel | null,
  history?: { role: string; content: string }[]
): Promise<AgentChatResult> {
  const raw =
    asObj(
      await invoke<unknown>("agent_chat", {
        text,
        ...(model ? { providerId: model.providerId, modelId: model.modelId } : {}),
        ...(history && history.length > 0 ? { history } : {}),
      })
    ) ?? {};
  return {
    plan: normalizePlan(asObj(raw.plan) ?? {}),
    autoExecuted: raw.autoExecuted === true || raw.auto_executed === true,
    jobIds: arr(raw.jobIds ?? raw.job_ids).map((v) => str(v)).filter(Boolean),
  };
}

/** 批准执行计划，返回创建的 jobIds。 */
export async function agentApprove(planId: string): Promise<string[]> {
  const raw = await invoke<unknown>("agent_approve", { planId });
  return arr(raw)
    .map((v) => str(v))
    .filter(Boolean);
}

function normalizePlan(raw: Record<string, unknown>): AgentPlanView {
  const est = asObj(raw.estimated);
  return {
    planId: str(raw.planId ?? raw.plan_id),
    intent: str(raw.intent, "chat"),
    summary: str(raw.summary),
    estimated: {
      jobs: est ? num(est.jobs, 0) : 0,
      remoteCalls: est ? num(est.remoteCalls ?? est.remote_calls, 0) : 0,
      risk: est ? str(est.risk, "low") : "low",
    },
    steps: arr(raw.steps).map((s, i) => {
      const so = asObj(s) ?? {};
      const tool = str(so.tool, `step-${i + 1}`);
      return {
        id: str(so.id, `step-${i + 1}`),
        tool,
        description: str(so.description) || tool,
        approval: str(so.approval, "auto"),
      } satisfies AgentPlanStepView;
    }),
  };
}

/* ---------------- 剧本文档（容错归一） ---------------- */

export function emptyScriptDocument(episodeId: string): ScriptDocument {
  return {
    schemaVersion: SCHEMA_VERSION,
    episodeId,
    title: "",
    scenes: [],
    updatedAt: new Date().toISOString(),
  };
}

/** doc_get 返回的 JSON → ScriptDocument（容忍 schema_version 等旧字段名 / 缺字段）。 */
export function normalizeScript(raw: unknown, episodeId: string): ScriptDocument {
  const o = asObj(raw);
  if (!o) return emptyScriptDocument(episodeId);
  const scenes: SceneBlock[] = arr(o.scenes).map((s, i) => {
    const so = asObj(s);
    const dialogues: DialogueLine[] = so
      ? arr(so.dialogues).map((d) => {
          const dobj = asObj(d);
          return {
            characterId: dobj && dobj.characterId != null ? str(dobj.characterId) : undefined,
            characterName: dobj ? str(dobj.characterName ?? dobj.character_name, "角色") : "角色",
            line: dobj ? str(dobj.line) : "",
            parenthetical:
              dobj && dobj.parenthetical != null ? str(dobj.parenthetical) : undefined,
          };
        })
      : [];
    return {
      id: so ? str(so.id, `sc${String(i + 1).padStart(2, "0")}`) : `sc${String(i + 1).padStart(2, "0")}`,
      heading: so ? str(so.heading, `场景 ${i + 1}`) : `场景 ${i + 1}`,
      synopsis: so ? str(so.synopsis) : "",
      dialogues,
    };
  });
  return {
    schemaVersion: str(o.schemaVersion ?? o.schema_version, SCHEMA_VERSION),
    episodeId: str(o.episodeId ?? o.episode_id, episodeId),
    title: str(o.title, "未命名剧本"),
    logline: o.logline != null ? str(o.logline) : undefined,
    scenes,
    updatedAt: str(o.updatedAt ?? o.updated_at, new Date().toISOString()),
  };
}

/* ---------------- 分镜文档（容错归一） ---------------- */

export function emptyStoryboardDocument(episodeId: string): StoryboardDocument {
  return {
    schemaVersion: SCHEMA_VERSION,
    episodeId,
    shots: [],
    updatedAt: new Date().toISOString(),
  };
}

/** doc_get 返回的 JSON → StoryboardDocument（对缺字段 / 非法 status 做容错）。 */
export function normalizeStoryboard(raw: unknown, episodeId: string): StoryboardDocument {
  const o = asObj(raw);
  if (!o) return emptyStoryboardDocument(episodeId);
  return {
    schemaVersion: str(o.schemaVersion ?? o.schema_version, SCHEMA_VERSION),
    episodeId: str(o.episodeId ?? o.episode_id, episodeId),
    shots: arr(o.shots).map((s, i) => normalizeShot(asObj(s), i)),
    updatedAt: str(o.updatedAt ?? o.updated_at, new Date().toISOString()),
  };
}

const SHOT_STATUSES: readonly ShotStatus[] = ["draft", "approved", "generating", "ready", "failed"];

function normalizeShot(o: Record<string, unknown> | null, i: number): Shot {
  const idx = `S${String(i + 1).padStart(3, "0")}`;
  if (!o) {
    return {
      shotId: idx,
      scene: "",
      durationSec: 3,
      shotSize: "中景",
      camera: { movement: "", angle: "" },
      characters: [],
      action: "",
      prompt: "",
      referenceAssets: [],
      generation: { type: "text_to_video", duration: 3, aspectRatio: "9:16" },
      status: "draft",
    };
  }
  const cam = asObj(o.camera);
  const gen = asObj(o.generation);
  const status = str(o.status, "draft");
  return {
    shotId: str(o.shotId, idx),
    episodeId: o.episodeId != null ? str(o.episodeId) : undefined,
    scene: str(o.scene),
    time: o.time != null ? str(o.time) : undefined,
    durationSec: num(o.durationSec, 3),
    shotSize: str(o.shotSize, "中景"),
    camera: {
      movement: cam ? str(cam.movement) : "",
      angle: cam ? str(cam.angle) : "",
      lens: cam && cam.lens != null ? str(cam.lens) : undefined,
    },
    characters: arr(o.characters).map((c) => str(c)).filter(Boolean),
    action: str(o.action),
    expression: o.expression != null ? str(o.expression) : undefined,
    dialogue: o.dialogue != null ? str(o.dialogue) : undefined,
    subtitle: o.subtitle != null ? str(o.subtitle) : undefined,
    prompt: str(o.prompt),
    referenceAssets: arr(o.referenceAssets).map((a) => str(a)).filter(Boolean),
    generation: {
      type: gen?.type === "image_to_video" ? "image_to_video" : "text_to_video",
      model: gen && gen.model != null ? str(gen.model) : undefined,
      duration: gen ? num(gen.duration, 3) : 3,
      aspectRatio: (gen ? str(gen.aspectRatio, "9:16") : "9:16") as AspectRatio,
    },
    status: (SHOT_STATUSES as readonly string[]).includes(status)
      ? (status as ShotStatus)
      : "draft",
    outputAssetId: o.outputAssetId != null ? str(o.outputAssetId) : undefined,
  };
}

/* ---------------- 小工具 ---------------- */

function asObj(v: unknown): Record<string, unknown> | null {
  return v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
}

function str(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : fallback;
}

function num(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

/** 统一错误文案（invoke 抛出的通常是字符串） */
export function errMsg(e: unknown): string {
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message;
  return String(e);
}
