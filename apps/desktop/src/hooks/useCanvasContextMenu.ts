/**
 * useCanvasContextMenu —— 画布右键菜单状态 hook（从 CanvasView 拆出，逻辑不变）：
 * - 画布空白处 / 节点 / 连线 三种菜单的打开与坐标夹取；
 * - 菜单打开期间点击外部 / Escape 关闭。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { Dispatch, MouseEvent as ReactMouseEvent, SetStateAction } from "react";
import { useReactFlow } from "@xyflow/react";
import type { Edge } from "@xyflow/react";
import type { FlowNode } from "../components/canvas/canvas-model";

export interface CtxMenuState {
  kind: "pane" | "node" | "edge";
  x: number; // 菜单显示坐标（已夹取到视口内）
  y: number;
  screen: { x: number; y: number }; // 弹出时的鼠标屏幕坐标（新建节点定位）
  flow: { x: number; y: number }; // 对应的画布 flow 坐标（粘贴定位）
  nodeId?: string; // kind === "node"
  edgeId?: string; // kind === "edge"
}

/** 把菜单坐标夹取到视口内，避免溢出屏幕（高度按菜单类型估算）。 */
function clampCtxMenuPos(x: number, y: number, kind: CtxMenuState["kind"]) {
  const w = 200;
  const h = kind === "pane" ? 400 : kind === "node" ? 140 : 64;
  return {
    x: Math.max(4, Math.min(x, window.innerWidth - w - 8)),
    y: Math.max(4, Math.min(y, window.innerHeight - h - 8)),
  };
}

export function useCanvasContextMenu(opts: {
  nodesRef: { current: FlowNode[] };
  setNodes: Dispatch<SetStateAction<FlowNode[]>>;
  setEdges: Dispatch<SetStateAction<Edge[]>>;
}) {
  const { nodesRef, setNodes, setEdges } = opts;
  const rf = useReactFlow();
  const [ctxMenu, setCtxMenu] = useState<CtxMenuState | null>(null);
  const ctxMenuRef = useRef<HTMLDivElement | null>(null);

  /** 右键单个未选中节点：先将其设为唯一选中（并清掉选中边），再弹菜单。 */
  const handleNodeContextMenu = useCallback(
    (e: ReactMouseEvent, node: FlowNode) => {
      e.preventDefault();
      const already = nodesRef.current.find((n) => n.id === node.id)?.selected;
      if (!already) {
        setNodes((ns) => ns.map((n) => ({ ...n, selected: n.id === node.id })));
        setEdges((es) => es.map((ed) => (ed.selected ? { ...ed, selected: false } : ed)));
      }
      const pos = clampCtxMenuPos(e.clientX, e.clientY, "node");
      setCtxMenu({
        kind: "node",
        nodeId: node.id,
        screen: { x: e.clientX, y: e.clientY },
        flow: rf.screenToFlowPosition({ x: e.clientX, y: e.clientY }),
        x: pos.x,
        y: pos.y,
      });
    },
    [rf, setEdges, setNodes]
  );

  const handlePaneContextMenu = useCallback(
    (e: ReactMouseEvent | MouseEvent) => {
      e.preventDefault();
      const pos = clampCtxMenuPos(e.clientX, e.clientY, "pane");
      setCtxMenu({
        kind: "pane",
        screen: { x: e.clientX, y: e.clientY },
        flow: rf.screenToFlowPosition({ x: e.clientX, y: e.clientY }),
        x: pos.x,
        y: pos.y,
      });
    },
    [rf]
  );

  const handleEdgeContextMenu = useCallback(
    (e: ReactMouseEvent, edge: Edge) => {
      e.preventDefault();
      const pos = clampCtxMenuPos(e.clientX, e.clientY, "edge");
      setCtxMenu({
        kind: "edge",
        edgeId: edge.id,
        screen: { x: e.clientX, y: e.clientY },
        flow: rf.screenToFlowPosition({ x: e.clientX, y: e.clientY }),
        x: pos.x,
        y: pos.y,
      });
    },
    [rf]
  );

  // 菜单打开期间：点击外部 / Escape 关闭
  useEffect(() => {
    if (!ctxMenu) return;
    const onMouseDown = (e: MouseEvent) => {
      if (ctxMenuRef.current && ctxMenuRef.current.contains(e.target as globalThis.Node)) return;
      setCtxMenu(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setCtxMenu(null);
    };
    window.addEventListener("mousedown", onMouseDown, true);
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("mousedown", onMouseDown, true);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [ctxMenu]);

  return {
    ctxMenu,
    setCtxMenu,
    ctxMenuRef,
    handlePaneContextMenu,
    handleNodeContextMenu,
    handleEdgeContextMenu,
  };
}
