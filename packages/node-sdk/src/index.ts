/**
 * OneTV 节点 SDK —— 所有画布节点遵守统一 Node schema（规格 §7.2）。
 * 节点类型注册表：Rust 端 NodeRuntime 与前端 Palette 共用该定义。
 */
import type { NodeType, NodeTypeDef } from "@onetv/shared-types";

export const NODE_TYPE_DEFS: Record<NodeType, NodeTypeDef> = {
  text: {
    nodeType: "text",
    title: "文本",
    inputs: [{ port: "in", accept: ["text/*"], multiple: true }],
    outputs: [{ port: "out", accept: ["text/*"] }],
    params: { text: { type: "string", required: true } },
    permissions: { network: "none", filesystem: "project_only" },
  },
  script: {
    nodeType: "script",
    title: "剧本",
    inputs: [
      { port: "brief", accept: ["text/*"] },
      { port: "bible", accept: ["application/onetv.bible"] },
    ],
    outputs: [{ port: "script", accept: ["application/onetv.script"] }],
    params: {
      model: { type: "modelRef", required: true },
      episodeCount: { type: "number", min: 1, max: 100 },
      style: { type: "string" },
    },
    permissions: { network: "provider_only", filesystem: "project_only" },
  },
  storyboard: {
    nodeType: "storyboard",
    title: "分镜",
    inputs: [{ port: "script", accept: ["application/onetv.script"] }],
    outputs: [{ port: "shots", accept: ["application/onetv.shots"], multiple: true }],
    params: {
      shotsPerScene: { type: "number", min: 1, max: 20 },
      model: { type: "modelRef" },
    },
    permissions: { network: "provider_only", filesystem: "project_only" },
  },
  image: {
    nodeType: "image",
    title: "生图",
    inputs: [
      { port: "prompt", accept: ["text/*"] },
      { port: "ref", accept: ["image/*"], multiple: true },
    ],
    outputs: [{ port: "image", accept: ["image/*"], multiple: true }],
    params: {
      model: { type: "modelRef", required: true },
      aspectRatio: { type: "enum", values: ["16:9", "9:16", "1:1"] },
      count: { type: "number", min: 1, max: 8 },
    },
    permissions: { network: "provider_only", filesystem: "project_only" },
  },
  video: {
    nodeType: "video",
    title: "生视频",
    inputs: [
      { port: "prompt", accept: ["text/*"] },
      { port: "image", accept: ["image/*"] },
    ],
    outputs: [{ port: "video", accept: ["video/*"] }],
    params: {
      prompt: { type: "string", required: true },
      model: { type: "modelRef", required: true },
      duration: { type: "number", min: 1, max: 60 },
      aspectRatio: { type: "enum", values: ["16:9", "9:16", "1:1"] },
    },
    permissions: { network: "provider_only", filesystem: "project_only" },
  },
  audio: {
    nodeType: "audio",
    title: "配音/音频",
    inputs: [{ port: "text", accept: ["text/*"] }],
    outputs: [{ port: "audio", accept: ["audio/*"] }],
    params: { voice: { type: "string" }, model: { type: "modelRef" } },
    permissions: { network: "provider_only", filesystem: "project_only" },
  },
  "video-clip": {
    nodeType: "video-clip",
    title: "片段合成",
    inputs: [
      { port: "video", accept: ["video/*"], multiple: true },
      { port: "audio", accept: ["audio/*"], multiple: true },
    ],
    outputs: [{ port: "video", accept: ["video/*"] }],
    params: { timeline: { type: "timelineRef" }, preset: { type: "string" } },
    permissions: { network: "none", filesystem: "project_only" },
  },
  condition: {
    nodeType: "condition",
    title: "条件分支",
    inputs: [{ port: "in", accept: ["*/*"] }],
    outputs: [
      { port: "pass", accept: ["*/*"] },
      { port: "fail", accept: ["*/*"] },
    ],
    params: { expression: { type: "string" } },
    permissions: { network: "none", filesystem: "none" },
  },
  review: {
    nodeType: "review",
    title: "人工审核",
    inputs: [{ port: "in", accept: ["*/*"] }],
    outputs: [{ port: "approved", accept: ["*/*"] }],
    params: { note: { type: "string" } },
    permissions: { network: "none", filesystem: "none" },
  },
  export: {
    nodeType: "export",
    title: "导出",
    inputs: [{ port: "video", accept: ["video/*"] }],
    outputs: [],
    params: { preset: { type: "enum", values: ["douyin_vertical", "xhs_vertical", "horizontal_1080p", "square", "master"] } },
    permissions: { network: "none", filesystem: "project_only" },
  },
};

export const NODE_PALETTE_ORDER: NodeType[] = [
  "text",
  "script",
  "storyboard",
  "image",
  "video",
  "audio",
  "video-clip",
  "review",
  "condition",
  "export",
];

/** 连线前端口类型兼容检查：不兼容时返回原因（规格 §7.3，禁止静默失败） */
export function checkPortCompatible(
  accept: string[],
  outputAccept: string[]
): { ok: boolean; reason?: string } {
  if (accept.includes("*/*") || outputAccept.includes("*/*")) return { ok: true };
  for (const a of accept) {
    for (const o of outputAccept) {
      if (a === o) return { ok: true };
      const [aMain, aSub] = a.split("/");
      const [oMain, oSub] = o.split("/");
      if (aMain === oMain && (aSub === "*" || oSub === "*")) return { ok: true };
    }
  }
  return { ok: false, reason: `端口类型不兼容：需要 ${accept.join(" 或 ")}，来源输出 ${outputAccept.join(" 或 ")}` };
}
