/**
 * BatchRunPanel —— 画布批量运行进度面板（v2.22 Phase 2）。
 * 运行期间每 2s 拉取画布文档统计 batchStatus（后端每个节点落盘一次）；
 * 失败节点列出标题与原因，「重试失败节点」走现有 resume 语义（非 done 节点自动重跑）。
 */
import { useEffect, useState } from "react";
import type { CanvasNode } from "@onetv/shared-types";
import * as apiCanvas from "../../api-canvas";
import { useT } from "../../i18n";

export interface BatchSummary {
  done: number;
  failed: number;
  skipped: number;
  pending: number;
  total: number;
  failedNodes: { id: string; title: string; note: string }[];
}

export function summarizeBatch(nodes: CanvasNode[]): BatchSummary {
  const s: BatchSummary = { done: 0, failed: 0, skipped: 0, pending: 0, total: nodes.length, failedNodes: [] };
  for (const n of nodes) {
    const st = (n.config as Record<string, unknown>)?.batchStatus;
    if (st === "done") s.done += 1;
    else if (st === "failed") {
      s.failed += 1;
      s.failedNodes.push({ id: n.id, title: n.title, note: String((n.config as Record<string, unknown>)?.batchNote ?? "") });
    } else if (st === "skipped") s.skipped += 1;
    else s.pending += 1;
  }
  return s;
}

interface BatchRunPanelProps {
  open: boolean;
  episodeId: string;
  busy: boolean;
  onClose: () => void;
  onRetry: () => void;
}

export function BatchRunPanel({ open, episodeId, busy, onClose, onRetry }: BatchRunPanelProps) {
  const t = useT();
  const [summary, setSummary] = useState<BatchSummary | null>(null);

  useEffect(() => {
    if (!open) return;
    let alive = true;
    const poll = async () => {
      try {
        const doc = await apiCanvas.canvasGet(episodeId);
        if (alive) setSummary(summarizeBatch(doc.nodes));
      } catch {
        /* 文档暂不可读时下轮再试 */
      }
    };
    void poll();
    const timer = window.setInterval(poll, 2000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, [open, episodeId, busy]);

  if (!open) return null;
  const done = summary?.done ?? 0;
  const failed = summary?.failed ?? 0;
  const skipped = summary?.skipped ?? 0;
  const total = summary?.total ?? 0;
  const processed = done + failed + skipped;
  const pct = total > 0 ? Math.round((processed / total) * 100) : 0;

  return (
    <div className="batch-panel" role="status" aria-label={t("批量运行进度")}>
      <div className="batch-panel-head">
        <b>{busy ? t("▶ 批量运行中…") : t("批量运行已结束")}</b>
        <button className="batch-panel-x" aria-label={t("关闭面板")} onClick={onClose}>✕</button>
      </div>
      <div className="batch-panel-bar">
        <div className="batch-panel-fill" style={{ width: `${pct}%` }} />
      </div>
      <div className="batch-panel-stats">
        {t("{done} 完成 · {failed} 失败 · {skipped} 跳过 · 共 {total}", { done, failed, skipped, total })}
      </div>
      {failed > 0 && (
        <div className="batch-panel-failed">
          {summary!.failedNodes.map((f) => (
            <div key={f.id} className="batch-panel-failed-row" title={f.note}>
              ✗ {f.title}{f.note ? ` — ${f.note}` : ""}
            </div>
          ))}
          <button className="btn sm primary" disabled={busy} onClick={onRetry}>
            {t("↻ 重试失败节点")}
          </button>
        </div>
      )}
      <style>{BATCH_PANEL_CSS}</style>
    </div>
  );
}

const BATCH_PANEL_CSS = `
.batch-panel { position: fixed; left: 232px; bottom: 16px; z-index: 40; width: 300px;
  background: var(--panel, rgba(20,20,28,.92)); border: 1px solid var(--border); border-radius: 12px;
  padding: 10px 12px; font-size: 12.5px; box-shadow: 0 8px 24px rgba(0,0,0,.35); }
.batch-panel-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 6px; }
.batch-panel-x { background: none; border: none; color: var(--muted); cursor: pointer; font-size: 13px; }
.batch-panel-bar { height: 6px; border-radius: 4px; background: var(--border); overflow: hidden; }
.batch-panel-fill { height: 100%; background: linear-gradient(90deg, var(--accent, #d04ad8), var(--accent-2, #7c5cff)); transition: width .4s; }
.batch-panel-stats { margin-top: 6px; color: var(--muted); }
.batch-panel-failed { margin-top: 8px; display: flex; flex-direction: column; gap: 4px; }
.batch-panel-failed-row { color: #ff7b8a; font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
`;
