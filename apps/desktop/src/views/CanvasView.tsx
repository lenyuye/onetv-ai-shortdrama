/**
 * 画布视图 —— 节点编辑器（Phase 1）。
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
import type { DragEvent as ReactDragEvent, MouseEvent as ReactMouseEvent } from "react";
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
import { SCHEMA_VERSION } from "@onetv/shared-types";
import type {
  CanvasDocument,
  CanvasNode,
  Capability,
  EpisodeInfo,
  NodeType,
} from "@onetv/shared-types";
import * as api from "../api";
import * as apiCanvas from "../api-canvas";
import { providerList, type ProviderDto } from "../api-providers";
import { useApp } from "../store";
import CanvasNodeCard from "../components/canvas/CanvasNodeCard";
import NodeChatPanel from "../components/canvas/NodeChatPanel";
import InspectorPanel from "../components/canvas/InspectorPanel";
import NodePalette, { NODE_DND_MIME } from "../components/canvas/NodePalette";
import {
  NODE_COLORS,
  NODE_ICONS,
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

/* ------------------------------------------------------------------ */
/* 右键菜单：类型定义、条目表与样式（仅本文件使用）                      */
/* ------------------------------------------------------------------ */

interface CtxMenuState {
  kind: "pane" | "node" | "edge";
  x: number; // 菜单显示坐标（已夹取到视口内）
  y: number;
  screen: { x: number; y: number }; // 弹出时的鼠标屏幕坐标（新建节点定位）
  flow: { x: number; y: number }; // 对应的画布 flow 坐标（粘贴定位）
  nodeId?: string; // kind === "node"
  edgeId?: string; // kind === "edge"
}

/** 新建节点菜单条目（10 种节点全部可建）。 */
const NODE_TYPE_ITEMS: { type: NodeType; label: string; icon: string }[] = [
  { type: "text", label: "文本", icon: NODE_ICONS.text },
  { type: "script", label: "剧本", icon: NODE_ICONS.script },
  { type: "image", label: "图片", icon: NODE_ICONS.image },
  { type: "video", label: "视频", icon: NODE_ICONS.video },
  { type: "audio", label: "音频", icon: NODE_ICONS.audio },
  { type: "storyboard", label: "分镜", icon: NODE_ICONS.storyboard },
  { type: "video-clip", label: "视频片段", icon: NODE_ICONS["video-clip"] },
  { type: "condition", label: "条件", icon: NODE_ICONS.condition },
  { type: "review", label: "审核", icon: NODE_ICONS.review },
  { type: "export", label: "导出", icon: NODE_ICONS.export },
];

/** 右键菜单浮层样式：复用 global.css 设计令牌的深色卡片风格。 */
const CTX_MENU_CSS = `
.cv-ctx-menu {
  position: fixed;
  z-index: 1000;
  min-width: 176px;
  background: var(--panel-3);
  border: 1px solid var(--border-strong);
  border-radius: 10px;
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.5);
  padding: 5px;
  user-select: none;
}
.cv-ctx-label {
  font-size: 10px;
  color: var(--muted);
  text-transform: uppercase;
  letter-spacing: 1px;
  padding: 5px 10px 3px;
}
.cv-ctx-item {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 6px 10px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--text-dim);
  font-family: var(--font);
  font-size: 12.5px;
  text-align: left;
  cursor: pointer;
  white-space: nowrap;
}
.cv-ctx-item:hover:not(:disabled) {
  background: var(--panel-2);
  color: var(--text);
}
.cv-ctx-item:disabled {
  opacity: 0.38;
  cursor: default;
}
.cv-ctx-item.danger { color: var(--red); }
.cv-ctx-item.danger:hover:not(:disabled) { background: rgba(255, 84, 112, 0.12); }
.cv-ctx-item .icon { width: 16px; text-align: center; }
.cv-ctx-sep { height: 1px; margin: 4px 6px; background: var(--border); }
`;

/** 把菜单坐标夹取到视口内，避免溢出屏幕（高度按菜单类型估算）。 */
function clampCtxMenuPos(x: number, y: number, kind: CtxMenuState["kind"]) {
  const w = 200;
  const h = kind === "pane" ? 400 : kind === "node" ? 140 : 64;
  return {
    x: Math.max(4, Math.min(x, window.innerWidth - w - 8)),
    y: Math.max(4, Math.min(y, window.innerHeight - h - 8)),
  };
}

/**
 * 归一化后端返回的画布文档（加载路径防御）：
 * - canvas.json 缺失时 doc_get 只返回 {"schemaVersion":"1.0"}（无 nodes/edges 字段），
 *   直接交给 docToFlow 会抛 TypeError 并误报「加载画布失败」；
 * - 顺带丢弃缺 id/端点非法的边（悬挂边）与无 id 的节点，避免历史脏数据破坏画布。
 */
function normalizeCanvasDoc(doc: CanvasDocument, episodeId: string): CanvasDocument {
  const rawNodes = Array.isArray(doc?.nodes) ? doc.nodes : [];
  const rawEdges = Array.isArray(doc?.edges) ? doc.edges : [];
  const nodes = rawNodes.filter(
    (n) => !!n && typeof n.id === "string" && typeof n.type === "string"
  );
  const nodeIds = new Set(nodes.map((n) => n.id));
  const edges = rawEdges.filter(
    (e) =>
      !!e &&
      typeof e.id === "string" &&
      typeof e.source === "string" &&
      typeof e.target === "string" &&
      nodeIds.has(e.source) &&
      nodeIds.has(e.target)
  );
  return {
    schemaVersion: doc?.schemaVersion ?? SCHEMA_VERSION,
    episodeId: doc?.episodeId ?? episodeId,
    nodes,
    edges,
    updatedAt: doc?.updatedAt ?? new Date().toISOString(),
  };
}

/**
 * 生成类节点 → 模型选择器按此能力过滤 Provider 模型列表。
 * text/condition/review/export 为本地/人工节点，不涉及模型生成，不显示选择器。
 */
const MODEL_CAPS_BY_NODE: Partial<Record<NodeType, Capability[]>> = {
  script: ["chat"],
  storyboard: ["chat"],
  image: ["image_generation"],
  video: ["video_generation"],
  audio: ["tts"],
  "video-clip": ["video_edit", "video_generation"],
};

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

  // 节点生成面板（LibTV 式聊天框）：双击节点或右键菜单打开
  const [nodeChat, setNodeChat] = useState<{ nodeId: string; anchor: { x: number; y: number } } | null>(null);
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
  /** 当前 nodes/edges 实际对应的分集（加载完成后才更新；空串 = 数据不可信，禁止保存） */
  const loadedEpRef = useRef("");

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
      // 竞态守卫：分集切换期间（refs 里还是旧分集的图、新分集尚未加载完成）禁止保存，
      // 防止把 A 分集的节点/连线写进 B 分集的 canvas.json
      if (loadedEpRef.current !== ep) return;
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
    loadedEpRef.current = ""; // 旧分集数据即将失效，保存守卫进入拦截状态
    apiCanvas
      .canvasGet(ep)
      .then((doc) => {
        if (cancelled) return;
        applyDoc(normalizeCanvasDoc(doc, ep));
        loadedEpRef.current = ep;
        window.setTimeout(() => void rf.fitView(FIT_VIEW_OPTIONS), 80);
      })
      .catch((e) => {
        if (cancelled) return;
        applyDoc(apiCanvas.emptyCanvasDocument(ep));
        loadedEpRef.current = ep;
        toast(`加载画布失败，已使用空白画布：${errMsg(e)}`, "err");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
      loadedEpRef.current = "";
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

  /* ---------- 右键菜单 + 内部剪贴板（复制 / 粘贴节点） ---------- */

  const [ctxMenu, setCtxMenu] = useState<CtxMenuState | null>(null);
  const ctxMenuRef = useRef<HTMLDivElement | null>(null);

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
      toast(`已复制 ${targets.length} 个节点`, "ok");
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
      toast(`已粘贴 ${newNodes.length} 个节点`, "ok");
    },
    [pushUndo, setNodes, setEdges, scheduleSave, toast]
  );

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

  const openNodeChat = (node: FlowNode) => {
    const rect = wrapperRef.current?.getBoundingClientRect();
    const p = rf.flowToScreenPosition({ x: node.position.x, y: node.position.y });
    const ax = rect ? p.x - rect.left : p.x;
    const ay = rect ? p.y - rect.top : p.y;
    setNodes((ns) => ns.map((n) => ({ ...n, selected: n.id === node.id })));
    setNodeChat({ nodeId: node.id, anchor: { x: ax, y: ay } });
    setCtxMenu(null);
  };
  /** 面板生成成功后回填节点 config（outputAssetId/status），走自动保存 */
  const handleChatConfig = (nodeId: string, patch: Record<string, unknown>) => {
    setNodes((ns) =>
      ns.map((n) =>
        n.id === nodeId
          ? { ...n, data: { ...n.data, cn: { ...n.data.cn, config: { ...n.data.cn.config, ...patch } } } }
          : n
      )
    );
    scheduleSave();
  };

  // 全局兜底：任务成功事件携带 nodeId 时直接回填节点（面板已关闭/切走也能收到产物）。
  // 修复前仅面板轮询回填——面板一关，生成结果就永远挂不到节点上。
  useEffect(() => {
    const un = api.onAppEvent<{ nodeId?: string | null; outputs?: string[]; reply?: string | null }>(
      "job.succeeded",
      (job) => {
        const nid = job?.nodeId;
        if (!nid) return;
        const fn = nodesRef.current.find((n) => n.id === nid);
        if (!fn) return; // 已切换分集或节点已删除
        const out = job.outputs?.[0];
        if (out) {
          handleChatConfig(nid, { outputAssetId: out, status: "ready" });
        } else if (job.reply && fn.data.cn.type === "text") {
          handleChatConfig(nid, { text: job.reply, status: "ready" });
        }
      }
    );
    return () => {
      un.then((f) => f()).catch(() => {});
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
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

  /* ---------- 生成模型选择器（config.providerId / config.modelId） ---------- */

  // 选中节点的模型能力过滤（非生成类节点 modelCaps 为 undefined → 不显示选择器）
  const modelCaps = selectedCn ? MODEL_CAPS_BY_NODE[selectedCn.type] : undefined;
  const eligibleProviders = modelCaps
    ? providers.filter((p) =>
        p.models.some((m) => modelCaps.some((c) => m.capabilities.includes(c)))
      )
    : [];
  const rawProviderId = selectedCn?.config?.providerId;
  const selProviderId = typeof rawProviderId === "string" ? rawProviderId : "";
  const selProvider = eligibleProviders.find((p) => p.id === selProviderId) ?? null;
  const eligibleModels =
    modelCaps && selProvider
      ? selProvider.models.filter((m) => modelCaps.some((c) => m.capabilities.includes(c)))
      : [];
  const rawModelId = selectedCn?.config?.modelId;
  const selModelId = typeof rawModelId === "string" ? rawModelId : "";

  const handleProviderChange = (v: string) => {
    // 切换 / 清空 Provider 时，原模型引用不再可靠，一并清空（换厂商需重选模型）
    handleConfigChange({ providerId: v, modelId: "" });
  };
  const handleModelChange = (v: string) => {
    handleConfigChange({ modelId: v });
  };

  /* ---------- 工具栏动作 ---------- */

  const fitAll = useCallback(() => {
    void rf.fitView({ padding: 0.2, duration: 220 });
  }, [rf]);

  const runSelected = () => {
    if (!selectedFlowNode) {
      toast("请先选择一个节点", "warn");
      return;
    }
    // 执行链路现状：画布尚无任务提交入口（Phase 2 接入 Job Queue）。届时组装参数时，
    // 应把选中节点 config.providerId / config.modelId 写入任务 step.input 的
    // providerId / model 字段（Rust handlers 优先读取，未设置则走「生成模型设置」默认路由）。
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

        <div
          className="cv-flow-wrap"
          ref={wrapperRef}
          onDragOver={onDragOver}
          onDrop={onDrop}
          onWheel={() => setCtxMenu(null)}
        >
          <ReactFlow
            nodes={nodes}
            edges={edges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            nodeTypes={nodeTypes}
            onNodeDragStart={handleNodeDragStart}
            onNodeDragStop={handleNodeDragStop}
            onPaneContextMenu={handlePaneContextMenu}
            onNodeContextMenu={handleNodeContextMenu}
            onNodeDoubleClick={(__e, node) => openNodeChat(node as FlowNode)}
            onEdgeContextMenu={handleEdgeContextMenu}
            onMoveStart={() => setCtxMenu(null)}
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
                episodeId={episodeIdRef.current ?? ""}
                anchor={anchor}
                providers={providers}
                onConfig={handleChatConfig}
                onClose={() => setNodeChat(null)}
              />
            );
          })()}

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
          {selectedCn && modelCaps && (
            <div
              style={{
                background: "var(--panel)",
                borderLeft: "1px solid var(--border)",
                borderBottom: "1px solid var(--border)",
                padding: "12px",
                flexShrink: 0,
              }}
            >
              <div className="cv-inspector-title">生成模型</div>
              <div className="field">
                <label>Provider</label>
                <select
                  value={selProviderId}
                  onFocus={beginEdit}
                  onBlur={endEdit}
                  onChange={(e) => handleProviderChange(e.target.value)}
                >
                  <option value="">跟随生成模型设置 / 自动路由</option>
                  {eligibleProviders.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                  {selProviderId && !selProvider && (
                    <option value={selProviderId}>{selProviderId}（已不可用）</option>
                  )}
                </select>
              </div>
              <div className="field">
                <label>模型</label>
                <select
                  value={selModelId}
                  disabled={!selProviderId}
                  onFocus={beginEdit}
                  onBlur={endEdit}
                  onChange={(e) => handleModelChange(e.target.value)}
                >
                  <option value="">
                    {selProviderId ? "自动（Provider 默认模型）" : "跟随生成模型设置 / 自动路由"}
                  </option>
                  {eligibleModels.map((m) => (
                    <option key={m.modelId} value={m.modelId}>
                      {m.displayName && m.displayName !== m.modelId
                        ? `${m.displayName} · ${m.modelId}`
                        : m.modelId}
                    </option>
                  ))}
                  {selModelId && !eligibleModels.some((m) => m.modelId === selModelId) && (
                    <option value={selModelId}>{selModelId}（已不可用）</option>
                  )}
                </select>
              </div>
              <div className="hint">留空 = 使用模型页「生成模型设置」的默认模型</div>
            </div>
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
            />
          </div>
        </div>
      </div>

      <style>{CTX_MENU_CSS}</style>

      {/* 右键菜单浮层（fixed 定位，点击外部 / Escape / 滚动 / 平移关闭） */}
      {ctxMenu && (
        <div
          ref={ctxMenuRef}
          className="cv-ctx-menu"
          style={{ left: ctxMenu.x, top: ctxMenu.y }}
          onContextMenu={(e) => e.preventDefault()}
        >
          {ctxMenu.kind === "pane" && (
            <>
              <div className="cv-ctx-label">新建节点</div>
              {NODE_TYPE_ITEMS.map((it) => (
                <button
                  key={it.type}
                  className="cv-ctx-item"
                  onClick={() => {
                    addNodeAt(it.type, ctxMenu.screen);
                    setCtxMenu(null);
                  }}
                >
                  <span className="icon">{it.icon}</span>
                  {it.label}
                </button>
              ))}
              <div className="cv-ctx-sep" />
              <button
                className="cv-ctx-item"
                disabled={!clipboardHasData}
                title={clipboardHasData ? "粘贴复制的节点" : "剪贴板为空"}
                onClick={() => {
                  pasteFromClipboard(ctxMenu.flow);
                  setCtxMenu(null);
                }}
              >
                <span className="icon">📋</span>
                粘贴
              </button>
              <button
                className="cv-ctx-item"
                onClick={() => {
                  fitAll();
                  setCtxMenu(null);
                }}
              >
                <span className="icon">⤢</span>
                适应视图
              </button>
            </>
          )}

          {ctxMenu.kind === "node" && ctxMenu.nodeId && (
            <>
              <button
                className="cv-ctx-item"
                onClick={() => {
                  const fn = nodesRef.current.find((n) => n.id === ctxMenu.nodeId);
                  if (fn) openNodeChat(fn);
                }}
              >
                <span className="icon">⚡</span>
                生成 / 对话…
              </button>
              <button
                className="cv-ctx-item"
                onClick={() => {
                  copyNodesToClipboard(ctxMenu.nodeId);
                  setCtxMenu(null);
                }}
              >
                <span className="icon">⧉</span>
                复制
              </button>
              <button
                className="cv-ctx-item"
                disabled={!clipboardHasData}
                title={clipboardHasData ? "粘贴复制的节点" : "剪贴板为空"}
                onClick={() => {
                  pasteFromClipboard(ctxMenu.flow);
                  setCtxMenu(null);
                }}
              >
                <span className="icon">📋</span>
                粘贴
              </button>
              <div className="cv-ctx-sep" />
              <button
                className="cv-ctx-item danger"
                onClick={() => {
                  ctxDeleteNodes(ctxMenu.nodeId as string);
                  setCtxMenu(null);
                }}
              >
                <span className="icon">🗑</span>
                删除{nodes.filter((n) => n.selected).length > 1 ? "选中节点" : "该节点"}
              </button>
            </>
          )}

          {ctxMenu.kind === "edge" && ctxMenu.edgeId && (
            <button
              className="cv-ctx-item danger"
              onClick={() => {
                deleteEdgeById(ctxMenu.edgeId as string);
                setCtxMenu(null);
              }}
            >
              <span className="icon">🗑</span>
              删除连线
            </button>
          )}
        </div>
      )}
    </>
  );
}
