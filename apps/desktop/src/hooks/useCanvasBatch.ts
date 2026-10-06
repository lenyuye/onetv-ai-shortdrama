/**
 * useCanvasBatch —— 画布批量运行（v2.14）hook：
 * 拓扑执行全图；review 暂停后可批准并恢复。完成后重新拉取文档回填画布。
 */
import { useState } from "react";
import type { CanvasDocument } from "@onetv/shared-types";
import * as api from "../api";
// canvasRunBatch 由 apiCanvas 提供（v2.14）
import * as apiCanvas from "../api-canvas";
import { useT } from "../i18n";
import { useApp } from "../store";

export function useCanvasBatch(episodeId: string, applyDoc: (doc: CanvasDocument) => void) {
  const t = useT();
  const { toast } = useApp();
  const [batchBusy, setBatchBusy] = useState(false);
  const [batchPanelOpen, setBatchPanelOpen] = useState(false);

  const runBatch = async (resume = false) => {
    if (batchBusy) return;
    if (!episodeId) {
      toast(t("请先打开项目并选择分集"), "warn");
      return;
    }
    setBatchBusy(true);
    setBatchPanelOpen(true);
    toast(resume ? t("批次恢复运行中…") : t("画布批量运行中（生成节点会逐个等待完成）…"), "info");
    try {
      const r = await apiCanvas.canvasRunBatch(episodeId, resume);
      if (r.paused) {
        toast(t("批次在「人工审核」节点暂停（已完成 {done}/{total}）——选中该节点后可在检查器批准继续", { done: r.completed, total: r.total }), "warn");
      } else {
        toast(t("批量运行完成：{done} 个节点执行，{skipped} 个跳过", { done: r.completed, skipped: r.skipped }), "ok");
      }
      const doc = await apiCanvas.canvasGet(episodeId);
      applyDoc(doc);
    } catch (e) {
      toast(t("批量运行失败：{msg}（已完成节点已保留，可点「恢复运行」继续）", { msg: api.errMsg(e) }), "err");
      const doc = await apiCanvas.canvasGet(episodeId).catch(() => null);
      if (doc) applyDoc(doc);
    } finally {
      setBatchBusy(false);
    }
  };

  return { batchBusy, runBatch, batchPanelOpen, setBatchPanelOpen };
}
