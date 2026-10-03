/**
 * OneTV 节点 SDK —— 所有画布节点遵守统一 Node schema（规格 §7.2）。
 * 节点类型注册表：Rust 端 NodeRuntime 与前端 Palette 共用该定义。
 *
 * v2.4.1 连线自由化：输入端口不再限制单一类型/单条入边——
 * 生成类节点（生图/生视频/片段合成）接受「文本 + 图片 + 视频」任意组合，
 * 语义端口名保留（prompt/ref/image 仅为可读性），多源聚合由执行层解释。
 * 旧画布数据（按原端口连接）天然兼容：端口名未变，仅 accept 放宽。
 */
import type { NodeType, NodeTypeDef } from "@onetv/shared-types";

/** 生成类输入端口的统一接受集：任何素材都能作为参考/提示来源 */
const ANY_SOURCE = ["text/*", "image/*", "video/*", "audio/*", "*/*"];

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
      { port: "brief", accept: ANY_SOURCE, multiple: true },
      { port: "bible", accept: ANY_SOURCE, multiple: true },
    ],
    outputs: [{ port: "script", accept: ["application/onetv.script", "text/*"] }],
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
    inputs: [{ port: "script", accept: ANY_SOURCE, multiple: true }],
    outputs: [{ port: "shots", accept: ["application/onetv.shots", "text/*"], multiple: true }],
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
      { port: "prompt", accept: ANY_SOURCE, multiple: true },
      { port: "ref", accept: ANY_SOURCE, multiple: true },
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
    // v2.4.1：prompt 与 image 均接受 文本/图片/视频 混合多条输入
    // —— 多图生视频、多文+多图生视频、图+视频续写 等都合法
    inputs: [
      { port: "prompt", accept: ANY_SOURCE, multiple: true },
      { port: "image", accept: ANY_SOURCE, multiple: true },
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
    inputs: [{ port: "text", accept: ANY_SOURCE, multiple: true }],
    outputs: [{ port: "audio", accept: ["audio/*"] }],
    params: { voice: { type: "string" }, model: { type: "modelRef" } },
    permissions: { network: "provider_only", filesystem: "project_only" },
  },
  "video-clip": {
    nodeType: "video-clip",
    title: "片段合成",
    inputs: [
      { port: "video", accept: ANY_SOURCE, multiple: true },
      { port: "audio", accept: ANY_SOURCE, multiple: true },
    ],
    outputs: [{ port: "video", accept: ["video/*"] }],
    params: { timeline: { type: "timelineRef" }, preset: { type: "string" } },
    permissions: { network: "none", filesystem: "project_only" },
  },
  condition: {
    nodeType: "condition",
    title: "条件分支",
    inputs: [{ port: "in", accept: ["*/*"], multiple: true }],
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
    inputs: [{ port: "in", accept: ["*/*"], multiple: true }],
    outputs: [{ port: "approved", accept: ["*/*"] }],
    params: { note: { type: "string" } },
    permissions: { network: "none", filesystem: "none" },
  },
  export: {
    nodeType: "export",
    title: "导出",
    inputs: [{ port: "video", accept: ANY_SOURCE, multiple: true }],
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

/**
 * 连线前端口类型兼容检查（规格 §7.3，禁止静默失败）。
 * v2.4.1：生成链路的输入端口 accept 已含通配（ANY_SOURCE 含 "* / *"），
 * 实际上不再拒绝任何连线；此处保留 MIME 匹配逻辑供严格端口
 * （如 text 节点只收文本）继续校验。
 */
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
