/**
 * canvasSend —— Agent 对话产物 → 画布（v2.26.29，LibTV 式"对话直接驱动画布"）：
 * - autoDropAssetsToCanvas：产物消息到达后自动在当前项目第一个分集画布上建产物节点；
 * - sendAssetsToCanvas：AssetCard「加入画布」按钮的手动路径（同逻辑，带 toast 反馈）。
 * 节点类型按资产 kind 映射（images→image / videos→video / audio→audio），
 * config.outputAssetId/outputAssetPath 与 CanvasNodeCard 产物缩略图展示契约对齐（v2.26.27）。
 * 落盘后派发 window CustomEvent("onetv:canvas-external")，画布视图监听后重载文档。
 */
import * as api from "./api";
import { assetList } from "./api-assets";
import { canvasGet, canvasSave } from "./api-canvas";
import type { ChatMsgAsset } from "./agentChatStore";
import { SCHEMA_VERSION, type CanvasNode } from "@onetv/shared-types";
import { isVideoMediaPath } from "./components/canvas/canvas-model";

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

/** 当前画布正在浏览的分集 id（CanvasView/useCanvasDoc 切换分集时写入） */
export const CANVAS_CURRENT_EPISODE_KEY = "onetv-canvas-current-episode";

/**
 * 把产物资产追加为画布节点（返回成功加入的数量）。
 * episodeId 不传时优先取画布当前正在浏览的分集（v2.26.112，否则产物落到第一个分集的
 * 画布上、用户在当前画布"看不到"）；无记录时回退当前项目第一个分集；
 * 已存在同 outputAssetId 的节点则跳过（防重复落卡）。
 */
export async function sendAssetsToCanvas(
  assets: ChatMsgAsset[],
  opts?: { episodeId?: string; silent?: boolean; toast?: (t: string, k?: "ok" | "err" | "warn") => void }
): Promise<number> {
  if (!Array.isArray(assets) || assets.length === 0) return 0;
  let episodeId = opts?.episodeId;
  if (!episodeId) {
    try {
      episodeId = localStorage.getItem(CANVAS_CURRENT_EPISODE_KEY) || undefined;
    } catch { /* localStorage 不可用时忽略 */ }
  }
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

/** 画布节点生成产物节点 id（确定性 = 幂等键，同一任务永不重复落节点） */
export const canvasOutputNodeId = (jobId: string) => `genout-${jobId}`;

/** job:succeeded 事件负载中画布回填所需的子集（job_public） */
export interface JobPublicLite {
  id?: string;
  kind?: string;
  title?: string;
  state?: string;
  nodeId?: string | null;
  episodeId?: string | null;
  outputs?: string[];
}

/**
 * 画布节点生成任务的终态回填（v2.26.157，修复"生成中切走视图 → 回来画布什么都没有"）：
 * 产物回填此前只存在于节点卡片内的轮询 effect——用户切到 Agent 对话/任务页时卡片卸载，
 * 轮询随之中止；任务在后台完成，canvas.json 里永远没有产物节点（只在任务/对话里可见）。
 * 本函数直接在 canvas.json 上操作（不依赖任何视图挂载）：
 *  1) 定位 config.generateJobId === job.id 的源节点（或 job.nodeId 指定的节点）；
 *  2) 回填 outputAssetId/outputAssetPath/status；
 *  3) 追加独立产物节点（id = genout-<jobId>，已存在则跳过）；
 *  4) 落盘并派发画布外部变更事件（挂载中的画布随即刷新上屏）。
 * 返回是否发生了写入。
 */
export async function reconcileCanvasJobOutput(job: JobPublicLite): Promise<boolean> {
  const jobId = job?.id;
  const nodeId = job?.nodeId || "";
  const outAsset = (job?.outputs ?? [])[0];
  if (!jobId || !nodeId || !outAsset) return false;
  try {
    // 分集：优先 job.episodeId，回退画布当前浏览分集
    let episodeId = job.episodeId || "";
    if (!episodeId) {
      try { episodeId = localStorage.getItem(CANVAS_CURRENT_EPISODE_KEY) || ""; } catch { /* ignore */ }
    }
    if (!episodeId) return false;
    const doc = await canvasGet(episodeId);
    const nodes = Array.isArray(doc?.nodes) ? doc.nodes : [];
    const edges = Array.isArray(doc?.edges) ? doc.edges : [];
    const target = nodes.find((n) => n?.id === nodeId);
    if (!target) return false; // 节点已被删除/画布重建 → 不补
    const cfg = (target as CanvasNode).config ?? {};
    if (cfg.outputAssetId === outAsset) return false; // 已被卡内轮询回填 → 幂等跳过
    const list = await assetList().catch(() => []);
    const hit = list.find((a) => a.id === outAsset);
    const path = hit?.path ?? "";
    const outNodeId = canvasOutputNodeId(jobId);
    const already = nodes.some((n) => n?.id === outNodeId);
    let nextNodes: typeof nodes = nodes.map((n) =>
      n?.id === nodeId
        ? {
            ...n,
            config: {
              ...((n as CanvasNode).config ?? {}),
              outputAssetId: outAsset,
              outputAssetPath: path,
              status: "ready",
              generateJobId: null,
              generateError: null,
              batchStatus: "done",
              batchNote: "生成完成（产物已自动回填）",
            },
          }
        : n
    );
    if (!already && path) {
      const isVideo = isVideoMediaPath(path);
      const maxX = nodes.reduce((m, n) => Math.max(m, n?.position?.x ?? 0), 0);
      nextNodes = [
        ...nextNodes,
        {
          id: outNodeId,
          episodeId,
          type: isVideo ? "video" : "image",
          title: ((path.split("/").pop() || outAsset).slice(0, 24)),
          config: { status: "ready", outputAssetId: outAsset, outputAssetPath: path },
          position: { x: maxX + 140, y: (target.position?.y ?? 0) + 40 },
        } satisfies CanvasNode,
      ];
    }
    await canvasSave(episodeId, {
      schemaVersion: doc?.schemaVersion ?? SCHEMA_VERSION,
      episodeId,
      nodes: nextNodes,
      edges,
      updatedAt: new Date().toISOString(),
    });
    window.dispatchEvent(new CustomEvent(CANVAS_EXTERNAL_EVENT, { detail: { episodeId } }));
    return true;
  } catch {
    return false;
  }
}
