/**
 * 画布数据模型辅助层 —— CanvasDocument ↔ ReactFlow 节点/边互转、默认配置、图标与摘要。
 * 纯函数集合，不依赖 React。
 */
import type { Edge, Node, XYPosition } from "@xyflow/react";
import { checkPortCompatible, NODE_TYPE_DEFS } from "@onetv/node-sdk";
import { t } from "../../i18n";
import {
  SCHEMA_VERSION,
  type CanvasDocument,
  type CanvasNode,
  type NodeType,
  type NodePortDef,
} from "@onetv/shared-types";

/** node-sdk 中 params 值的宽松形状（def.params 在共享类型里是 Record<string, unknown>）。 */
export interface NodeParamDef {
  type?: string;
  required?: boolean;
  min?: number;
  max?: number;
  values?: string[];
}

/** ReactFlow 节点：data 里携带领域 CanvasNode。 */
export type FlowNode = Node<{ cn: CanvasNode }, "onetv">;
export type FlowEdge = Edge;

export const NODE_ICONS: Record<NodeType, string> = {
  asset: "📁",
  text: "📄",
  script: "📝",
  storyboard: "🎞️",
  image: "🖼️",
  video: "🎥",
  audio: "🎙️",
  "video-clip": "✂️",
  condition: "🔀",
  review: "✅",
  export: "📦",
};

export const NODE_COLORS: Record<NodeType, string> = {
  asset: "#8f9dff",
  text: "#4d7cfe",
  script: "#ff3d9a",
  storyboard: "#b34dff",
  image: "#26d0e8",
  video: "#ffb547",
  audio: "#35d07f",
  "video-clip": "#7a83ad",
  condition: "#ff5470",
  review: "#e9edfb",
  export: "#f5d76e",
};

export function uid(prefix = "n"): string {
  return `${prefix}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

/** 由 NODE_TYPE_DEFS[type].params 生成节点初始 config。 */
export function defaultConfig(type: NodeType): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const params = NODE_TYPE_DEFS[type]?.params ?? {};
  for (const [key, raw] of Object.entries(params)) {
    const p = raw as NodeParamDef;
    if (p.type === "number") out[key] = typeof p.min === "number" ? p.min : 1;
    else if (p.type === "enum") out[key] = p.values?.[0] ?? "";
    else out[key] = "";
  }
  return out;
}

export function createCanvasNode(
  type: NodeType,
  episodeId: string,
  position: XYPosition
): CanvasNode {
  const def = NODE_TYPE_DEFS[type];
  return {
    id: uid(),
    episodeId,
    type,
    title: def?.title ?? type,
    config: defaultConfig(type),
    position: { x: position.x, y: position.y },
  };
}

/** CanvasDocument → ReactFlow 图元素。 */
export function docToFlow(doc: CanvasDocument): { nodes: FlowNode[]; edges: FlowEdge[] } {
  return {
    nodes: doc.nodes.map(
      (n): FlowNode => ({
        id: n.id,
        type: "onetv",
        position: { x: n.position?.x ?? 0, y: n.position?.y ?? 0 },
        data: { cn: n },
      })
    ),
    edges: doc.edges.map(
      (e): FlowEdge => ({
        id: e.id,
        source: e.source,
        target: e.target,
        sourceHandle: e.sourcePort || null,
        targetHandle: e.targetPort || null,
      })
    ),
  };
}

/** ReactFlow 图元素 → CanvasDocument（position 以画布上的实时位置为准）。 */
export function flowToDoc(
  nodes: FlowNode[],
  edges: FlowEdge[],
  episodeId: string
): CanvasDocument {
  return {
    schemaVersion: SCHEMA_VERSION,
    episodeId,
    updatedAt: new Date().toISOString(),
    nodes: nodes.map((n) => {
      const cn = (n.data as { cn?: CanvasNode }).cn;
      const position = { x: n.position?.x ?? 0, y: n.position?.y ?? 0 };
      if (!cn) {
        // 数据异常兜底：保留节点外壳，避免丢 id/位置
        return {
          id: n.id,
          episodeId,
          type: "text" as NodeType,
          title: n.id,
          config: {},
          position,
        };
      }
      return { ...cn, position };
    }),
    edges: edges.map((e) => ({
      id: e.id,
      episodeId,
      source: e.source,
      target: e.target,
      sourcePort: e.sourceHandle ?? "out",
      targetPort: e.targetHandle ?? "in",
    })),
  };
}

/** 比较用 JSON（忽略 updatedAt 等易变字段）。 */
export function docCoreJson(doc: CanvasDocument): string {
  return JSON.stringify({ nodes: doc.nodes, edges: doc.edges });
}

/** 路径 → 是否视频媒体（v2.26.156）：先剥离 ?/# 查询串再按扩展名判断。
 * 兼容历史脏数据（custom provider 曾把 "xxx.mp4?e=签名" 整段落盘为文件扩展名）。 */
export function isVideoMediaPath(p: string | undefined | null): boolean {
  const clean = (p ?? "").split(/[?#]/, 1)[0] ?? "";
  return /\.(mp4|mov|webm|m4v)$/i.test(clean);
}

/** 路径 → 是否可预览的图/视频媒体（同样剥离查询串）。 */
export function isPreviewMediaPath(p: string | undefined | null): boolean {
  const clean = (p ?? "").split(/[?#]/, 1)[0] ?? "";
  return /\.(png|jpe?g|webp|gif|mp4|mov|webm|m4v)$/i.test(clean);
}

/** 节点卡片参数摘要：config 前 max 个键值对。 */
/** 端口名中文映射（节点卡片显示用；技术标识保留在 Handle tooltip 中） */
export const PORT_CN: Record<string, string> = {
  in: "输入", out: "输出", prompt: "提示词", ref: "参考图", brief: "需求",
  bible: "设定", script: "剧本", shots: "镜头", image: "图片", video: "视频",
  audio: "音频", text: "文本", pass: "通过", fail: "驳回", approved: "已审",
};
export const portCn = (p: string): string => t(PORT_CN[p] ?? p);

/** 参数键中文映射（节点卡片摘要显示用） */
export const PARAM_CN: Record<string, string> = {
  model: "模型", providerId: "供应商", modelId: "模型", prompt: "提示词",
  text: "文本", aspectRatio: "画幅", count: "数量", duration: "时长",
  voice: "音色", style: "风格", shotsPerScene: "镜头数", episodeCount: "集数",
  timeline: "时间线", preset: "预设", expression: "条件", note: "备注",
};
export const paramCn = (k: string): string => t(PARAM_CN[k] ?? k);

export function configSummary(config: Record<string, unknown> | undefined, max = 2): string {
  const entries = Object.entries(config ?? {}).filter(([, v]) => {
    const sv = typeof v === "string" ? v : v == null ? "" : JSON.stringify(v);
    return sv !== "" && sv !== "null";
  });
  if (entries.length === 0) return t("参数未设置");
  return entries
    .slice(0, max)
    .map(([k, v]) => {
      let s = typeof v === "string" ? v : JSON.stringify(v);
      if (s === undefined) s = "";
      if (s.length > 16) s = `${s.slice(0, 16)}…`;
      return t("{key}：{value}", { key: paramCn(k), value: s || t("未设置") });
    })
    .join(" · ");
}

/** 取目标节点某输入端口定义（含 accept）；port 为空时回退第一个输入。 */
export function inputAcceptOf(type: NodeType, port: string | null): NodePortDef | null {
  const inputs = NODE_TYPE_DEFS[type]?.inputs ?? [];
  if (!inputs.length) return null;
  const hit = port ? inputs.find((i) => i.port === port) : undefined;
  return hit ?? inputs[0];
}

/** 取源节点某输出端口的 accept 列表；port 为空时取所有输出 accept 的并集。 */
export function outputAcceptOf(type: NodeType, port: string | null): string[] {
  const outputs = NODE_TYPE_DEFS[type]?.outputs ?? [];
  const hit = port ? outputs.find((o) => o.port === port) : undefined;
  if (hit) return hit.accept;
  return Array.from(new Set(outputs.flatMap((o) => o.accept)));
}

/** 单连接点模式（v2.26.19，LibTV/即梦式）：节点只渲染 1 输入点 + 1 输出点，
 * 连线时按类型兼容性自动选择实际的逻辑端口。 */
/** 为 target 类型挑选能接受 source accept 的第一个输入端口；无则回退第一个输入。 */
export function pickInputPort(type: NodeType, sourceAccepts: string[]): { port: NodePortDef; id: string } | null {
  const inputs = NODE_TYPE_DEFS[type]?.inputs ?? [];
  if (!inputs.length) return null;
  const hit = inputs.find((i) => {
    const r = checkPortCompatible(i.accept, sourceAccepts);
    return r.ok;
  });
  const port = hit ?? inputs[0];
  return { port, id: port.port };
}

/** 为 source 类型挑选输出端口：优先与 target accept 兼容的，否则第一个输出。 */
export function pickOutputPort(type: NodeType, targetAccept: string[]): { port: NodePortDef; id: string } | null {
  const outputs = NODE_TYPE_DEFS[type]?.outputs ?? [];
  if (!outputs.length) return null;
  const hit = outputs.find((o) => {
    const r = checkPortCompatible(targetAccept, o.accept);
    return r.ok;
  });
  const port = hit ?? outputs[0];
  return { port, id: port.port };
}

/** 统一错误信息文本（Tauri invoke 失败多为 string）。 */
export function errMsg(e: unknown): string {
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message;
  try {
    return JSON.stringify(e);
  } catch {
    return String(e);
  }
}
