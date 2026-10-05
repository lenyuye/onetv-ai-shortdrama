/**
 * Agent 对话附件逻辑 hook：文件参考列表、拖拽导入（webview onDragDropEvent）、
 * 粘贴导入（File → base64 → agent_attach_data）、chip 打开/Finder/移除。
 * 自 views/AgentChatView.tsx 原样迁出；行为与原实现一一对应（含 attachmentsRef 实时镜像）。
 */
import { useEffect, useRef, useState, type ClipboardEvent as ReactClipboardEvent } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import * as api from "../api";
import { useT } from "../i18n";
import { MAX_ATTACHMENTS, MAX_PASTE_BYTES, fileToBase64 } from "../components/agentchat/constants";

interface UseAgentAttachmentsParams {
  /** 项目是否已打开（未打开时不挂拖拽监听） */
  hasProject: boolean;
  toast: (text: string, kind?: "ok" | "err") => void;
}

export function useAgentAttachments({ hasProject, toast }: UseAgentAttachmentsParams) {
  const t = useT();
  const [attachments, setAttachments] = useState<api.AgentAttachment[]>([]);
  /** 拖拽/粘贴导入时的实时计数镜像（避免事件回调闭包读到过期 attachments） */
  const attachmentsRef = useRef(attachments);
  useEffect(() => {
    attachmentsRef.current = attachments;
  }, [attachments]);
  /** 拖拽悬停态：enter/over 时容器加高亮边框 */
  const [dragOver, setDragOver] = useState(false);

  // 拖拽导入：enter/over 高亮容器，drop 逐个按路径导入（仅打开项目后生效）
  useEffect(() => {
    if (!hasProject) return;
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
          toast(t("拖拽导入失败：{msg}", { msg: api.errMsg(e) }), "err");
        }
      }
      if (overflow) toast(t("参考最多 {max} 个，超出部分已忽略", { max: MAX_ATTACHMENTS }), "err");
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasProject, toast]);

  /** 文件选择导入（小＋/大＋共用）：用户取消时静默 */
  const addAttachment = async () => {
    if (attachmentsRef.current.length >= MAX_ATTACHMENTS) {
      toast(t("参考最多 {max} 个，请先移除部分条目", { max: MAX_ATTACHMENTS }), "err");
      return;
    }
    try {
      const att = await api.agentAttach();
      setAttachments((a) => (a.length >= MAX_ATTACHMENTS ? a : [...a, att]));
    } catch (e) {
      const msg = api.errMsg(e);
      if (msg.includes("已取消")) return;
      toast(t("参考导入失败：{msg}", { msg }), "err");
    }
  };

  /** chip「打开」：系统默认应用打开（即编辑入口） */
  const openAsset = async (a: api.AgentAttachment) => {
    try {
      await api.assetOpen(a.path);
    } catch (e) {
      const msg = api.errMsg(e);
      if (msg.includes("已取消")) return;
      toast(t("打开参考失败：{msg}", { msg }), "err");
    }
  };

  /** chip「Finder」：在 Finder 中显示 */
  const revealAsset = async (a: api.AgentAttachment) => {
    try {
      await api.assetReveal(a.path);
    } catch (e) {
      const msg = api.errMsg(e);
      if (msg.includes("已取消")) return;
      toast(t("在 Finder 中显示失败：{msg}", { msg }), "err");
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
        toast(t("「{name}」超过 50MB 上限，无法作为参考粘贴", { name: file.name }), "err");
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
        toast(t("粘贴参考导入失败：{msg}", { msg: api.errMsg(e) }), "err");
      }
    }
    if (overflow) toast(t("参考最多 {max} 个，超出部分已忽略", { max: MAX_ATTACHMENTS }), "err");
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

  return {
    attachments,
    setAttachments,
    attachmentsRef,
    dragOver,
    addAttachment,
    openAsset,
    revealAsset,
    pasteFiles,
    handlePaste,
    removeAttachment,
  };
}
