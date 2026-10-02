/**
 * 画布视图 —— 节点编辑器（Phase 1）。
 *
 * - 左侧节点面板（点击/拖拽创建）、中部 ReactFlow 画布、右侧参数检查器；
 * - 顶部：分集选择 + 保存 / 撤销 / 重做 / 运行选中 / 删除选中 / 适应视图 + 自动保存文案；
 * - 连线用 checkPortCompatible 校验端口类型（规格 §7.3：不兼容 toast 原因并拒绝）；
 * - 节点拖动等变更后 800ms debounce 自动 canvas_save；前端维护撤销/重做快照栈；
 * - 节点运行链路将在 Phase 2 接入 Job Queue（现为占位 toast）。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { DragEvent as ReactDragEvent } from "react";
import {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  addEdge,
  useEdgesState,
  useNodesState,
  useReactFlow,
} from "@xyflow/react";
import type { Connection, Edge, NodeTypes } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { NODE_TYPE_DEFS, checkPortCompatible } from "@onetv/node-sdk";
import type { CanvasDocument, CanvasNode, EpisodeInfo, NodeType } from "@onetv/shared-types";
import * as api from "../api";
import * as apiCanvas from "../api-canvas";
import { useApp } from "../store";
import CanvasNodeCard from "../components/canvas/CanvasNodeCard";
import InspectorPanel from "../components/canvas/InspectorPanel";
import NodePalette, { NODE_DND_MIME } from "../components/canvas/NodePalette";
import {
  NODE_COLORS,
  createCanvasNode,
  docCoreJson,
  docToFlow,
  errMsg,
  flowToDoc,
  inputAcceptOf,
  outputAcceptOf,
  uid,
  type FlowNode,
} from "../components/canvas/canvas-model";
import "../components/canvas/canvas.css";

const nodeTypes: NodeTypes = { onetv: CanvasNodeCard };
const FIT_VIEW_OPTIONS = { padding: 0.2, maxZoom: 1.2 };
const MAX_UNDO = 60;

export default function CanvasView() {
  const { project, setView, loadProject, toast } = useApp();
  const [episodes, setEpisodes] = useState<EpisodeInfo[]>([]);
  const [episodesLoaded, setEpisodesLoaded] = useState(false);
  const [episodeId, setEpisodeId] = useState("");
  const [creating, setCreating] = useState(false);

  // 分集列表：跟随项目 / 集数变化刷新
  useEffect(() => {
    if (!project) return;
    setEpisodesLoaded(false);
    api
      .episodeList()
      .then(setEpisodes)
      .catch(() => {})
      .finally(() => setEpisodesLoaded(true));
  }, [project?.episodes.length]);

  // 自动选中第一个分集；当前分集被移除时回退
  useEffect(() => {
    if (episodes.length === 0) {
      if (episodeId) setEpisodeId("");
      return;
    }
    if (!episodeId || !episodes.some((ep) => ep.id === episodeId)) {
      setEpisodeId(episodes[0].id);
    }
  }, [episodeId, episodes]);

  const createEpisode = async () => {
    setCreating(true);
    try {
      const ep = await api.episodeCreate();
      await loadProject();
      const list = await api.episodeList().catch(() => [] as EpisodeInfo[]);
      if (list.length) setEpisodes(list);
      setEpisodeId(ep.id);
      toast("已新增一集", "ok");
    } catch (e) {
      toast(`新增失败：${errMsg(e)}`, "err");
    } finally {
      setCreating(false);
    }
  };

  if (!project) {
    return (
      <div className="empty-state" style={{ height: "100%" }}>
        <div className="big">🕸️</div>
        <h2>尚未打开项目</h2>
        <p>画布按分集组织，请先在「工作区」创建或打开一个项目</p>
        <button className="btn primary" onClick={() => setView("home")}>
          前往工作区
        </button>
      </div>
    );
  }

  if (!episodesLoaded) {
    return (
      <div className="empty-state" style={{ height: "100%" }}>
        <div className="big">⏳</div>
        <p>分集加载中…</p>
      </div>
    );
  }

  if (episodes.length === 0) {
    return (
      <div className="empty-state" style={{ height: "100%" }}>
        <div className="big">🎞️</div>
        <h2>还没有分集</h2>
        <p>画布挂在分集下，请先新增一集再开始编排节点</p>
        <button className="btn primary" disabled={creating} onClick={createEpisode}>
          {creating ? "创建中…" : "+ 新增一集"}
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
/* 工作台：持有 ReactFlow 状态、撤销/重做栈、自动保存                    */
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
  const { toast } = useApp();
  const [nodes, setNodes, onNodesChange] = useNodesState<FlowNode>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [histLen, setHistLen] = useState({ u: 0, r: 0 });

  const rf = useReactFlow();
  const wrapperRef = useRef<HTMLDivElement | null>(null);

  // 镜像最新状态，供键盘/定时器等非渲染路径读取
  const nodesRef = useRef<FlowNode[]>([]);
  nodesRef.current = nodes;
  const edgesRef = useRef<Edge[]>([]);
  edgesRef.current = edges;
  const episodeIdRef = useRef(episodeId);
  episodeIdRef.current = episodeId;

  // 撤销/重做快照栈
  const undoStack = useRef<CanvasDocument[]>([]);
  const redoStack = useRef<CanvasDocument[]>([]);
  const saveTimer = useRef<number | null>(null);
  const dragSnapshot = useRef<CanvasDocument | null>(null);
  const editSnapshot = useRef<CanvasDocument | null>(null);

  const syncHist = () =>
    setHistLen({ u: undoStack.current.length, r: redoStack.current.length });

  const docSnapshot = useCallback(
    () => flowToDoc(nodesRef.current, edgesRef.current, episodeIdRef.current),
    []
  );

  const pushUndo = useCallback(
    (snapshot?: CanvasDocument) => {
      undoStack.current.push(snapshot ?? docSnapshot());
      if (undoStack.current.length > MAX_UNDO) undoStack.current.shift();
      redoStack.current = [];
      syncHist();
    },
    [docSnapshot]
  );

  const applyDoc = useCallback(
    (doc: CanvasDocument) => {
      const flow = docToFlow(doc);
      setNodes(flow.nodes);
      setEdges(flow.edges);
    },
    [setNodes, setEdges]
  );

  /* ---------- 保存（手动 + 800ms debounce 自动） ---------- */

  const saveDoc = useCallback(
    async (manual: boolean) => {
      const ep = episodeIdRef.current;
      if (!ep) return;
      const doc = docSnapshot();
      if (manual) setSaving(true);
      try {
        await apiCanvas.canvasSave(ep, doc);
        if (manual) toast("画布已保存", "ok");
      } catch (e) {
        toast(`保存画布失败：${errMsg(e)}`, "err");
      } finally {
        if (manual) setSaving(false);
      }
    },
    [docSnapshot, toast]
  );

  const scheduleSave = useCallback(() => {
    if (!episodeIdRef.current) return;
    if (saveTimer.current !== null) window.clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => {
      saveTimer.current = null;
      void saveDoc(false);
    }, 800);
  }, [saveDoc]);

  /* ---------- 分集加载（切换分集时把未落盘的改动先冲刷保存） ---------- */

  useEffect(() => {
    if (!episodeId) return;
    const ep = episodeId;
    let cancelled = false;
    undoStack.current = [];
    redoStack.current = [];
    syncHist();
    setLoading(true);
    apiCanvas
      .canvasGet(ep)
      .then((doc) => {
        if (cancelled) return;
        applyDoc(doc);
        window.setTimeout(() => void rf.fitView(FIT_VIEW_OPTIONS), 80);
      })
      .catch((e) => {
        if (cancelled) return;
        applyDoc(apiCanvas.emptyCanvasDocument(ep));
        toast(`加载画布失败，已使用空白画布：${errMsg(e)}`, "err");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
      if (saveTimer.current !== null) {
        window.clearTimeout(saveTimer.current);
        saveTimer.current = null;
        const pending = flowToDoc(nodesRef.current, edgesRef.current, ep);
        void apiCanvas.canvasSave(ep, pending).catch(() => {});
      }
    };
  }, [episodeId, applyDoc, toast, rf]);

  /* ---------- 撤销 / 重做 ---------- */

  const undo = useCallback(() => {
    const prev = undoStack.current.pop();
    if (!prev) return;
    redoStack.current.push(docSnapshot());
    applyDoc(prev);
    syncHist();
    scheduleSave();
  }, [applyDoc, docSnapshot, scheduleSave]);

  const redo = useCallback(() => {
    const next = redoStack.current.pop();
    if (!next) return;
    undoStack.current.push(docSnapshot());
    applyDoc(next);
    syncHist();
    scheduleSave();
  }, [applyDoc, docSnapshot, scheduleSave]);

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
    const selNodeIds = new Set(
      nodesRef.current.filter((n) => n.selected).map((n) => n.id)
    );
    const hasSelEdges = edgesRef.current.some((e) => e.selected);
    if (!selNodeIds.size && !hasSelEdges) return;
    pushUndo();
    if (selNodeIds.size) setNodes((ns) => ns.filter((n) => !selNodeIds.has(n.id)));
    setEdges((es) =>
      es.filter((e) => !e.selected && !selNodeIds.has(e.source) && !selNodeIds.has(e.target))
    );
    scheduleSave();
  }, [pushUndo, setEdges, setNodes, scheduleSave]);

  /* ---------- 连线（端口类型校验，规格 §7.3） ---------- */

  const onConnect = useCallback(
    (conn: Connection) => {
      if (!conn.source || !conn.target) return;
      if (conn.source === conn.target) {
        useApp.getState().toast("不能将节点连接到自身", "err");
        return;
      }
      const src = nodesRef.current.find((n) => n.id === conn.source);
      const tgt = nodesRef.current.find((n) => n.id === conn.target);
      if (!src || !tgt) return;

      const inPort = inputAcceptOf(tgt.data.cn.type, conn.targetHandle);
      if (!inPort) {
        useApp.getState().toast("目标节点没有可用输入端口", "err");
        return;
      }
      const outAccept = outputAcceptOf(src.data.cn.type, conn.sourceHandle);
      const check = checkPortCompatible(inPort.accept, outAccept);
      if (!check.ok) {
        useApp.getState().toast(check.reason ?? "端口类型不兼容", "err");
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
        useApp.getState().toast("该连线已存在", "warn");
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
        // 单输入端口：替换已有连线
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

  /* ---------- 拖动节点：结束入撤销栈 + 自动保存 ---------- */

  const handleNodeDragStart = () => {
    dragSnapshot.current = docSnapshot();
  };

  const handleNodeDragStop = () => {
    const pre = dragSnapshot.current;
    dragSnapshot.current = null;
    if (!pre) return;
    const cur = docSnapshot();
    if (docCoreJson(pre) === docCoreJson(cur)) return; // 点击未移动
    undoStack.current.push(pre);
    if (undoStack.current.length > MAX_UNDO) undoStack.current.shift();
    redoStack.current = [];
    syncHist();
    scheduleSave();
  };

  /* ---------- 检查器编辑（焦点区间做一次撤销快照） ---------- */

  const selectedFlowNode = nodes.find((n) => n.selected) ?? null;
  const selectedCn: CanvasNode | null = selectedFlowNode ? selectedFlowNode.data.cn : null;
  const hasSelEdges = edges.some((e) => e.selected);

  const beginEdit = () => {
    if (!editSnapshot.current) editSnapshot.current = docSnapshot();
  };
  const endEdit = () => {
    const pre = editSnapshot.current;
    editSnapshot.current = null;
    if (!pre) return;
    if (docCoreJson(pre) === docCoreJson(docSnapshot())) return;
    undoStack.current.push(pre);
    if (undoStack.current.length > MAX_UNDO) undoStack.current.shift();
    redoStack.current = [];
    syncHist();
    scheduleSave();
  };

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

  const runSelected = () => {
    if (!selectedFlowNode) {
      toast("请先选择一个节点", "warn");
      return;
    }
    toast("节点运行将在 Phase 2 接入 Job Queue", "info");
  };

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

  /* ---------- 快捷键：Ctrl/Cmd+Z 撤销，Ctrl/Cmd+Shift+Z 重做，Delete 删除 ---------- */

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const editing =
        !!t &&
        (t.tagName === "INPUT" ||
          t.tagName === "TEXTAREA" ||
          t.tagName === "SELECT" ||
          t.isContentEditable);
      const mod = e.metaKey || e.ctrlKey;
      if (mod && !e.altKey && e.key.toLowerCase() === "z") {
        if (editing) return;
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
        return;
      }
      if (editing) return;
      if (e.key === "Delete" || e.key === "Backspace") {
        const hasSel =
          nodesRef.current.some((n) => n.selected) ||
          edgesRef.current.some((ed) => ed.selected);
        if (hasSel) {
          e.preventDefault();
          deleteSelection();
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [undo, redo, deleteSelection]);

  /* ---------- 渲染 ---------- */

  return (
    <>
      <div className="cv-topbar">
        <select
          className="cv-episode-select"
          value={episodeId}
          onChange={(e) => onSelectEpisode(e.target.value)}
          aria-label="选择分集"
        >
          <option value="" disabled>
            选择分集
          </option>
          {episodes.map((ep) => (
            <option key={ep.id} value={ep.id}>
              第 {ep.number} 集 · {ep.title}
            </option>
          ))}
        </select>
        <button className="btn sm" disabled={creating} onClick={onCreateEpisode}>
          + 新增一集
        </button>

        <div className="cv-vsep" />
        <button
          className="btn sm primary"
          disabled={saving || !episodeId}
          onClick={() => void saveDoc(true)}
        >
          💾 保存
        </button>
        <button
          className="btn sm"
          disabled={histLen.u === 0}
          onClick={undo}
          title="撤销 (Ctrl/Cmd+Z)"
        >
          ↩ 撤销
        </button>
        <button
          className="btn sm"
          disabled={histLen.r === 0}
          onClick={redo}
          title="重做 (Ctrl/Cmd+Shift+Z)"
        >
          ↪ 重做
        </button>

        <div className="cv-vsep" />
        <button className="btn sm" disabled={!selectedFlowNode} onClick={runSelected}>
          ▶ 运行选中
        </button>
        <button
          className="btn sm danger"
          disabled={!selectedFlowNode && !hasSelEdges}
          onClick={deleteSelection}
        >
          🗑 删除选中
        </button>
        <button className="btn sm" onClick={fitAll}>
          ⤢ 适应视图
        </button>

        <div className="spacer" />
        <span className="pill ok" title="位置 / 连线 / 参数变化后 800ms 自动保存">
          自动保存已开启
        </span>
        {saving && <span className="pill">保存中…</span>}
      </div>

      <div className="cv-body">
        <NodePalette onAdd={addNodeAt} />

        <div className="cv-flow-wrap" ref={wrapperRef} onDragOver={onDragOver} onDrop={onDrop}>
          <ReactFlow
            nodes={nodes}
            edges={edges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            nodeTypes={nodeTypes}
            onNodeDragStart={handleNodeDragStart}
            onNodeDragStop={handleNodeDragStop}
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

          {loading && <div className="cv-loading">画布加载中…</div>}
          {!loading && !episodeId && (
            <div className="cv-empty-hint">
              <div className="big">🎞️</div>
              <p>请先在上方选择分集</p>
            </div>
          )}
          {!loading && episodeId && nodes.length === 0 && (
            <div className="cv-empty-hint">
              <div className="big">🕸️</div>
              <p>从左侧面板点击或拖拽，创建第一个节点</p>
            </div>
          )}
        </div>

        <InspectorPanel
          node={selectedCn}
          onConfigChange={handleConfigChange}
          onConfigReplace={handleConfigReplace}
          onTitleChange={handleTitleChange}
          onEditStart={beginEdit}
          onEditEnd={endEdit}
          onDelete={deleteSelection}
        />
      </div>
    </>
  );
}
