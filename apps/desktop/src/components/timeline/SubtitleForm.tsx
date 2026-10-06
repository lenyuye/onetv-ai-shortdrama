/**
 * 字幕内联添加小表单(字幕轨头部「+ 添加」展开):text + start + duration → 追加字幕 clip。
 */
import { useState } from "react";
import { useT } from "../../i18n";
import { MIN_CLIP_DURATION, snap01 } from "./timeline-model";

interface SubtitleFormProps {
  /** 默认起点 = 字幕轨末尾 */
  defaultStart: number;
  onAdd: (text: string, start: number, duration: number) => void;
  onCancel: () => void;
}

export default function SubtitleForm({ defaultStart, onAdd, onCancel }: SubtitleFormProps) {
  const t = useT();
  const [text, setText] = useState("");
  const [start, setStart] = useState(String(snap01(defaultStart)));
  const [duration, setDuration] = useState("3");

  const submit = () => {
    const trimmed = text.trim();
    const s = Number(start);
    const d = Number(duration);
    if (!trimmed) return;
    onAdd(trimmed, Number.isFinite(s) && s >= 0 ? snap01(s) : 0, Number.isFinite(d) ? Math.max(MIN_CLIP_DURATION, snap01(d)) : MIN_CLIP_DURATION);
  };

  return (
    <div className="tl-row tl-sub-form">
      <div className="tl-rowhead">
        <div className="tl-trackmeta">
          <span className="tl-trackname">{t("新增字幕")}</span>
        </div>
      </div>
      <div className="tl-sub-form-body">
        <span className="tl-sub-form-label">{t("文本")}</span>
        <input
          type="text"
          value={text}
          autoFocus
          placeholder={t("字幕内容…")}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") submit();
            if (e.key === "Escape") onCancel();
          }}
        />
        <span className="tl-sub-form-label">{t("开始（秒）")}</span>
        <input type="number" min={0} step={0.1} value={start} onChange={(e) => setStart(e.target.value)} />
        <span className="tl-sub-form-label">{t("时长（秒）")}</span>
        <input type="number" min={MIN_CLIP_DURATION} step={0.1} value={duration} onChange={(e) => setDuration(e.target.value)} />
        <button className="btn sm primary" disabled={!text.trim()} onClick={submit}>
          {t("添加")}
        </button>
        <button className="btn sm ghost" onClick={onCancel}>
          {t("取消")}
        </button>
      </div>
    </div>
  );
}
