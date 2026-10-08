/**
 * 画布中部流程区（展示型子组件，从 CanvasView 拆出，DOM/文案不变）：
 * ReactFlow 画布（背景点阵 / 小地图 / 控件）+ 拖拽创建挂载点 + 节点生成面板 +
 * 加载 / 空画布提示。所有编辑动作通过 props 回调上交，状态所有权在 CanvasWorkbench。
 */
import type { DragEvent as ReactDragEvent, MouseEvent as ReactMouseEvent, MutableRefObject } from "react";
import {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  ReactFlow,
  useReactFlow,
} from "@xyflow/react";
import type { Connection, Edge, EdgeTypes, NodeTypes, OnEdgesChange, OnNodesChange } from "@xyflow/react";
import type { CanvasNode } from "@onetv/shared-types";
import type { ProviderDto } from "../../api-providers";
import { useT } from "../../i18n";
import CanvasNodeCard from "./CanvasNodeCard";
import CanvasEdge, { EdgeDeleteContext } from "./CanvasEdge";
import { NodeActionsContext, type NodeActions } from "./NodeActionsContext";
import NodeChatPanel from "./NodeChatPanel";
import { NODE_COLORS, type FlowNode } from "./canvas-model";
import { FIT_VIEW_OPTIONS } from "../../hooks/useCanvasDoc";
import type { NodeChatState } from "../../hooks/useCanvasNodeChat";

const nodeTypes: NodeTypes = { onetv: CanvasNodeCard };
const edgeTypes: EdgeTypes = { onetv: CanvasEdge };

export interface CanvasFlowAreaProps {
  nodes: FlowNode[];
  edges: Edge[];
  onNodesChange: OnNodesChange<FlowNode>;
  onEdgesChange: OnEdgesChange<Edge>;
  onConnect: (conn: Connection) => void;
  onNodeDragStart: () => void;
  onNodeDragStop: () => void;
  onPaneContextMenu: (e: ReactMouseEvent | MouseEvent) => void;
  onNodeContextMenu: (e: ReactMouseEvent, node: FlowNode) => void;
  onEdgeContextMenu: (e: ReactMouseEvent, edge: Edge) => void;
  /** v2.26.27 连线 hover × 删除（走画布 deleteEdgeById，含撤销） */
  onDeleteEdge: (edgeId: string) => void;
  /** 双击节点 → 打开生成面板 */
  onNodeDoubleClick: (node: FlowNode) => void;
  /** v2.26.31 双击画布空白 → 在双击位置弹出新建节点菜单（LibTV 式） */
  onPaneDoubleClick: (e: ReactMouseEvent) => void;
  /** LibTV 式节点即生成器（v2.26.31）：卡内生成/上传/快捷转生成回调 */
  nodeActions: NodeActions;
  /** 画布平移开始 → 关闭右键菜单 */
  onMoveStart: () => void;
  wrapperRef: MutableRefObject<HTMLDivElement | null>;
  onDragOver: (e: ReactDragEvent<HTMLDivElement>) => void;
  onDrop: (e: ReactDragEvent<HTMLDivElement>) => void;
  /** 滚轮 → 关闭右键菜单 */
  onWheel: () => void;
  loading: boolean;
  episodeId: string;
  nodeChat: NodeChatState | null;
  onCloseNodeChat: () => void;
  onChatConfig: (nodeId: string, patch: Record<string, unknown>) => void;
  providers: ProviderDto[];
}

export default function CanvasFlowArea({
  nodes,
  edges,
  onNodesChange,
  onEdgesChange,
  onConnect,
  onNodeDragStart,
  onNodeDragStop,
  onPaneContextMenu,
  onNodeContextMenu,
  onEdgeContextMenu,
  onDeleteEdge,
  onNodeDoubleClick,
  onPaneDoubleClick,
  nodeActions,
  onMoveStart,
  wrapperRef,
  onDragOver,
  onDrop,
  onWheel,
  loading,
  episodeId,
  nodeChat,
  onCloseNodeChat,
  onChatConfig,
  providers,
}: CanvasFlowAreaProps) {
  const t = useT();
  const rf = useReactFlow();

  return (
    <div
      className="cv-flow-wrap"
      ref={wrapperRef}
      onDragOver={onDragOver}
      onDrop={onDrop}
      onWheel={onWheel}
      onDoubleClick={(e) => {
        // 双击空白画布 → 就地新建节点菜单（LibTV 式）；双击节点走 onNodeDoubleClick 不受影响
        const target = e.target as HTMLElement;
        if (target.classList?.contains("react-flow__pane")) onPaneDoubleClick(e);
      }}
    >
      <NodeActionsContext.Provider value={nodeActions}>
      <EdgeDeleteContext.Provider value={onDeleteEdge}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        defaultEdgeOptions={{ type: "onetv" }}
        onNodeDragStart={onNodeDragStart}
        onNodeDragStop={onNodeDragStop}
        onPaneContextMenu={onPaneContextMenu}
        onNodeContextMenu={onNodeContextMenu}
        onNodeDoubleClick={(__e, node) => onNodeDoubleClick(node as FlowNode)}
        onEdgeContextMenu={onEdgeContextMenu}
        onMoveStart={onMoveStart}
        deleteKeyCode={null}
        fitView
        fitViewOptions={FIT_VIEW_OPTIONS}
        minZoom={0.2}
        maxZoom={2}
      >
        <Background variant={BackgroundVariant.Dots} gap={22} size={1.2} color="#2a3157" />
        <MiniMap
          pannable
          zoomable
          nodeStrokeWidth={2}
          nodeColor={(n) => {
            const t = (n.data as { cn?: CanvasNode }).cn?.type;
            return (t && NODE_COLORS[t]) || "#4d7cfe";
          }}
        />
        <Controls showInteractive={false} />
      </ReactFlow>
      </EdgeDeleteContext.Provider>
      </NodeActionsContext.Provider>

      {/* LibTV 式节点生成面板：双击/右键节点打开；位置随节点实时计算 */}
      {nodeChat &&
        (() => {
          const fn = nodes.find((n) => n.id === nodeChat.nodeId);
          if (!fn) return null;
          const rect = wrapperRef.current?.getBoundingClientRect();
          const p = rf.flowToScreenPosition({ x: fn.position.x, y: fn.position.y });
          const anchor = rect ? { x: p.x - rect.left, y: p.y - rect.top } : { x: p.x, y: p.y };
          return (
            <NodeChatPanel
              node={fn.data.cn}
              episodeId={episodeId}
              anchor={anchor}
              providers={providers}
              onConfig={onChatConfig}
              onClose={onCloseNodeChat}
            />
          );
        })()}

      {loading && <div className="cv-loading">{t("画布加载中…")}</div>}
      {!loading && !episodeId && (
        <div className="cv-empty-hint">
          <div className="big">🎞️</div>
          <p>{t("请先在上方选择分集")}</p>
        </div>
      )}
      {!loading && episodeId && nodes.length === 0 && (
        <div className="cv-empty-hint">
          <div className="big">🕸️</div>
          <p>{t("从左侧面板点击或拖拽，创建第一个节点")}</p>
        </div>
      )}
    </div>
  );
}
