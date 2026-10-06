/**
 * 时间标尺 —— 与泳道同宽的刻度行,粘在滚动容器顶部。
 * 步长随缩放自适应:pxPerSec ≥ 80 → 1s,≥ 30 → 2s,否则 5s。
 */
import { useT } from "../../i18n";
import { fmtTime } from "./timeline-model";

interface RulerProps {
  pxPerSec: number;
  /** 标尺刻度覆盖的总秒数(不含尾部预留) */
  totalSec: number;
  /** 内容区宽度(px,与泳道一致,含尾部预留) */
  contentWidth: number;
}

export default function Ruler({ pxPerSec, totalSec, contentWidth }: RulerProps) {
  const t = useT();
  const step = pxPerSec >= 80 ? 1 : pxPerSec >= 30 ? 2 : 5;
  const ticks: number[] = [];
  for (let s = 0; s <= totalSec; s += step) ticks.push(s);
  return (
    <div className="tl-row tl-ruler-row">
      <div className="tl-rowhead tl-ruler-head">{t("时间")}</div>
      <div className="tl-ruler" style={{ width: contentWidth }}>
        {ticks.map((s) => (
          <div key={s} className="tl-tick" style={{ left: s * pxPerSec }}>
            {fmtTime(s)}
          </div>
        ))}
      </div>
    </div>
  );
}
