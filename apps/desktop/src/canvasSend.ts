/**
 * canvasSend —— Agent 对话产物 → 画布（v2.26.29，LibTV 式"对话直接驱动画布"）：
 * - autoDropAssetsToCanvas：产物消息到达后自动在当前项目第一个分集画布上建产物节点；
 * - sendAssetsToCanvas：AssetCard「加入画布」按钮的手动路径（同逻辑，带 toast 反馈）。
 * 节点类型按资产 kind 映射（images→image / videos→video / audio→audio），
 * config.outputAssetId/outputAssetPath 与 CanvasNodeCard 产物缩略图展示契约对齐（v2.26.27）。
 * 落盘后派发 window CustomEvent("onetv:canvas-external")，画布视图监听后重载文档。
 */
import * as api from "./api";
import { canvasGet, canvasSave } from "./api-canvas";
import type { ChatMsgAsset } from "./agentChatStore";
import { SCHEMA_VERSION, type CanvasNode } from "@onetv/shared-types";

/** 画布文档外部变更事件名（useCanvasDoc 监听重载） */
export const CANVAS_EXTERNAL_EVENT = "onetv:canvas-external";

function nodeTypeForKind(kind: string): "image" | "video" | "audio" | "asset" {
  if (kind === "images") return "image";
  if (kind === "videos") return "video";
  if (kind === "audio") return "audio";
  return "asset";
}

function titleForAsset(a: ChatMsgAsset): string {
  const base = (a.name || a.assetId).replace(/\.[^.]+$/, "");
  return base.length > 24 ? `${base.slice(0, 24)}…` : base;
}

/**
 * 把产物资产追加为画布节点（返回成功加入的数量）。
 * episodeId 不传时取当前项目第一个分集；已存在同 outputAssetId 的节点则跳过（防重复落卡）。
 */
export async function sendAssetsToCanvas(
  assets: ChatMsgAsset[],
  opts?: { episodeId?: string; silent?: boolean; toast?: (t: string, k?: "ok" | "err" | "warn") => void }
): Promise<number> {
  if (!Array.isArray(assets) || assets.length === 0) return 0;
  let episodeId = opts?.episodeId;
  if (!episodeId) {
    try {
      const eps = await api.episodeList();
      episodeId = eps[0]?.id;
    } catch {
      /* 未打开项目等场景：静默放弃 */
    }
  }
  if (!episodeId) {
    if (!opts?.silent) opts?.toast?.("未找到可用分集，产物未能加入画布", "warn");
    return 0;
  }
  try {
    const doc = await canvasGet(episodeId);
    const nodes = Array.isArray(doc?.nodes) ? doc.nodes : [];
    const edges = Array.isArray(doc?.edges) ? doc.edges : [];
    const existing = new Set(
      nodes
        .map((n) => {
          const cfg = (n as CanvasNode | undefined)?.config;
          return typeof cfg?.outputAssetId === "string" ? cfg.outputAssetId : "";
        })
        .filter(Boolean)
    );
    // 摆放：从现有节点右侧空白区开始向右下错开，避免压住已有节点
    const maxX = nodes.reduce((m, n) => Math.max(m, n?.position?.x ?? 0), 0);
    const maxY = nodes.reduce((m, n) => Math.max(m, n?.position?.y ?? 0), 0);
    let added = 0;
    const nextNodes = [...nodes];
    for (const a of assets) {
      if (!a?.assetId || existing.has(a.assetId)) continue;
      const idx = added;
      nextNodes.push({
        id: `agn-${Date.now().toString(36)}-${idx}-${Math.random().toString(36).slice(2, 6)}`,
        episodeId,
        type: nodeTypeForKind(a.kind ?? ""),
        title: titleForAsset(a),
        config: {
          status: "ready",
          outputAssetId: a.assetId,
          outputAssetPath: a.path,
        },
        position: { x: maxX + 80 + idx * 36, y: maxY + 40 + idx * 30 },
      } satisfies CanvasNode);
      added++;
    }
    if (added === 0) {
      if (!opts?.silent) opts?.toast?.("产物已在画布上，未重复添加", "warn");
      return 0;
    }
    await canvasSave(episodeId, {
      schemaVersion: doc?.schemaVersion ?? SCHEMA_VERSION,
      episodeId,
      nodes: nextNodes,
      edges,
      updatedAt: new Date().toISOString(),
    });
    window.dispatchEvent(new CustomEvent(CANVAS_EXTERNAL_EVENT, { detail: { episodeId } }));
    if (!opts?.silent) opts?.toast?.(`已把 ${added} 个产物加入画布`, "ok");
    return added;
  } catch (e) {
    if (!opts?.silent) opts?.toast?.(`加入画布失败：${String(e)}`, "err");
    return 0;
  }
}

/** 产物消息自动落画布（事件桥调用；静默失败不打扰对话） */
export function autoDropAssetsToCanvas(assets: ChatMsgAsset[]) {
  void sendAssetsToCanvas(assets, { silent: true });
}
