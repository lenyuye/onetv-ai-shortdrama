/**
 * useCanvasClipboard —— 画布内部剪贴板 hook（从 CanvasView 拆出，逻辑不变）：
 * 节点完整数据 + 相对偏移 + 内部连线关系；支持多选节点整体复制并在粘贴时
 * 按原始相对位置排列（粘贴节点生成新 id，内部连线重映射）。
 */
import { useCallback, useRef, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import type { Edge } from "@xyflow/react";
import type { CanvasNode } from "@onetv/shared-types";
import { useT } from "../i18n";
import { useApp } from "../store";
import { uid, type FlowNode } from "../components/canvas/canvas-model";

export function useCanvasClipboard(opts: {
  nodesRef: { current: FlowNode[] };
  edgesRef: { current: Edge[] };
  episodeIdRef: { current: string };
  pushUndo: () => void;
  setNodes: Dispatch<SetStateAction<FlowNode[]>>;
  setEdges: Dispatch<SetStateAction<Edge[]>>;
  scheduleSave: () => void;
}) {
  const t = useT();
  const { toast } = useApp();
  const { nodesRef, edgesRef, episodeIdRef, pushUndo, setNodes, setEdges, scheduleSave } = opts;

  /** 内部剪贴板：节点完整数据 + 相对偏移 + 内部连线关系。 */
  const clipboardRef = useRef<{
    nodes: { cn: CanvasNode; dx: number; dy: number }[];
    edges: {
      source: string;
      target: string;
      sourceHandle: string | null;
      targetHandle: string | null;
    }[];
  } | null>(null);
  const [clipboardHasData, setClipboardHasData] = useState(false);

  /** 复制节点进剪贴板：优先取全部选中节点，否则取指定节点；记录相对偏移与内部连线。 */
  const copyNodesToClipboard = useCallback(
    (explicitNodeId?: string) => {
      let targets = nodesRef.current.filter((n) => n.selected);
      if (!targets.length && explicitNodeId) {
        const hit = nodesRef.current.find((n) => n.id === explicitNodeId);
        if (hit) targets = [hit];
      }
      if (!targets.length) return;
      const minX = Math.min(...targets.map((n) => n.position.x));
      const minY = Math.min(...targets.map((n) => n.position.y));
      const idSet = new Set(targets.map((n) => n.id));
      clipboardRef.current = {
        nodes: targets.map((n) => ({
          cn: JSON.parse(JSON.stringify(n.data.cn)) as CanvasNode,
          dx: n.position.x - minX,
          dy: n.position.y - minY,
        })),
        edges: edgesRef.current
          .filter((e) => idSet.has(e.source) && idSet.has(e.target))
          .map((e) => ({
            source: e.source,
            target: e.target,
            sourceHandle: e.sourceHandle ?? null,
            targetHandle: e.targetHandle ?? null,
          })),
      };
      setClipboardHasData(true);
      toast(t("已复制 {count} 个节点", { count: targets.length }), "ok");
    },
    [toast]
  );

  /** 在 flow 坐标处粘贴：生成新 id（与现有 uid 格式一致），多节点按原始相对位置排列。 */
  const pasteFromClipboard = useCallback(
    (flowPos: { x: number; y: number }) => {
      const clip = clipboardRef.current;
      const ep = episodeIdRef.current;
      if (!clip || clip.nodes.length === 0 || !ep) return;
      pushUndo();
      const idMap = new Map<string, string>();
      const newNodes: FlowNode[] = clip.nodes.map((it) => {
        const newId = uid();
        idMap.set(it.cn.id, newId);
        const pos = { x: flowPos.x + it.dx, y: flowPos.y + it.dy };
        return {
          id: newId,
          type: "onetv",
          position: pos,
          data: {
            cn: { ...it.cn, id: newId, episodeId: ep, position: { ...pos } },
          },
          selected: true,
        };
      });
      const newEdges: Edge[] = clip.edges
        .filter((e) => idMap.has(e.source) && idMap.has(e.target))
        .map((e) => ({
          id: `e-${uid("c")}`,
          source: idMap.get(e.source) ?? e.source,
          target: idMap.get(e.target) ?? e.target,
          sourceHandle: e.sourceHandle,
          targetHandle: e.targetHandle,
        }));
      setNodes((ns) => [...ns.map((n) => ({ ...n, selected: false })), ...newNodes]);
      if (newEdges.length) setEdges((es) => [...es, ...newEdges]);
      scheduleSave();
      toast(t("已粘贴 {count} 个节点", { count: newNodes.length }), "ok");
    },
    [pushUndo, setNodes, setEdges, scheduleSave, toast]
  );

  return { clipboardHasData, copyNodesToClipboard, pasteFromClipboard };
}
