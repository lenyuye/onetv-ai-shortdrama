/**
 * 分集选择 + 主操作条（AI 生成 / 编辑开关 / 保存；自 views/ScriptView.tsx 原样迁出）。
 */
import type { EpisodeInfo } from "@onetv/shared-types";
import { useT } from "../../i18n";

interface EpisodeBarProps {
  episodes: EpisodeInfo[];
  episodeId: string;
  onEpisodeChange: (id: string) => void;
  hasScript: boolean;
  editing: boolean;
  saving: boolean;
  loading: boolean;
  onOpenAi: () => void;
  onToggleEditing: () => void;
  onSave: () => void;
}

export function EpisodeBar({
  episodes,
  episodeId,
  onEpisodeChange,
  hasScript,
  editing,
  saving,
  loading,
  onOpenAi,
  onToggleEditing,
  onSave,
}: EpisodeBarProps) {
  const t = useT();
  return (
    <div className="script-toolbar">
      <select
        value={episodeId}
        onChange={(e) => onEpisodeChange(e.target.value)}
        aria-label={t("选择分集")}
      >
        {episodes.map((ep) => (
          <option key={ep.id} value={ep.id}>
            {t("第 {n} 集 · {title}", { n: ep.number, title: ep.title })}
          </option>
        ))}
      </select>
      <button className="btn primary" onClick={onOpenAi}>{t("✨ AI 生成剧本")}</button>
      {hasScript && (
        <button className={`btn ${editing ? "" : "ghost"}`} onClick={onToggleEditing}>
          {editing ? t("✓ 完成编辑") : t("✏️ 编辑")}
        </button>
      )}
      <button className="btn blue" disabled={!hasScript || saving || loading} onClick={onSave}>
        {saving ? t("保存中…") : t("💾 保存剧本")}
      </button>
    </div>
  );
}
