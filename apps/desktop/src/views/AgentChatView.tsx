/**
 * Agent 对话视图 —— 自然语言驱动创作：对话流 + 结构化计划卡 + 批准/拒绝。
 * chat 意图低风险自动执行并回显模型回复；创作意图先出计划，批准后入任务队列。
 * 输入框为 Codex 式整体容器：参考 chip 行 + textarea + 工具行（＋添加参考 / 发送），
 * 支持拖拽导入与粘贴文件导入（FileReader → base64 → agent_attach_data）。
 */
import { useEffect, useRef, useState, type ClipboardEvent as ReactClipboardEvent } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import * as api from "../api";
import { assetUrl } from "../api-assets";
import * as story from "../api-story";
import { canvasGet } from "../api-canvas";
import { skill_list } from "../api-extras";
import { errMsg } from "../api-story";
import { useApp } from "../store";

interface ChatMsg {
  id: string;
  role: "user" | "assistant" | "system";
  text: string;
  plan?: {
    planId: string;
    intent: string;
    summary: string;
    risk: string;
    remoteCalls: number;
    steps: { id: string; tool: string; description: string; approval: string }[];
    /** 低风险自动执行的计划：不显示批准/拒绝按钮 */
    auto?: boolean;
    /** 批准/拒绝后置位：按钮消失，状态不再自相矛盾 */
    decided?: "approved" | "rejected";
  };
  time: string;
}

const INTENT_CN: Record<string, string> = {
  chat: "对话",
  "script.generate": "生成剧本",
  "storyboard.generate": "生成分镜",
  "image.generate": "生成图片",
  "video.generate": "生成视频",
  "timeline.compose": "合成成片",
  export: "导出",
  "video.understand": "视频理解",
};

const RISK_TAG: Record<string, string> = { low: "green", medium: "amber", high: "red" };

/** 附件类型中文标签（后端按扩展名分类：images/videos/audio/references） */
const KIND_CN: Record<string, string> = {
  image: "图片",
  images: "图片",
  video: "视频",
  videos: "视频",
  audio: "音频",
  other: "文档",
  references: "文档",
};
const kindCn = (k: string) => KIND_CN[k] ?? "文档";

/** 附件类型图标（chip 与预览标题用） */
const KIND_ICON: Record<string, string> = {
  image: "🖼️",
  images: "🖼️",
  video: "🎬",
  videos: "🎬",
  audio: "🎵",
  other: "📄",
  references: "📄",
};
const kindIcon = (k: string) => KIND_ICON[k] ?? "📄";

/** 待发送附件上限 */
const MAX_ATTACHMENTS = 10;
/** 粘贴导入单文件上限（与后端 agent_attach_data 一致，前端提前提示） */
const MAX_PASTE_BYTES = 50 * 1024 * 1024;

/** 字节数可读化（预览元信息卡 / 粘贴提示用） */
const fmtSize = (n: number) => {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
};

/** File → base64（FileReader 读 ArrayBuffer，分块拼接避免 String.fromCharCode 爆栈） */
const fileToBase64 = (file: File) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("读取文件失败"));
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

/** Codex 式输入框 scoped 样式：整体容器 + 附件 chip 行 + 工具行 + 预览弹窗内元素 */
const AGENT_CSS = `
.agent-input-shell {
  display: flex; flex-direction: column; gap: 8px;
  background: var(--panel-2); border: 1px solid var(--border-strong);
  border-radius: 12px; padding: 10px 12px;
  transition: border-color .15s ease, box-shadow .15s ease, background .15s ease;
}
.agent-input-shell:focus-within {
  border-color: var(--blue); box-shadow: 0 0 0 2px rgba(77, 124, 254, 0.18);
}
.agent-input-shell.drag {
  border-color: var(--blue); box-shadow: 0 0 0 2px rgba(77, 124, 254, 0.35);
  background: var(--blue-soft);
}
.agent-chip-row { display: flex; flex-wrap: wrap; gap: 6px; }
.agent-chip {
  display: inline-flex; align-items: center; gap: 6px;
  max-width: 320px; padding: 3px 6px 3px 9px;
  background: rgba(255, 255, 255, 0.06); border: 1px solid var(--border);
  border-radius: 999px; font-size: 11.5px; color: var(--text);
}
.agent-chip-icon { flex-shrink: 0; font-size: 12px; line-height: 1; }
.agent-chip-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.agent-chip-actions { display: inline-flex; align-items: center; gap: 1px; flex-shrink: 0; }
.agent-chip-actions button {
  background: none; border: none; cursor: pointer;
  color: var(--muted); font-size: 11px; line-height: 1.4;
  padding: 1px 5px; border-radius: 4px; font-family: var(--font);
}
.agent-chip-actions button:hover { color: var(--text); background: rgba(255, 255, 255, 0.1); }
.agent-chip-actions button.agent-chip-remove:hover { color: var(--red); background: rgba(255, 84, 112, 0.12); }
.agent-input-shell textarea {
  width: 100%; min-height: 52px; padding: 2px 2px 0;
  background: transparent; border: none; outline: none;
  color: var(--text); font-size: 12.5px; resize: none;
}
.agent-input-shell textarea:focus { border: none; box-shadow: none; }
.agent-input-toolbar { display: flex; align-items: center; gap: 8px; }
.agent-attach-count { font-size: 11px; color: var(--muted); }
.agent-toolbar-sep { width: 1px; height: 20px; background: var(--border-strong); margin: 0 4px; flex-shrink: 0; }
.agent-attach-hint { font-size: 11px; color: var(--muted); }
.agent-link-ic {
  background: none; border: none; cursor: pointer;
  font-size: 15px; line-height: 1; padding: 3px 4px; border-radius: 6px;
  color: var(--blue);
}
.agent-link-ic:hover { color: var(--text); background: rgba(120, 140, 255, 0.12); }
.agent-link-ic:disabled { opacity: 0.4; cursor: default; }
.agent-plus-plain {
  background: none; border: none; cursor: pointer;
  font-size: 17px; line-height: 1; padding: 2px 6px; border-radius: 6px;
  color: var(--muted);
}
.agent-plus-plain:hover { color: var(--blue); background: rgba(120, 140, 255, 0.1); }
.agent-plus-plain.active { color: var(--blue); background: rgba(120, 140, 255, 0.14); }
.agent-plus-plain:disabled { opacity: 0.4; cursor: default; }
.agent-plus-btn.active { border-color: var(--blue); color: var(--blue); }
.agent-plus-menu {
  position: absolute; right: 0; bottom: calc(100% + 10px);
  width: 300px; max-height: 380px; overflow: auto;
  background: var(--panel-2); border: 1px solid var(--border-strong);
  border-radius: 12px; box-shadow: 0 10px 34px rgba(0, 0, 0, 0.4);
  padding: 8px; z-index: 60;
  display: flex; flex-direction: column; gap: 2px;
}
.agent-plus-head { font-size: 11.5px; color: var(--muted); padding: 4px 8px 6px; }
.agent-plus-item {
  display: flex; align-items: center; gap: 9px;
  background: none; border: none; cursor: pointer; text-align: left;
  color: var(--text); font-size: 12.5px; font-family: var(--font);
  padding: 8px 10px; border-radius: 8px; width: 100%;
}
.agent-plus-item:hover { background: rgba(120, 140, 255, 0.12); }
.agent-plus-item.disabled { opacity: 0.45; cursor: default; }
.agent-plus-item.disabled:hover { background: none; }
.agent-plus-item em { margin-left: auto; font-style: normal; font-size: 10.5px; color: var(--muted); }
.agent-plus-sep { height: 1px; background: var(--border); margin: 4px 6px; }
.agent-plus-input {
  width: 100%; margin: 2px 0 6px;
  background: var(--bg-deep); border: 1px solid var(--border-strong);
  border-radius: 8px; padding: 8px 10px; color: var(--text); font-size: 12.5px;
}
.agent-plus-input:focus { outline: none; border-color: var(--blue); }
.agent-plus-actions { display: flex; justify-content: flex-end; gap: 8px; padding: 4px 6px 2px; }
.agent-plus-list { display: flex; flex-direction: column; gap: 2px; max-height: 240px; overflow: auto; }
.agent-plus-empty { font-size: 12px; color: var(--muted); padding: 14px 10px; text-align: center; }
.agent-preview-text {
  margin: 0; max-height: 52vh; overflow-y: auto;
  font-family: var(--mono); font-size: 12px; line-height: 1.5;
  white-space: pre-wrap; word-break: break-all;
  background: var(--bg-deep); border: 1px solid var(--border);
  border-radius: var(--radius-sm); padding: 10px 12px;
}
.agent-preview-img {
  display: block; max-width: 100%; max-height: 56vh;
  margin: 0 auto; border-radius: var(--radius-sm);
}
.agent-preview-meta { display: flex; flex-direction: column; gap: 8px; font-size: 12.5px; }
.agent-preview-meta > div { display: flex; gap: 10px; align-items: flex-start; }
.agent-preview-meta > div > span:first-child {
  color: var(--muted); flex-shrink: 0; width: 42px; text-align: right;
}
.agent-preview-meta > div > span:last-child { word-break: break-all; user-select: text; }
`;

/** 所选 AI 对话模型（null = 自动：模型页「生成模型设置」的默认模型或自动路由） */
type AiModelRef = { providerId: string; modelId: string };

/** 下拉选项值编码：providerId 与 modelId 用 "::" 分隔（与模型页 modelOptionValue 一致） */
const encodeModelOption = (m: AiModelRef) => `${m.providerId}::${m.modelId}`;
const parseModelOption = (v: string): AiModelRef | null => {
  if (!v) return null;
  const i = v.indexOf("::");
  return i > 0 && i < v.length - 2 ? { providerId: v.slice(0, i), modelId: v.slice(i + 2) } : null;
};

/** 模型选择器数据源：已启用且具备 chat 能力的 Provider（含其 chat 模型） */
interface ChatProviderOption {
  id: string;
  name: string;
  models: { modelId: string; displayName: string; capabilities: string[] }[];
}

/** 大＋通用条目（链接/@节点/技能/工具） */
type PendingExtra =
  | { kind: "link"; url: string }
  | { kind: "node"; id: string; title: string; nodeType: string; summary: string }
  | { kind: "skill"; name: string }
  | { kind: "tool"; name: string };

/** 预置工具指令模板（Codex 式：选择即插入输入框，由 Agent 意图路由执行） */
const TOOL_PRESETS: { name: string; tpl: string }[] = [
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

function uid() {
  return Math.random().toString(36).slice(2, 10);
}

export default function AgentChatView() {
  const { project, toast } = useApp();
  const [msgs, setMsgs] = useState<ChatMsg[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [approving, setApproving] = useState<string | null>(null);
  const [attachments, setAttachments] = useState<api.AgentAttachment[]>([]);
  /** 大＋的通用条目：链接 / @画布节点 / 技能 / 工具（与文件参考共同计入上限） */
  const [extras, setExtras] = useState<PendingExtra[]>([]);
  /** 大＋功能菜单：null=关闭，root/link/node/skill/tool=对应面板 */
  const [plusMenu, setPlusMenu] = useState<null | "root" | "link" | "node" | "skill" | "tool">(null);
  const [linkInput, setLinkInput] = useState("");
  const [canvasNodes, setCanvasNodes] = useState<{ id: string; title: string; type: string; summary: string }[]>([]);
  const [skillNames, setSkillNames] = useState<string[]>([]);
  const totalPending = attachments.length + extras.length;
  const addExtra = (it: PendingExtra) => {
    if (totalPending >= MAX_ATTACHMENTS) { toast(`参考最多 ${MAX_ATTACHMENTS} 个，请先移除部分条目`, "err"); return false; }
    setExtras((x) => [...x, it]);
    return true;
  };
  const [aiModel, setAiModel] = useState<AiModelRef | null>(null);
  const [chatProviders, setChatProviders] = useState<ChatProviderOption[]>([]);
  /** 拖拽悬停态：enter/over 时容器加高亮边框 */
  const [dragOver, setDragOver] = useState(false);
  /** 附件预览弹窗（查看操作） */
  const [preview, setPreview] = useState<api.AgentAttachment | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  /** 拖拽/粘贴导入时的实时计数镜像（避免事件回调闭包读到过期 attachments） */
  const attachmentsRef = useRef(attachments);
  useEffect(() => {
    attachmentsRef.current = attachments;
  }, [attachments]);

  // 大＋菜单数据源：画布节点（全部分集）与已安装技能
  const loadCanvasNodes = async () => {
    try {
      const eps = await api.episodeList();
      const out: { id: string; title: string; type: string; summary: string }[] = [];
      for (const ep of eps) {
        try {
          const doc = await canvasGet(ep.id);
          for (const n of (doc as { nodes?: { id: string; title: string; type: string; config?: Record<string, unknown> }[] }).nodes ?? []) {
            // 显式提取节点产物与参考资产 id：绑定后 Agent 可直接调用节点中的参考图/视频
            const cfg = n.config ?? {};
            const outId = typeof cfg.outputAssetId === "string" ? cfg.outputAssetId : "";
            const refIds = Array.isArray(cfg.referenceAssetIds)
              ? cfg.referenceAssetIds.filter((x): x is string => typeof x === "string" && x !== "")
              : [];
            const assetNote = [
              outId ? `产物资产=${outId}` : "",
              refIds.length > 0 ? `参考资产=${refIds.join(",")}` : "",
            ]
              .filter(Boolean)
              .join("；");
            const cfgSummary = Object.entries(cfg)
              .filter(([k]) => k !== "outputAssetId" && k !== "referenceAssetIds")
              .filter(([, v]) => (typeof v === "string" ? v : JSON.stringify(v ?? "")) !== "")
              .slice(0, 2)
              .map(([k, v]) => `${k}=${typeof v === "string" ? v.slice(0, 12) : JSON.stringify(v)?.slice(0, 12)}`)
              .join(" · ");
            out.push({
              id: n.id,
              title: n.title || n.id,
              type: n.type,
              summary: [assetNote, cfgSummary].filter(Boolean).join("；"),
            });
          }
        } catch { /* 单集失败继续 */ }
      }
      setCanvasNodes(out);
    } catch (e) {
      toast(`读取画布节点失败：${errMsg(e)}`, "err");
    }
  };

  const loadSkills = async () => {
    try {
      const list = await skill_list();
      setSkillNames(list.map((x) => x.name));
    } catch (e) {
      toast(`读取技能失败：${errMsg(e)}`, "err");
    }
  };

  // 大＋菜单：点击外部 / Esc 关闭（与小＋完全独立，互不触发）
  const plusRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!plusMenu) return;
    const onDown = (e: MouseEvent) => {
      if (plusRef.current && !plusRef.current.contains(e.target as Node)) setPlusMenu(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setPlusMenu(null);
    };
    window.addEventListener("mousedown", onDown, true);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("keydown", onKey);
    };
  }, [plusMenu]);

  // 模型选择器数据源：一次拉取 Provider 列表并缓存（只留已启用 + 含 chat 能力模型的 Provider）
  useEffect(() => {
    let cancelled = false;
    api
      .providerList()
      .then((list) => {
        if (cancelled) return;
        setChatProviders(
          list
            .filter((p) => p.enabled && p.models.some((m) => m.capabilities.includes("chat")))
            .map((p) => ({
              id: p.id,
              name: p.name,
              models: p.models.filter((m) => m.capabilities.includes("chat")),
            }))
        );
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const unlisteners: Promise<unknown>[] = [
      api.onAppEvent<{ text: string }>("agent.message", (p) => {
        if (p?.text) {
          setMsgs((m) => [
            ...m,
            { id: uid(), role: "assistant", text: p.text, time: new Date().toLocaleTimeString() },
          ]);
        }
      }),
    ];
    return () => {
      unlisteners.forEach((u) => u.then((f) => (f as () => void)()).catch(() => {}));
    };
  }, []);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [msgs.length]);

  // 拖拽导入：enter/over 高亮容器，drop 逐个按路径导入（仅打开项目后生效）
  useEffect(() => {
    if (!project) return;
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    const importDropped = async (paths: string[]) => {
      let overflow = false;
      for (const p of paths) {
        if (attachmentsRef.current.length >= MAX_ATTACHMENTS) {
          overflow = true;
          break;
        }
        try {
          const att = await api.agentAttachPath(p);
          if (attachmentsRef.current.length >= MAX_ATTACHMENTS) {
            overflow = true;
            break;
          }
          attachmentsRef.current = [...attachmentsRef.current, att];
          setAttachments((a) => (a.length >= MAX_ATTACHMENTS ? a : [...a, att]));
        } catch (e) {
          toast(`拖拽导入失败：${api.errMsg(e)}`, "err");
        }
      }
      if (overflow) toast(`参考最多 ${MAX_ATTACHMENTS} 个，超出部分已忽略`, "err");
    };
    getCurrentWebview()
      .onDragDropEvent((ev) => {
        if (ev.payload.type === "enter" || ev.payload.type === "over") {
          setDragOver(true);
        } else if (ev.payload.type === "leave") {
          setDragOver(false);
        } else if (ev.payload.type === "drop") {
          setDragOver(false);
          void importDropped(ev.payload.paths);
        }
      })
      .then((u) => {
        if (cancelled) u();
        else unlisten = u;
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [project, toast]);

  if (!project) {
    return (
      <div className="empty-state" style={{ height: "100%" }}>
        <div className="big">🤖</div>
        <h2>Agent 对话</h2>
        <p>请先在「工作区」创建或打开一个项目</p>
        <button className="btn primary" onClick={() => useApp.getState().setView("home")}>
          前往工作区
        </button>
      </div>
    );
  }

  const addAttachment = async () => {
    if (busy) return;
    if (totalPending >= MAX_ATTACHMENTS) {
      toast(`参考最多 ${MAX_ATTACHMENTS} 个，请先移除部分条目`, "err");
      return;
    }
    try {
      const att = await api.agentAttach();
      setAttachments((a) => (a.length >= MAX_ATTACHMENTS ? a : [...a, att]));
    } catch (e) {
      const msg = api.errMsg(e);
      // 用户取消文件选择：静默处理，不弹提示
      if (msg.includes("已取消")) return;
      toast(`参考导入失败：${msg}`, "err");
    }
  };

  /** chip「打开」：系统默认应用打开（即编辑入口） */
  const openAsset = async (a: api.AgentAttachment) => {
    try {
      await api.assetOpen(a.path);
    } catch (e) {
      const msg = api.errMsg(e);
      if (msg.includes("已取消")) return;
      toast(`打开参考失败：${msg}`, "err");
    }
  };

  /** chip「Finder」：在 Finder 中显示 */
  const revealAsset = async (a: api.AgentAttachment) => {
    try {
      await api.assetReveal(a.path);
    } catch (e) {
      const msg = api.errMsg(e);
      if (msg.includes("已取消")) return;
      toast(`在 Finder 中显示失败：${msg}`, "err");
    }
  };

  /** 粘贴文件导入：File 对象在 WKWebView 拿不到磁盘路径，读 ArrayBuffer → base64 → 后端落盘导入 */
  const pasteFiles = async (files: File[]) => {
    let overflow = false;
    for (const file of files) {
      if (attachmentsRef.current.length >= MAX_ATTACHMENTS) {
        overflow = true;
        break;
      }
      if (file.size > MAX_PASTE_BYTES) {
        toast(`「${file.name}」超过 50MB 上限，无法作为参考粘贴`, "err");
        continue;
      }
      try {
        const dataB64 = await fileToBase64(file);
        const att = await api.agentAttachData({ name: file.name, dataB64 });
        if (attachmentsRef.current.length >= MAX_ATTACHMENTS) {
          overflow = true;
          break;
        }
        attachmentsRef.current = [...attachmentsRef.current, att];
        setAttachments((a) => (a.length >= MAX_ATTACHMENTS ? a : [...a, att]));
      } catch (e) {
        toast(`粘贴参考导入失败：${api.errMsg(e)}`, "err");
      }
    }
    if (overflow) toast(`参考最多 ${MAX_ATTACHMENTS} 个，超出部分已忽略`, "err");
  };

  /** 有文件时走附件导入链路，纯文本粘贴保持默认行为 */
  const handlePaste = (e: ReactClipboardEvent<HTMLTextAreaElement>) => {
    const files = Array.from(e.clipboardData?.files ?? []);
    if (files.length === 0) return;
    e.preventDefault();
    void pasteFiles(files);
  };

  const removeAttachment = (index: number) => {
    setAttachments((a) => a.filter((_, i) => i !== index));
  };

  const send = async () => {
    const text = input.trim();
    if (busy || (!text && attachments.length === 0 && extras.length === 0)) return;
    // 气泡显示：原文 + 每个条目一行标记（不塞入 4000 字预览正文）
    const bubbleParts: string[] = [];
    if (text) bubbleParts.push(text);
    attachments.forEach((a) => bubbleParts.push(`[参考：${a.name}（${kindCn(a.kind)}）]`));
    extras.forEach((x) => {
      if (x.kind === "link") bubbleParts.push(`🔗 链接：${x.url}`);
      else if (x.kind === "node") bubbleParts.push(`@${x.title}`);
      else if (x.kind === "skill") bubbleParts.push(`🧩 技能：${x.name}`);
      else bubbleParts.push(`🛠️ 工具：${x.name}`);
    });
    // 发给 LLM 的完整文本：原文在前，每个条目追加说明，文本类再追加内容预览
    const sendParts: string[] = [];
    if (text) sendParts.push(text);
    attachments.forEach((a) => {
      let part = `[参考：${a.name}（${kindCn(a.kind)}，已存入项目资产库 assetId=${a.assetId}）]`;
      if (a.textPreview) part += `\n--- 文件内容（预览）---\n${a.textPreview}\n--- 预览结束 ---`;
      sendParts.push(part);
    });
    extras.forEach((x) => {
      if (x.kind === "link") sendParts.push(`[链接：${x.url}]`);
      else if (x.kind === "node") sendParts.push(`[绑定画布节点：${x.title}（类型：${x.nodeType}，id=${x.id}${x.summary ? `；配置：${x.summary}` : ""}）]`);
      else if (x.kind === "skill") sendParts.push(`[调用技能：${x.name}]`);
      else sendParts.push(`[调用工具：${x.name}]`);
    });
    setInput("");
    setAttachments([]);
    setExtras([]);
    setMsgs((m) => [
      ...m,
      { id: uid(), role: "user", text: bubbleParts.join("\n"), time: new Date().toLocaleTimeString() },
    ]);
    setBusy(true);
    try {
      const r = await story.agentChat(sendParts.join("\n\n"), aiModel);
      setMsgs((m) => [
        ...m,
        {
          id: uid(),
          role: "assistant",
          text: r.autoExecuted
            ? `已自动执行：${r.plan.summary}（低风险任务自动运行，回复稍后显示在下方）`
            : r.plan.summary,
          plan: {
            planId: r.plan.planId,
            intent: r.plan.intent,
            summary: r.plan.summary,
            risk: String(r.plan.estimated?.risk ?? "low"),
            remoteCalls: Number(r.plan.estimated?.remoteCalls ?? 0),
            steps: r.plan.steps ?? [],
            auto: !!r.autoExecuted,
          },
          time: new Date().toLocaleTimeString(),
        },
      ]);
      if (r.autoExecuted) {
        toast("对话任务已自动执行（Mock/本地模型不出公网）", "ok");
      }
    } catch (e) {
      setMsgs((m) => [
        ...m,
        { id: uid(), role: "system", text: `⚠️ ${story.errMsg(e)}`, time: new Date().toLocaleTimeString() },
      ]);
    } finally {
      setBusy(false);
    }
  };

  const approve = async (planId: string) => {
    setApproving(planId);
    try {
      const ids = await story.agentApprove(planId);
      toast(`已批准，创建了 ${ids.length} 个任务（可在「任务」页查看进度）`, "ok");
      setMsgs((m) =>
        m.map((msg) => {
          if (msg.plan?.planId !== planId) return msg;
          const plan = { ...msg.plan!, decided: "approved" as const };
          return { ...msg, plan, text: `${msg.text}\n\n✅ 已批准执行 → 任务 ${ids.length} 个已进入队列` };
        })
      );
    } catch (e) {
      toast(`批准失败：${story.errMsg(e)}`, "err");
    } finally {
      setApproving(null);
    }
  };

  const reject = (planId: string) => {
    setMsgs((m) =>
      m.map((msg) => {
        if (msg.plan?.planId !== planId) return msg;
        const plan = { ...msg.plan!, decided: "rejected" as const };
        return { ...msg, plan, text: `${msg.text}\n\n❌ 已拒绝（未创建任何任务）` };
      })
    );
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <div className="page-header" style={{ padding: "14px 22px 0", marginBottom: 0 }}>
        <div>
          <h1 style={{ fontSize: 16 }}>🤖 Agent 对话</h1>
          <div className="desc">
            例如：「写第一集剧本」「把剧本拆成分镜」「按分镜顺序合成成片」—— 高风险操作会先出计划由你批准
          </div>
        </div>
      </div>

      <div ref={scrollRef} style={{ flex: 1, overflowY: "auto", padding: "14px 22px", minHeight: 0 }}>
        {msgs.length === 0 && (
          <div className="card hint" style={{ maxWidth: 640 }}>
            和 Agent 聊聊你的短剧想法。它会先给出<b>结构化执行计划</b>（做什么、调多少次远程 API、风险等级），
            你批准后才会真正执行 —— 全程可审计。对话类问题直接回答；生图/生视频任务会进入任务队列。
          </div>
        )}
        {msgs.map((m) => (
          <div
            key={m.id}
            style={{
              display: "flex",
              justifyContent: m.role === "user" ? "flex-end" : "flex-start",
              marginBottom: 12,
            }}
          >
            <div
              style={{
                maxWidth: "78%",
                background: m.role === "user" ? "var(--panel-3)" : "var(--panel-2)",
                border: `1px solid ${m.role === "system" ? "rgba(255,181,71,.4)" : "var(--border)"}`,
                borderRadius: 10,
                padding: "10px 14px",
                whiteSpace: "pre-wrap",
                fontSize: 12.5,
              }}
            >
              <div style={{ fontSize: 10, color: "var(--muted)", marginBottom: 4 }}>
                {m.role === "user" ? "我" : m.role === "system" ? "系统" : "Agent"} · {m.time}
              </div>
              {m.text}
              {m.plan && (
                <div style={{ marginTop: 10, borderTop: "1px solid var(--border)", paddingTop: 10 }}>
                  <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 8 }}>
                    <span className="tag blue">{INTENT_CN[m.plan.intent] ?? m.plan.intent}</span>
                    <span className={`tag ${RISK_TAG[m.plan.risk] ?? ""}`}>
                      {m.plan.risk === "low" ? "低风险" : m.plan.risk === "medium" ? "中风险" : "高风险"}
                    </span>
                    <span className="tag">远程调用 {m.plan.remoteCalls}</span>
                  </div>
                  {m.plan.steps.map((s, i) => (
                    <div key={s.id} style={{ fontSize: 11.5, color: "var(--text-dim)", marginBottom: 3 }}>
                      {i + 1}. <span className="tag" style={{ marginRight: 4 }}>{s.tool}</span>
                      {s.description}
                      {s.approval === "required" && <span className="tag red" style={{ marginLeft: 6 }}>需批准</span>}
                    </div>
                  ))}
                  <div style={{ marginTop: 10, display: "flex", gap: 8 }}>
                    {m.plan.auto ? (
                      <span className="tag blue">低风险 · 已自动执行</span>
                    ) : m.plan.decided === "approved" ? (
                      <span className="tag" style={{ color: "#35d07f" }}>✅ 已批准执行</span>
                    ) : m.plan.decided === "rejected" ? (
                      <span className="tag red">已拒绝</span>
                    ) : (
                      <>
                        <button
                          className="btn primary sm"
                          disabled={approving === m.plan?.planId}
                          onClick={() => m.plan && approve(m.plan.planId)}
                        >
                          {approving === m.plan?.planId ? "批准中…" : "✓ 批准执行"}
                        </button>
                        <button className="btn sm" onClick={() => m.plan && reject(m.plan.planId)}>✕ 拒绝</button>
                      </>
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>
        ))}
      </div>

      <div style={{ padding: "10px 22px 14px", borderTop: "1px solid var(--border)" }}>
        {/* 模型选择器：输入区上方一行，与参考/发送按钮同一区域 */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "flex-end",
            gap: 8,
            flexWrap: "wrap",
            marginBottom: 8,
          }}
        >
          <label style={{ fontSize: 12, color: "var(--muted)" }}>AI 模型</label>
          <select
            value={aiModel ? encodeModelOption(aiModel) : ""}
            disabled={busy}
            aria-label="选择 AI 模型"
            style={{ minWidth: 220 }}
            onChange={(e) => setAiModel(parseModelOption(e.target.value))}
          >
            <option value="">自动（默认模型/自动路由）</option>
            {chatProviders.map((p) => (
              <optgroup key={p.id} label={p.name}>
                {p.models.map((m, i) => (
                  <option key={`${m.modelId}-${i}`} value={encodeModelOption({ providerId: p.id, modelId: m.modelId })}>
                    {p.name} · {m.modelId}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
          {chatProviders.length === 0 && (
            <span style={{ fontSize: 11, color: "var(--muted)" }}>未配置可用对话模型，将使用离线 Mock</span>
          )}
        </div>
        <style>{AGENT_CSS}</style>
        {/* Codex 式输入容器：参考 chip 行 + textarea + 工具行（＋添加参考 / 发送） */}
        <div className={`agent-input-shell${dragOver ? " drag" : ""}`}>
          {totalPending > 0 && (
            <div className="agent-chip-row">
              {attachments.map((a, i) => (
                <span
                  key={`${a.assetId}-${i}`}
                  className="agent-chip"
                  title={`${kindCn(a.kind)} · ${fmtSize(a.sizeBytes)}\n${a.path}`}
                >
                  <span className="agent-chip-icon">{kindIcon(a.kind)}</span>
                  <span className="agent-chip-name">{a.name}</span>
                  <span className="agent-chip-actions">
                    <button title="查看" onClick={() => setPreview(a)}>
                      查看
                    </button>
                    <button title="用系统默认应用打开（可编辑）" onClick={() => void openAsset(a)}>
                      打开
                    </button>
                    <button title="在 Finder 中显示" onClick={() => void revealAsset(a)}>
                      Finder
                    </button>
                    <button
                      className="agent-chip-remove"
                      title="移除参考（不影响已导入的资产）"
                      onClick={() => removeAttachment(i)}
                    >
                      ×
                    </button>
                  </span>
                </span>
              ))}
              {extras.map((x, i) => (
                <span key={`x-${i}`} className="agent-chip" title={x.kind === "link" ? x.url : x.kind === "node" ? `画布节点 ${x.id}` : x.kind === "skill" ? "调用技能" : "调用工具"}>
                  <span className="agent-chip-icon">{x.kind === "link" ? "🔗" : x.kind === "node" ? "⚓" : x.kind === "skill" ? "🧩" : "🛠️"}</span>
                  <span className="agent-chip-name">
                    {x.kind === "link" ? x.url : x.kind === "node" ? `@${x.title}` : x.kind === "skill" ? `技能：${x.name}` : `工具：${x.name}`}
                  </span>
                  <span className="agent-chip-actions">
                    <button
                      className="agent-chip-remove"
                      title="移除"
                      onClick={() => setExtras((xs) => xs.filter((_, j) => j !== i))}
                    >
                      ×
                    </button>
                  </span>
                </span>
              ))}
            </div>
          )}
          <textarea
            placeholder="输入消息：例如「写一集都市情感短剧」或「把当前剧本拆成分镜」…（支持拖入或粘贴文件作为参考）"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onPaste={handlePaste}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void send();
              }
            }}
          />
          <div className="agent-input-toolbar" style={{ position: "relative" }} ref={plusRef}>
            <span className="agent-attach-count" style={{ marginRight: "auto" }}>
              {totalPending > 0 && `参考 ${totalPending}/${MAX_ATTACHMENTS}`}
            </span>
            {/* 大＋（右下独立）：通用功能菜单（Codex 式）——任意格式上传 / 链接 / @画布节点 / 技能 / 工具 / 插件 */}
            <button
              className={`agent-plus-plain${plusMenu ? " active" : ""}`}
              disabled={busy}
              title="通用上传与调用：文件 / 链接 / @画布节点 / 技能 / 工具 / 插件"
              onClick={() => setPlusMenu((v) => (v ? null : "root"))}
            >
              ＋
            </button>
            {/* 分隔线：大＋（功能菜单）与 🔗（添加参考）分属两组 */}
            <span className="agent-toolbar-sep" />
            {/* 🔗 添加参考：全格式资料，严格参考规则 → 项目资产库供生成引用 */}
            <button
              className="agent-link-ic"
              disabled={busy}
              title="添加参考：图片/视频/音频/文本/文件等全格式资料（严格参考规则，自动存入项目资产库供生成引用）"
              onClick={addAttachment}
            >
              🔗
            </button>
            {plusMenu && (
              <div className="agent-plus-menu">
                {plusMenu === "root" && (
                  <>
                    <div className="agent-plus-head">通用上传与调用</div>
                    <button className="agent-plus-item" onClick={() => { setPlusMenu(null); void addAttachment(); }}>
                      <span>📎</span>上传文件…（任意格式）
                    </button>
                    <button className="agent-plus-item" onClick={() => setPlusMenu("link")}>
                      <span>🔗</span>添加链接…
                    </button>
                    <button className="agent-plus-item" onClick={() => { void loadCanvasNodes(); setPlusMenu("node"); }}>
                      <span>⚓</span>@绑定画布节点…
                    </button>
                    <button className="agent-plus-item" onClick={() => { void loadSkills(); setPlusMenu("skill"); }}>
                      <span>🧩</span>调用技能…
                    </button>
                    <button className="agent-plus-item" onClick={() => setPlusMenu("tool")}>
                      <span>🛠️</span>调用工具…
                    </button>
                    <div className="agent-plus-sep" />
                    <div className="agent-plus-item disabled" title="插件系统将在后续版本提供">
                      <span>🧩</span>插件（暂无可用插件）
                    </div>
                  </>
                )}
                {plusMenu === "link" && (
                  <>
                    <div className="agent-plus-head">🔗 添加链接</div>
                    <input
                      className="agent-plus-input"
                      autoFocus
                      placeholder="粘贴 https://… 链接后回车"
                      value={linkInput}
                      onChange={(e) => setLinkInput(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" && linkInput.trim()) {
                          if (addExtra({ kind: "link", url: linkInput.trim() })) setLinkInput("");
                          setPlusMenu("root");
                        }
                        if (e.key === "Escape") setPlusMenu("root");
                      }}
                    />
                    <div className="agent-plus-actions">
                      <button className="btn sm" onClick={() => setPlusMenu("root")}>返回</button>
                      <button
                        className="btn sm primary"
                        disabled={!linkInput.trim()}
                        onClick={() => {
                          if (addExtra({ kind: "link", url: linkInput.trim() })) setLinkInput("");
                          setPlusMenu("root");
                        }}
                      >
                        添加
                      </button>
                    </div>
                  </>
                )}
                {plusMenu === "node" && (
                  <>
                    <div className="agent-plus-head">⚓ @绑定画布节点</div>
                    <div className="agent-plus-list">
                      {canvasNodes.length === 0 ? (
                        <div className="agent-plus-empty">画布中还没有节点——去「画布」页新建后即可绑定</div>
                      ) : (
                        canvasNodes.map((n) => (
                          <button
                            key={n.id}
                            className="agent-plus-item"
                            title={n.summary || n.id}
                            onClick={() => {
                              if (addExtra({ kind: "node", id: n.id, title: n.title, nodeType: n.type, summary: n.summary }))
                                setPlusMenu("root");
                            }}
                          >
                            <span>⚓</span>@{n.title || n.id}
                            <em>{n.type}</em>
                          </button>
                        ))
                      )}
                    </div>
                    <div className="agent-plus-actions">
                      <button className="btn sm" onClick={() => setPlusMenu("root")}>返回</button>
                    </div>
                  </>
                )}
                {plusMenu === "skill" && (
                  <>
                    <div className="agent-plus-head">🧩 调用技能</div>
                    <div className="agent-plus-list">
                      {skillNames.length === 0 ? (
                        <div className="agent-plus-empty">暂无已安装技能——去「Skills」页安装</div>
                      ) : (
                        skillNames.map((n) => (
                          <button
                            key={n}
                            className="agent-plus-item"
                            onClick={() => {
                              if (addExtra({ kind: "skill", name: n })) setPlusMenu("root");
                            }}
                          >
                            <span>🧩</span>{n}
                          </button>
                        ))
                      )}
                    </div>
                    <div className="agent-plus-actions">
                      <button className="btn sm" onClick={() => setPlusMenu("root")}>返回</button>
                    </div>
                  </>
                )}
                {plusMenu === "tool" && (
                  <>
                    <div className="agent-plus-head">🛠️ 调用工具（选择后插入指令模板）</div>
                    <div className="agent-plus-list">
                      {TOOL_PRESETS.map((t) => (
                        <button
                          key={t.name}
                          className="agent-plus-item"
                          onClick={() => {
                            setInput((v) => (v && !v.endsWith(" ") ? `${v} ${t.tpl}` : v + t.tpl));
                            setPlusMenu(null);
                          }}
                        >
                          <span>🛠️</span>{t.name}
                        </button>
                      ))}
                    </div>
                    <div className="agent-plus-actions">
                      <button className="btn sm" onClick={() => setPlusMenu("root")}>返回</button>
                    </div>
                  </>
                )}
              </div>
            )}
            <button
              className="btn primary"
              disabled={busy || (!input.trim() && attachments.length === 0 && extras.length === 0)}
              onClick={send}
            >
              {busy ? "思考中…" : "发送"}
            </button>
          </div>
        </div>
      </div>

      {/* 附件预览弹窗：文本显示内容预览，图片走 onetv-asset 协议，其他显示元信息卡 */}
      {preview && (
        <div className="modal-overlay" onClick={() => setPreview(null)}>
          <div
            className="modal"
            style={{ width: "min(680px, 92vw)" }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="modal-head">
              <span>
                {kindIcon(preview.kind)} 参考预览 · {preview.name}
              </span>
              <button className="btn sm" onClick={() => setPreview(null)}>
                关闭
              </button>
            </div>
            <div className="modal-body">
              {preview.textPreview ? (
                <pre className="agent-preview-text">{preview.textPreview}</pre>
              ) : preview.kind === "images" ? (
                <img className="agent-preview-img" src={assetUrl(preview.path)} alt={preview.name} />
              ) : (
                <div className="agent-preview-meta">
                  <div>
                    <span>名称</span>
                    <span>{preview.name}</span>
                  </div>
                  <div>
                    <span>类型</span>
                    <span>
                      {kindCn(preview.kind)}（{preview.mime || "未知 MIME"}）
                    </span>
                  </div>
                  <div>
                    <span>大小</span>
                    <span>{fmtSize(preview.sizeBytes)}</span>
                  </div>
                  <div>
                    <span>路径</span>
                    <span>{preview.path}</span>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
