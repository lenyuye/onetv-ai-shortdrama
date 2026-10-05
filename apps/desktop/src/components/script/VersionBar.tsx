/**
 * 剧本库多版本管理条（副标题下方、场景列表上方；自 views/ScriptView.tsx 原样迁出）。
 * 列出各版本（来源 tag / 时间 / 场景数），支持使用 / 复制副本 / 删除 / 上传 / 新建。
 */
import { useT } from "../../i18n";
import type { ScriptVersion, ScriptVersionSource } from "../../hooks/useScriptVersions";

const VERSION_SOURCE_META: Record<ScriptVersionSource, { label: string; cls: string }> = {
  ai: { label: "AI生成", cls: "blue" },
  upload: { label: "上传", cls: "green" },
  paste: { label: "粘贴", cls: "amber" },
  copy: { label: "副本", cls: "pink" },
};

function fmtTime(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString("zh-CN", { hour12: false });
}

interface VersionBarProps {
  versions: ScriptVersion[];
  activeId: string | null;
  saving: boolean;
  onUpload: () => void;
  onNew: () => void;
  onUse: (id: string) => void;
  onDuplicate: (id: string) => void;
  onDelete: (id: string) => void;
}

export function VersionBar({
  versions,
  activeId,
  saving,
  onUpload,
  onNew,
  onUse,
  onDuplicate,
  onDelete,
}: VersionBarProps) {
  const t = useT();
  return (
    <div className="card script-lib">
      <div className="script-lib-head">
        <span className="script-lib-name">{t("📚 剧本库")}</span>
        <span className="script-lib-hint">{t("编辑内容仅作用于「使用中」的版本")}</span>
        <span style={{ flex: 1 }} />
        <button className="btn sm" disabled={saving} onClick={onUpload}>
          {t("⬆️ 上传剧本")}
        </button>
        <button className="btn sm" disabled={saving} onClick={onNew}>
          {t("🆕 新建剧本")}
        </button>
      </div>
      <div className="script-lib-list">
        {versions.map((v) => {
          const meta = VERSION_SOURCE_META[v.source] ?? VERSION_SOURCE_META.ai;
          const isActive = v.id === activeId;
          return (
            <div key={v.id} className={`script-lib-row${isActive ? " active" : ""}`}>
              <span className="script-lib-title" title={v.title}>{v.title}</span>
              <span className={`tag ${meta.cls}`}>{t(meta.label)}</span>
              <span className="script-lib-time">{fmtTime(v.createdAt)}</span>
              <span className="tag">{t("{n} 场", { n: v.scenes.length })}</span>
              <span style={{ flex: 1 }} />
              {isActive ? (
                <span className="tag green">{t("使用中")}</span>
              ) : (
                <button className="btn sm" disabled={saving} onClick={() => onUse(v.id)}>
                  {t("使用")}
                </button>
              )}
              <button className="btn sm" disabled={saving} onClick={() => onDuplicate(v.id)}>
                {t("复制副本")}
              </button>
              <button className="btn sm danger" disabled={saving} onClick={() => onDelete(v.id)}>
                {t("删除")}
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}
