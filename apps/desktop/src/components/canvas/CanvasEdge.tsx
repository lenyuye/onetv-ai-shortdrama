/**
 * 画布连线（v2.26.27，即梦式）：贝塞尔连线 + hover 出现在中点的 × 删除按钮。
 * 删除经 EdgeDeleteContext 注入画布既有 deleteEdgeById（含撤销快照与自动保存）。
 */
import { createContext, useContext, useState } from "react";
import { BaseEdge, EdgeLabelRenderer, getBezierPath } from "@xyflow/react";
import type { EdgeProps } from "@xyflow/react";
import { useT } from "../../i18n";

/** 连线删除回调上下文（CanvasFlowArea 注入画布的 deleteEdgeById） */
export const EdgeDeleteContext = createContext<(edgeId: string) => void>(() => {});

export default function CanvasEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
}: EdgeProps) {
  const t = useT();
  const onDelete = useContext(EdgeDeleteContext);
  const [hover, setHover] = useState(false);
  const [path, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
  });
  return (
    <>
      <BaseEdge id={id} path={path} interactionWidth={22} />
      {/* hover 感知层：宽透明路径，鼠标进入即显示删除按钮 */}
      <path
        d={path}
        fill="none"
        stroke="transparent"
        strokeWidth={16}
        style={{ pointerEvents: "stroke" }}
        onPointerEnter={() => setHover(true)}
        onPointerLeave={() => setHover(false)}
      />
      {hover && (
        <EdgeLabelRenderer>
          <button
            className="cv-edge-del"
            style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
            title={t("删除连线")}
            onPointerEnter={() => setHover(true)}
            onClick={(e) => {
              e.stopPropagation();
              onDelete(id);
            }}
            onMouseDown={(e) => e.stopPropagation()}
          >
            ×
          </button>
        </EdgeLabelRenderer>
      )}
    </>
  );
}
