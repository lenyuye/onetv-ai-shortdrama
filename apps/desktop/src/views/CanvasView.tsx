/**
 * 画布视图 —— 节点编辑器（Phase 1）。组合根：状态所有权保留在本文件，
 * 文档/剪贴板/右键菜单/批量运行等状态机拆入 hooks/，纯展示件拆入 components/canvas/。
 *
 * - 左侧节点面板（点击/拖拽创建）、中部 ReactFlow 画布、右侧参数检查器；
 * - 顶部：分集选择 + 保存 / 撤销 / 重做 / 运行选中 / 删除选中 / 适应视图 + 自动保存文案；
 * - 连线用 checkPortCompatible 校验端口类型（规格 §7.3：不兼容 toast 原因并拒绝）；
 * - 节点拖动等变更后 800ms debounce 自动 canvas_save；前端维护撤销/重做快照栈；
 * - 右键菜单：画布空白处（新建全部类型节点 / 粘贴 / 适应视图）、节点（复制 / 粘贴 / 删除）、
 *   连线（删除）；内部剪贴板支持多选节点整体复制并保留内部连线关系；
 * - 节点运行链路将在 Phase 2 接入 Job Queue（现为占位 toast）。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { DragEvent as ReactDragEvent } from "react";
import { ReactFlowProvider, addEdge, useReactFlow } from "@xyflow/react";
import type { Connection, Edge } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { NODE_TYPE_DEFS, checkPortCompatible } from "@onetv/node-sdk";
import type { CanvasNode, EpisodeInfo, NodeType } from "@onetv/shared-types";
import { providerList, type ProviderDto } from "../api-providers";
import { useT } from "../i18n";
import { useApp } from "../store";
import InspectorPanel from "../components/canvas/InspectorPanel";
import NodePalette, { NODE_DND_MIME } from "../components/canvas/NodePalette";
import CanvasToolbar from "../components/canvas/CanvasToolbar";
import CanvasContextMenu from "../components/canvas/CanvasContextMenu";
import CanvasFlowArea from "../components/canvas/CanvasFlowArea";
import ModelSelectorPanel, { modelCapsOf } from "../components/canvas/ModelSelectorPanel";
import {
  createCanvasNode,
  inputAcceptOf,
  outputAcceptOf,
  uid,
  type FlowNode,
} from "../components/canvas/canvas-model";
import { useCanvasEpisodes } from "../hooks/useCanvasEpisodes";
import { useCanvasDoc } from "../hooks/useCanvasDoc";
import { useCanvasBatch } from "../hooks/useCanvasBatch";
import { BatchRunPanel } from "../components/canvas/BatchRunPanel";
import { useCanvasContextMenu } from "../hooks/useCanvasContextMenu";
import { useCanvasClipboard } from "../hooks/useCanvasClipboard";
import { useCanvasNodeChat } from "../hooks/useCanvasNodeChat";
import { useCanvasShortcuts } from "../hooks/useCanvasShortcuts";
import "../components/canvas/canvas.css";

export default function CanvasView() {
  const t = useT();
  const {
    project,
    setView,
    episodes,
    episodesLoaded,
    episodeId,
    setEpisodeId,
    creating,
    createEpisode,
  } = useCanvasEpisodes();

  if (!project) {
    return (
      <div className="empty-state" style={{ height: "100%" }}>
        <div className="big">🕸️</div>
        <h2>{t("尚未打开项目")}</h2>
        <p>{t("画布按分集组织，请先在「工作区」创建或打开一个项目")}</p>
        <button className="btn primary" onClick={() => setView("home")}>
          {t("前往工作区")}
        </button>
      </div>
    );
  }

  if (!episodesLoaded) {
    return (
      <div className="empty-state" style={{ height: "100%" }}>
        <div className="big">⏳</div>
        <p>{t("分集加载中…")}</p>
      </div>
    );
  }

  if (episodes.length === 0) {
    return (
      <div className="empty-state" style={{ height: "100%" }}>
        <div className="big">🎞️</div>
        <h2>{t("还没有分集")}</h2>
        <p>{t("画布挂在分集下，请先新增一集再开始编排节点")}</p>
        <button className="btn primary" disabled={creating} onClick={createEpisode}>
          {creating ? t("创建中…") : t("+ 新增一集")}
        </button>
      </div>
    );
  }

  return (
    <div className="cv-root">
      <ReactFlowProvider>
        <CanvasWorkbench
          episodeId={episodeId}
          episodes={episodes}
          onSelectEpisode={setEpisodeId}
          onCreateEpisode={createEpisode}
          creating={creating}
        />
      </ReactFlowProvider>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* 工作台：组合 hooks（文档/撤销/保存/分集加载）与展示子组件              */
/* ------------------------------------------------------------------ */

interface CanvasWorkbenchProps {
  episodeId: string;
  episodes: EpisodeInfo[];
  onSelectEpisode: (id: string) => void;
  onCreateEpisode: () => void;
  creating: boolean;
}

function CanvasWorkbench({
  episodeId,
  episodes,
  onSelectEpisode,
  onCreateEpisode,
  creating,
}: CanvasWorkbenchProps) {
  const t = useT();
  const { toast } = useApp();
  const rf = useReactFlow();
  const wrapperRef = useRef<HTMLDivElement | null>(null);

  /* ---------- 文档状态：nodes/edges、撤销/重做、保存、分集加载（useCanvasDoc） ---------- */

  const {
    nodes,
    setNodes,
    onNodesChange,
    edges,
    setEdges,
    onEdgesChange,
    loading,
    saving,
    histLen,
    nodesRef,
    edgesRef,
    episodeIdRef,
    applyDoc,
    pushUndo,
    saveDoc,
    scheduleSave,
    undo,
    redo,
    beginNodeDrag,
    endNodeDrag,
    beginEdit,
    endEdit,
  } = useCanvasDoc(episodeId);

  // Provider 列表（生成模型选择器数据源）：挂载时拉取一次，仅保留已启用的
  const [providers, setProviders] = useState<ProviderDto[]>([]);
  useEffect(() => {
    let cancelled = false;
    providerList()
      .then((list) => {
        if (!cancelled) setProviders(list.filter((p) => p.enabled));
      })
      .catch(() => {}); // 拉取失败时选择器为空，仅剩「自动路由」默认项，不阻塞画布
    return () => {
      cancelled = true;
    };
  }, []);

  /* ---------- 画布批量运行（v2.14） ---------- */

  const { batchBusy, runBatch, batchPanelOpen, setBatchPanelOpen } = useCanvasBatch(episodeId, applyDoc);

  /* ---------- 右键菜单 + 内部剪贴板（复制 / 粘贴节点） ---------- */

  const {
    ctxMenu,
    setCtxMenu,
    ctxMenuRef,
    handlePaneContextMenu,
    handleNodeContextMenu,
    handleEdgeContextMenu,
  } = useCanvasContextMenu({ nodesRef, setNodes, setEdges });

  const { clipboardHasData, copyNodesToClipboard, pasteFromClipboard } = useCanvasClipboard({
    nodesRef,
    edgesRef,
    episodeIdRef,
    pushUndo,
    setNodes,
    setEdges,
    scheduleSave,
  });

  /* ---------- 节点生成面板（LibTV 式聊天框）：双击节点或右键菜单打开 ---------- */

  const { nodeChat, setNodeChat, openNodeChat, handleChatConfig } = useCanvasNodeChat({
    wrapperRef,
    nodesRef,
    setNodes,
    scheduleSave,
    setCtxMenu,
  });

  /* ---------- 检查器编辑派生状态 ---------- */

  const selectedFlowNode = nodes.find((n) => n.selected) ?? null;
  const selectedCn: CanvasNode | null = selectedFlowNode ? selectedFlowNode.data.cn : null;
  const hasSelEdges = edges.some((e) => e.selected);

  /* ---------- 节点增删 ---------- */

  const addNodeAt = useCallback(
    (type: NodeType, screenPos?: { x: number; y: number }) => {
      const ep = episodeIdRef.current;
      if (!ep || !NODE_TYPE_DEFS[type]) return;
      const pos = screenPos
        ? rf.screenToFlowPosition({ x: screenPos.x, y: screenPos.y })
        : rf.screenToFlowPosition(centerScreen());
      const cn = createCanvasNode(type, ep, pos);
      const flowNode: FlowNode = { id: cn.id, type: "onetv", position: pos, data: { cn } };
      pushUndo();
      setNodes((ns) => [
        ...ns.map((n) => ({ ...n, selected: false })),
        { ...flowNode, selected: true },
      ]);
      scheduleSave();
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [pushUndo, rf, scheduleSave, setNodes]
  );

  const deleteSelection = useCallback(() => {
    const selNodes = nodesRef.current.filter((n) => n.selected);
    // v2.14：锁定节点不可删除（FlowNode.data.cn 才是领域节点）
    const locked = selNodes.find((n) => n.data?.cn?.config?.locked === true);
    if (locked) {
      toast(t("节点「{title}」已锁定：请在检查器中取消锁定后再删除", { title: locked.data.cn.title }), "warn");
      return;
    }
    const selNodeIds = new Set(selNodes.map((n) => n.id));
    const hasSelEdges = edgesRef.current.some((e) => e.selected);
    if (!selNodeIds.size && !hasSelEdges) return;
    pushUndo();
    if (selNodeIds.size) setNodes((ns) => ns.filter((n) => !selNodeIds.has(n.id)));
    setEdges((es) =>
      es.filter((e) => !e.selected && !selNodeIds.has(e.source) && !selNodeIds.has(e.target))
    );
    scheduleSave();
  }, [pushUndo, setEdges, setNodes, scheduleSave]);

  /** 删除单条连线（含 undo）。 */
  const deleteEdgeById = useCallback(
    (edgeId: string) => {
      pushUndo();
      setEdges((es) => es.filter((e) => e.id !== edgeId));
      scheduleSave();
    },
    [pushUndo, setEdges, scheduleSave]
  );

  /** 节点菜单「删除」：目标在选中集合内 → 复用 deleteSelection（多选删全部）；否则按 id 兜底删除。 */
  const ctxDeleteNodes = useCallback(
    (nodeId: string) => {
      const selIds = nodesRef.current.filter((n) => n.selected).map((n) => n.id);
      if (selIds.includes(nodeId)) {
        deleteSelection();
        return;
      }
      pushUndo();
      setNodes((ns) => ns.filter((n) => n.id !== nodeId));
      setEdges((es) => es.filter((e) => e.source !== nodeId && e.target !== nodeId));
      scheduleSave();
    },
    [deleteSelection, pushUndo, setEdges, setNodes, scheduleSave]
  );

  /* ---------- 连线（端口类型校验，规格 §7.3） ---------- */

  const onConnect = useCallback(
    (conn: Connection) => {
      if (!conn.source || !conn.target) return;
      if (conn.source === conn.target) {
        useApp.getState().toast(t("不能将节点连接到自身"), "err");
        return;
      }
      const src = nodesRef.current.find((n) => n.id === conn.source);
      const tgt = nodesRef.current.find((n) => n.id === conn.target);
      if (!src || !tgt) return;

      const inPort = inputAcceptOf(tgt.data.cn.type, conn.targetHandle);
      if (!inPort) {
        useApp.getState().toast(t("目标节点没有可用输入端口"), "err");
        return;
      }
      const outAccept = outputAcceptOf(src.data.cn.type, conn.sourceHandle);
      const check = checkPortCompatible(inPort.accept, outAccept);
      if (!check.ok) {
        // check.reason 来自 node-sdk checkPortCompatible 的动态文案（含具体 MIME 集合），
        // 键为其完整原文（见 i18n/en/canvas.ts）；缺译时 t 自动回退原文兜底
        useApp.getState().toast(check.reason ? t(check.reason) : t("端口类型不兼容"), "err");
        return;
      }
      const duplicated = edgesRef.current.some(
        (e) =>
          e.source === conn.source &&
          e.target === conn.target &&
          e.sourceHandle === conn.sourceHandle &&
          e.targetHandle === conn.targetHandle
      );
      if (duplicated) {
        useApp.getState().toast(t("该连线已存在"), "warn");
        return;
      }

      const newEdge: Edge = {
        id: `e-${uid("c")}`,
        source: conn.source,
        target: conn.target,
        sourceHandle: conn.sourceHandle,
        targetHandle: conn.targetHandle,
      };
      pushUndo();
      setEdges((es) => {
        // v2.4.1 连线自由化：输入端口允许多条入边聚合（多图/多文/多视频 → 一个生成节点）。
        // 仅 text/script/storyboard 等单义端口仍替换旧边（multiple 未开启的定义）。
        const kept = inPort.multiple
          ? es
          : es.filter(
              (e) => !(e.target === conn.target && e.targetHandle === conn.targetHandle)
            );
        return addEdge(newEdge, kept);
      });
      scheduleSave();
    },
    [pushUndo, setEdges, scheduleSave]
  );

  /* ---------- 检查器编辑（选中节点 config/title 变更） ---------- */

  const updateSelectedNode = (mut: (cn: CanvasNode) => CanvasNode) => {
    if (!selectedFlowNode) return;
    const id = selectedFlowNode.id;
    setNodes((ns) =>
      ns.map((n) => (n.id === id ? { ...n, data: { ...n.data, cn: mut(n.data.cn) } } : n))
    );
  };
  const handleConfigChange = (patch: Record<string, unknown>) =>
    updateSelectedNode((cn) => ({ ...cn, config: { ...cn.config, ...patch } }));
  const handleConfigReplace = (config: Record<string, unknown>) =>
    updateSelectedNode((cn) => ({ ...cn, config }));
  const handleTitleChange = (title: string) =>
    updateSelectedNode((cn) => ({ ...cn, title }));

  /* ---------- 工具栏动作 ---------- */

  const fitAll = useCallback(() => {
    void rf.fitView({ padding: 0.2, duration: 220 });
  }, [rf]);

  /* ---------- 拖拽创建（从面板拖到画布） ---------- */

  const onDragOver = (e: ReactDragEvent<HTMLDivElement>) => {
    if (e.dataTransfer.types.includes(NODE_DND_MIME)) {
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
    }
  };
  const onDrop = (e: ReactDragEvent<HTMLDivElement>) => {
    e.preventDefault();
    const raw = e.dataTransfer.getData(NODE_DND_MIME);
    if (!raw) return;
    addNodeAt(raw as NodeType, { x: e.clientX, y: e.clientY });
  };

  const centerScreen = () => {
    const rect = wrapperRef.current?.getBoundingClientRect();
    const cx = (rect?.left ?? 0) + (rect?.width ?? 800) / 2;
    const cy = (rect?.top ?? 0) + (rect?.height ?? 600) / 2;
    return { x: cx + (Math.random() - 0.5) * 140, y: cy + (Math.random() - 0.5) * 120 };
  };

  /** 右键菜单「生成 / 对话…」：按 id 找到节点后打开生成面板。 */
  const openNodeChatById = (nodeId: string) => {
    const fn = nodesRef.current.find((n) => n.id === nodeId);
    if (fn) openNodeChat(fn);
  };

  /* ---------- 快捷键：Ctrl/Cmd+Z 撤销，Ctrl/Cmd+Shift+Z 重做，Delete 删除 ---------- */

  useCanvasShortcuts({ nodesRef, edgesRef, undo, redo, deleteSelection });

  /* ---------- 渲染 ---------- */

  return (
    <>
      <CanvasToolbar
        episodes={episodes}
        episodeId={episodeId}
        onSelectEpisode={onSelectEpisode}
        onCreateEpisode={onCreateEpisode}
        creating={creating}
        saving={saving}
        onSave={() => void saveDoc(true)}
        histLen={histLen}
        onUndo={undo}
        onRedo={redo}
        batchBusy={batchBusy}
        onRunBatch={() => void runBatch(false)}
        onResumeBatch={() => void runBatch(true)}
        deleteDisabled={!selectedFlowNode && !hasSelEdges}
        onDeleteSelection={deleteSelection}
        onFitAll={fitAll}
      />

      <div className="cv-body">
        <BatchRunPanel
          open={batchPanelOpen}
          episodeId={episodeId}
          busy={batchBusy}
          onClose={() => setBatchPanelOpen(false)}
          onRetry={() => void runBatch(true)}
        />
        <NodePalette onAdd={addNodeAt} canvasRef={wrapperRef} />

        <CanvasFlowArea
          nodes={nodes}
          edges={edges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          onConnect={onConnect}
          onNodeDragStart={beginNodeDrag}
          onNodeDragStop={endNodeDrag}
          onPaneContextMenu={handlePaneContextMenu}
          onNodeContextMenu={handleNodeContextMenu}
          onEdgeContextMenu={handleEdgeContextMenu}
          onNodeDoubleClick={openNodeChat}
          onMoveStart={() => setCtxMenu(null)}
          wrapperRef={wrapperRef}
          onDragOver={onDragOver}
          onDrop={onDrop}
          onWheel={() => setCtxMenu(null)}
          loading={loading}
          episodeId={episodeIdRef.current ?? ""}
          nodeChat={nodeChat}
          onCloseNodeChat={() => setNodeChat(null)}
          onChatConfig={handleChatConfig}
          providers={providers}
        />

        {/* 右侧列：生成模型选择器（仅生成类节点）+ 参数检查器 */}
        <div
          style={{
            width: 286,
            flexShrink: 0,
            display: "flex",
            flexDirection: "column",
            minHeight: 0,
          }}
        >
          {selectedCn && modelCapsOf(selectedCn.type) && (
            <ModelSelectorPanel
              node={selectedCn}
              providers={providers}
              onConfigChange={handleConfigChange}
              onEditStart={beginEdit}
              onEditEnd={endEdit}
            />
          )}
          <div style={{ flex: 1, minHeight: 0, display: "flex" }}>
            <InspectorPanel
              node={selectedCn}
              onConfigChange={handleConfigChange}
              onConfigReplace={handleConfigReplace}
              onTitleChange={handleTitleChange}
              onEditStart={beginEdit}
              onEditEnd={endEdit}
              onDelete={deleteSelection}
              onBatchResume={() => void runBatch(true)}
            />
          </div>
        </div>
      </div>

      <CanvasContextMenu
        menu={ctxMenu}
        menuRef={ctxMenuRef}
        clipboardHasData={clipboardHasData}
        selNodeCount={nodes.filter((n) => n.selected).length}
        onClose={() => setCtxMenu(null)}
        onAddNode={addNodeAt}
        onPaste={pasteFromClipboard}
        onFitAll={fitAll}
        onOpenNodeChat={openNodeChatById}
        onCopy={copyNodesToClipboard}
        onDeleteNodes={ctxDeleteNodes}
        onDeleteEdge={deleteEdgeById}
      />
    </>
  );
}
