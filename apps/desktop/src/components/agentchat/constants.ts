/**
 * Agent 对话视图的模块级常量与纯工具（自 views/AgentChatView.tsx 原样迁出）。
 * 仅常量/类型/纯函数，不含组件与副作用。
 */
import { t } from "../../i18n";

export const INTENT_CN: Record<string, string> = {
  chat: "对话",
  "script.generate": "生成剧本",
  "storyboard.generate": "生成分镜",
  "image.generate": "生成图片",
  "video.generate": "生成视频",
  "timeline.compose": "合成成片",
  export: "导出",
  "video.understand": "视频理解",
};

export const RISK_TAG: Record<string, string> = { low: "green", medium: "amber", high: "red" };

/** 附件类型中文标签（后端按扩展名分类：images/videos/audio/references） */
export const KIND_CN: Record<string, string> = {
  image: "图片",
  images: "图片",
  video: "视频",
  videos: "视频",
  audio: "音频",
  other: "文档",
  references: "文档",
};
export const kindCn = (k: string) => KIND_CN[k] ?? "文档";

/** 附件类型图标（chip 与预览标题用） */
export const KIND_ICON: Record<string, string> = {
  image: "🖼️",
  images: "🖼️",
  video: "🎬",
  videos: "🎬",
  audio: "🎵",
  other: "📄",
  references: "📄",
};
export const kindIcon = (k: string) => KIND_ICON[k] ?? "📄";

/** 待发送附件上限 */
export const MAX_ATTACHMENTS = 10;
/** 粘贴导入单文件上限（与后端 agent_attach_data 一致，前端提前提示） */
export const MAX_PASTE_BYTES = 50 * 1024 * 1024;

/** 字节数可读化（预览元信息卡 / 粘贴提示用） */
export const fmtSize = (n: number) => {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
};

/** File → base64（FileReader 读 ArrayBuffer，分块拼接避免 String.fromCharCode 爆栈） */
export const fileToBase64 = (file: File) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(t("读取文件失败")));
    reader.onload = () => {
      const bytes = new Uint8Array(reader.result as ArrayBuffer);
      let binary = "";
      const CHUNK = 0x8000;
      for (let i = 0; i < bytes.length; i += CHUNK) {
        binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
      }
      resolve(btoa(binary));
    };
    reader.readAsArrayBuffer(file);
  });

/** 所选 AI 对话模型（null = 自动：模型页「生成模型设置」的默认模型或自动路由） */
export type AiModelRef = { providerId: string; modelId: string };

/** 下拉选项值编码：providerId 与 modelId 用 "::" 分隔（与模型页 modelOptionValue 一致） */
export const encodeModelOption = (m: AiModelRef) => `${m.providerId}::${m.modelId}`;
export const parseModelOption = (v: string): AiModelRef | null => {
  if (!v) return null;
  const i = v.indexOf("::");
  return i > 0 && i < v.length - 2 ? { providerId: v.slice(0, i), modelId: v.slice(i + 2) } : null;
};

/** 模型选择器数据源：已启用且具备 chat 能力的 Provider（含其 chat 模型） */
export interface ChatProviderOption {
  id: string;
  name: string;
  models: { modelId: string; displayName: string; capabilities: string[] }[];
}

/** 大＋通用条目（链接/@节点/技能/工具） */
export type PendingExtra =
  | { kind: "link"; url: string }
  | { kind: "node"; id: string; title: string; nodeType: string; summary: string }
  | { kind: "skill"; name: string }
  | { kind: "tool"; name: string };

/** 大＋功能菜单面板：null=关闭，root/link/node/skill/tool/plugin=对应面板 */
export type PlusMenuPane = null | "root" | "link" | "node" | "skill" | "tool" | "plugin";

/** 预置工具指令模板（Codex 式：选择即插入输入框，由 Agent 意图路由执行） */
export const TOOL_PRESETS: { name: string; tpl: string }[] = [
  { name: "生成剧本", tpl: "写一集剧本：" },
  { name: "生成分镜", tpl: "把当前剧本拆成分镜" },
  { name: "批量生成分镜图", tpl: "批量生成分镜图" },
  { name: "合成成片", tpl: "按分镜顺序合成成片" },
  { name: "导出竖版", tpl: "导出竖版成片" },
  { name: "生成图片", tpl: "生成图片：" },
  { name: "生成视频镜头", tpl: "生成视频镜头：" },
  { name: "配音（TTS）", tpl: "为台词配音：" },
  { name: "视频理解", tpl: "视频理解：分析这个视频" },
];

/** 斜杠命令（v2.26.29，LibTV 式快捷指令）：输入 "/" 触发菜单；tpl 为空串的为立即执行型 */
export const SLASH_COMMANDS: { cmd: string; name: string; tpl: string; immediate?: "clear" }[] = [
  { cmd: "/剧本", name: "生成剧本", tpl: "写一集剧本：" },
  { cmd: "/图", name: "生成图片", tpl: "生成图片：" },
  { cmd: "/视频", name: "生成视频镜头", tpl: "生成视频镜头：" },
  { cmd: "/分镜", name: "拆分并生成分镜图", tpl: "把当前剧本拆成分镜，并批量生成分镜图" },
  { cmd: "/成片", name: "合成成片", tpl: "按分镜顺序合成成片" },
  { cmd: "/配音", name: "生成配音", tpl: "为当前剧本生成配音" },
  { cmd: "/理解", name: "视频理解", tpl: "视频理解：分析这个视频" },
  { cmd: "/帮助", name: "查看可用命令", tpl: "可用命令：/剧本 /图 /视频 /分镜 /成片 /配音 /理解 /清空。也可以直接用自然语言描述创作需求。" },
  { cmd: "/清空", name: "清空当前会话", tpl: "", immediate: "clear" },
];
