/**
 * 画布顶部工具栏（展示型子组件，从 CanvasView 拆出，DOM/文案不变）：
 * 分集选择 + 新增一集 + 保存 / 撤销 / 重做 + 运行全图 / 恢复运行 / 删除选中 / 适应视图 + 自动保存文案。
 */
import type { EpisodeInfo } from "@onetv/shared-types";
import { useT } from "../../i18n";

export interface CanvasToolbarProps {
  episodes: EpisodeInfo[];
  episodeId: string;
  onSelectEpisode: (id: string) => void;
  onCreateEpisode: () => void;
  creating: boolean;
  saving: boolean;
  onSave: () => void;
  histLen: { u: number; r: number };
  onUndo: () => void;
  onRedo: () => void;
  batchBusy: boolean;
  onRunBatch: () => void;
  onResumeBatch: () => void;
  /** 无选中节点且无选中连线时禁用「删除选中」 */
  deleteDisabled: boolean;
  onDeleteSelection: () => void;
  onFitAll: () => void;
}

export default function CanvasToolbar({
  episodes,
  episodeId,
  onSelectEpisode,
  onCreateEpisode,
  creating,
  saving,
  onSave,
  histLen,
  onUndo,
  onRedo,
  batchBusy,
  onRunBatch,
  onResumeBatch,
  deleteDisabled,
  onDeleteSelection,
  onFitAll,
}: CanvasToolbarProps) {
  const t = useT();

  return (
    <div className="cv-topbar">
      <select
        className="cv-episode-select"
        value={episodeId}
        onChange={(e) => onSelectEpisode(e.target.value)}
        aria-label={t("选择分集")}
      >
        <option value="" disabled>
          {t("选择分集")}
        </option>
        {episodes.map((ep) => (
          <option key={ep.id} value={ep.id}>
            {t("第 {n} 集 · {title}", { n: ep.number, title: ep.title })}
          </option>
        ))}
      </select>
      <button className="btn sm" disabled={creating} onClick={onCreateEpisode}>
        {t("+ 新增一集")}
      </button>

      <div className="cv-vsep" />
      <button className="btn sm primary" disabled={saving || !episodeId} onClick={onSave}>
        {t("💾 保存")}
      </button>
      <button
        className="btn sm"
        disabled={histLen.u === 0}
        onClick={onUndo}
        title={t("撤销 (Ctrl/Cmd+Z)")}
      >
        {t("↩ 撤销")}
      </button>
      <button
        className="btn sm"
        disabled={histLen.r === 0}
        onClick={onRedo}
        title={t("重做 (Ctrl/Cmd+Shift+Z)")}
      >
        {t("↪ 重做")}
      </button>

      <div className="cv-vsep" />
      <button
        className="btn sm"
        disabled={batchBusy}
        title={t("按拓扑顺序执行全图：生成节点逐个运行，条件节点自动分支，审核节点暂停等待批准")}
        onClick={onRunBatch}
      >
        {batchBusy ? t("⏳ 运行中…") : t("▶ 运行全图")}
      </button>
      <button
        className="btn sm"
        disabled={batchBusy}
        title={t("从中断处恢复（已完成的节点自动跳过）")}
        onClick={onResumeBatch}
      >
        {t("↻ 恢复运行")}
      </button>
      <button
        className="btn sm danger"
        disabled={deleteDisabled}
        onClick={onDeleteSelection}
      >
        {t("🗑 删除选中")}
      </button>
      <button className="btn sm" onClick={onFitAll}>
        {t("⤢ 适应视图")}
      </button>

      <div className="spacer" />
      <span className="pill ok" title={t("位置 / 连线 / 参数变化后 800ms 自动保存")}>
        {t("自动保存已开启")}
      </span>
      {saving && <span className="pill">{t("保存中…")}</span>}
    </div>
  );
}
