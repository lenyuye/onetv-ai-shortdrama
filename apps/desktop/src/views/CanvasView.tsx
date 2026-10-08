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
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DragEvent as ReactDragEvent, MouseEvent as ReactMouseEvent } from "react";
import { ReactFlowProvider, addEdge, useReactFlow } from "@xyflow/react";
import type { Connection, Edge } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { NODE_TYPE_DEFS, checkPortCompatible } from "@onetv/node-sdk";
import type { CanvasNode, EpisodeInfo, NodeType } from "@onetv/shared-types";
import * as api from "../api";
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
  isVideoMediaPath,
  pickInputPort,
  pickOutputPort,
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
import type { NodeActions } from "../components/canvas/NodeActionsContext";
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

  const { nodeChat, setNodeChat, openNodeChat, handleChatConfig, consumeRestorableChat } = useCanvasNodeChat({
    wrapperRef,
    nodesRef,
    setNodes,
    scheduleSave,
    setCtxMenu,
    episodeId,
  });

  // v2.26.111：切视图（模型/任务等）导致 CanvasView 卸载重建后，恢复未关闭的节点生成面板。
  // 文档加载完成且面板未打开时，按 sessionStorage 记录（分集+节点）恢复一次；节点已删除则清除记录。
  useEffect(() => {
    if (loading || nodeChat) return;
    const restoreId = consumeRestorableChat(episodeId);
    if (!restoreId) return;
    const fn = nodesRef.current.find((n) => n.id === restoreId);
    if (fn) openNodeChat(fn);
    else setNodeChat(null); // 节点已不存在：清除持久化记录
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, nodes.length, episodeId]);

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

      // v2.26.19 单连接点：连线按类型兼容性自动挑逻辑端口（用户只看到每节点 1 进 1 出）
      const outAcceptAll = outputAcceptOf(src.data.cn.type, null);
      const picked = pickInputPort(tgt.data.cn.type, outAcceptAll);
      if (!picked) {
        useApp.getState().toast(t("目标节点没有可用输入端口"), "err");
        return;
      }
      const inPort = picked.port;
      const targetHandleId = picked.id;
      const outPick = pickOutputPort(src.data.cn.type, inPort.accept);
      const sourceHandleId = outPick?.id ?? conn.sourceHandle ?? null;
      const outAccept = outputAcceptOf(src.data.cn.type, sourceHandleId);
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
        sourceHandle: sourceHandleId,
        targetHandle: targetHandleId,
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

  /* ---------- v2.26.31 LibTV 式节点即生成器：卡内回调（任意节点，不要求选中） ---------- */

  /** 按 nodeId 更新 config（节点卡内生成产物回填 / 文本卡内编辑 / 素材卡内上传） */
  const patchNodeConfig = useCallback(
    (nodeId: string, patch: Record<string, unknown>) => {
      setNodes((ns) =>
        ns.map((n) =>
          n.id === nodeId
            ? { ...n, data: { ...n.data, cn: { ...n.data.cn, config: { ...n.data.cn.config, ...patch } } } }
            : n
        )
      );
      scheduleSave();
    },
    [setNodes, scheduleSave]
  );

  /** 节点卡内/检查器「上传素材」（v2.26.102，LibTV/即梦式）：
   * 已有内容的节点上传 → 每次文件自动成为一个**新的独立素材节点**；
   * v2.26.104：**空素材节点**（无文件无产物）点「+上传」→ 直接填充该节点，不再留下空壳孤儿节点。
   * 新节点自动选中并平移视口到可见位置。sourceId 仅作为摆放锚点（可无）。 */
  const uploadNodeFileById = useCallback(
    async (nodeId: string) => {
      const ep = episodeIdRef.current;
      if (!ep) return;
      try {
        const att = await api.agentAttach();
        const anchor = nodesRef.current.find((n) => n.id === nodeId);
        const anchorCn = anchor?.data.cn;
        const anchorFiles = Array.isArray(anchorCn?.config?.files)
          ? (anchorCn.config.files as unknown[])
          : [];
        // v2.26.104：空素材节点 → 填充自身（title 同步为文件名）
        if (anchor && anchorCn?.type === "asset" && anchorFiles.length === 0 && !anchorCn.config?.outputAssetId) {
          pushUndo();
          setNodes((ns) =>
            ns.map((n) =>
              n.id === nodeId
                ? {
                    ...n,
                    data: {
                      ...n.data,
                      cn: {
                        ...n.data.cn,
                        title: att.name.length > 24 ? `${att.name.slice(0, 24)}…` : att.name,
                        config: {
                          ...n.data.cn.config,
                          files: [{ id: att.assetId, name: att.name, path: att.path, kind: att.kind }],
                          status: "ready",
                        },
                      },
                    },
                  }
                : n
            )
          );
          scheduleSave();
          toast(t("已上传 {name} 到该素材节点——点「🖼 生图 / 🎬 生视频」即可继续生成", { name: att.name }), "ok");
          return;
        }
        const pos = anchor
          ? { x: anchor.position.x + 40, y: anchor.position.y + 210 }
          : rf.screenToFlowPosition(centerScreen());
        const cn = createCanvasNode("asset", ep, pos);
        cn.title = att.name.length > 24 ? `${att.name.slice(0, 24)}…` : att.name;
        cn.config = {
          ...cn.config,
          files: [{ id: att.assetId, name: att.name, path: att.path, kind: att.kind }],
          status: "ready",
        };
        pushUndo();
        setNodes((ns) => [
          ...ns.map((n) => ({ ...n, selected: false })),
          { id: cn.id, type: "onetv", position: pos, data: { cn }, selected: true },
        ]);
        scheduleSave();
        // 视口跟随：确保新节点在可见区（LibTV 式上传即见）
        window.setTimeout(() => {
          void rf.setCenter(pos.x + 95, pos.y + 80, { zoom: Math.max(rf.getZoom(), 0.8), duration: 300 });
        }, 60);
        toast(t("已上传 {name} 并创建素材节点——点「🖼 生图 / 🎬 生视频」即可继续生成", { name: att.name }), "ok");
      } catch (e) {
        const msg = api.errMsg(e);
        if (!msg.includes("已取消") && !msg.includes("取消")) {
          toast(t("上传失败：{msg}", { msg }), "err");
        }
      }
    },
    [nodesRef, episodeIdRef, rf, pushUndo, setNodes, scheduleSave, toast, t]
  );

  /** v2.26.106：右键菜单「素材（本地上传）」——先弹文件选择，成功后在右键位置
   * 直接生成带内容的素材节点；取消选择则不留任何空壳。 */
  const uploadAssetAtScreen = useCallback(
    async (screenPos?: { x: number; y: number }) => {
      const ep = episodeIdRef.current;
      if (!ep) {
        toast(t("请先选择分集"), "warn");
        return;
      }
      try {
        const att = await api.agentAttach();
        const pos = screenPos
          ? rf.screenToFlowPosition({ x: screenPos.x, y: screenPos.y })
          : rf.screenToFlowPosition(centerScreen());
        const cn = createCanvasNode("asset", ep, pos);
        cn.title = att.name.length > 24 ? `${att.name.slice(0, 24)}…` : att.name;
        cn.config = {
          ...cn.config,
          files: [{ id: att.assetId, name: att.name, path: att.path, kind: att.kind }],
          status: "ready",
        };
        pushUndo();
        setNodes((ns) => [
          ...ns.map((n) => ({ ...n, selected: false })),
          { id: cn.id, type: "onetv", position: pos, data: { cn }, selected: true },
        ]);
        scheduleSave();
        window.setTimeout(() => {
          void rf.setCenter(pos.x + 95, pos.y + 80, { zoom: Math.max(rf.getZoom(), 0.8), duration: 300 });
        }, 60);
        toast(t("已上传 {name} 并创建素材节点——点「🖼 生图 / 🎬 生视频」即可继续生成", { name: att.name }), "ok");
      } catch (e) {
        const msg = api.errMsg(e);
        if (!msg.includes("已取消") && !msg.includes("取消")) {
          toast(t("上传失败：{msg}", { msg }), "err");
        }
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [episodeIdRef, rf, pushUndo, setNodes, scheduleSave, toast, t]
  );

  /** 素材/文本节点一键转生成（LibTV 式）：旁建生成节点 + 自动连线（上游即参考） */
  const spawnGenerateNode = useCallback(
    (sourceId: string, type: "image" | "video") => {
      const src = nodesRef.current.find((n) => n.id === sourceId);
      const ep = episodeIdRef.current;
      if (!src || !ep) return;
      const srcCn = src.data.cn;
      const pos = { x: src.position.x + 280, y: src.position.y };
      const cn = createCanvasNode(type, ep, pos);
      // 上游素材/文本自动绑定为参考（与「连线即参考」语义一致）
      const srcRefIds = (Array.isArray(srcCn.config?.referenceAssetIds) ? srcCn.config.referenceAssetIds : []) as string[];
      const fileIds = (Array.isArray(srcCn.config?.files) ? srcCn.config.files : []) as { id: string }[];
      const autoRefs = [...new Set([...srcRefIds, ...fileIds.map((f) => f.id)])];
      if (autoRefs.length > 0) cn.config = { ...cn.config, referenceAssetIds: autoRefs };
      pushUndo();
      setNodes((ns) => [...ns.map((n) => ({ ...n, selected: false })), { id: cn.id, type: "onetv", position: pos, data: { cn }, selected: true }]);
      setEdges((es) =>
        addEdge(
          {
            id: uid(),
            source: sourceId,
            target: cn.id,
            sourceHandle: NODE_TYPE_DEFS[srcCn.type]?.outputs?.[0]?.port ?? null,
            targetHandle: NODE_TYPE_DEFS[type]?.inputs?.[0]?.port ?? null,
          },
          es
        )
      );
      scheduleSave();
      // v2.26.102：视口跟随，确保新建节点在可见区
      window.setTimeout(() => {
        void rf.setCenter(pos.x + 95, pos.y + 80, { zoom: Math.max(rf.getZoom(), 0.8), duration: 300 });
      }, 60);
      toast(t("已创建{type}节点并连线，输入提示词即可生成", { type: type === "image" ? "生图" : "生视频" }), "ok");
    },
    [nodesRef, episodeIdRef, pushUndo, setNodes, setEdges, scheduleSave, rf, toast, t]
  );

  /** v2.26.102（LibTV 式）：生成完成后产物自动落为新的独立内容节点（图/视频占满显示）。
   * 产物节点仍保留生成条，可在产物基础上继续写提示词再生成。 */
  const spawnOutputNode = useCallback(
    (sourceId: string, assetId: string, path: string) => {
      const src = nodesRef.current.find((n) => n.id === sourceId);
      const ep = episodeIdRef.current;
      if (!src || !ep || !assetId || !path) return;
      // v2.26.156：类型判断剥离查询串（历史脏数据 *.mp4?e 曾把视频产物建成 image 节点）
      const isVideo = isVideoMediaPath(path);
      const type: NodeType = isVideo ? "video" : "image";
      const name = path.split("/").pop() || assetId;
      // 落点：源节点右侧；若那里已有节点则向下错开，避免堆叠
      const baseX = src.position.x + 280;
      let pos = { x: baseX, y: src.position.y };
      const occupied = (p: { x: number; y: number }) =>
        nodesRef.current.some((n) => Math.abs(n.position.x - p.x) < 60 && Math.abs(n.position.y - p.y) < 60);
      let guard = 0;
      while (occupied(pos) && guard++ < 8) pos = { x: baseX, y: pos.y + 230 };
      const cn = createCanvasNode(type, ep, pos);
      cn.title = name.length > 20 ? `${name.slice(0, 20)}…` : name;
      cn.config = { ...cn.config, outputAssetId: assetId, outputAssetPath: path, status: "ready" };
      pushUndo();
      setNodes((ns) => [...ns.map((n) => ({ ...n, selected: false })), { id: cn.id, type: "onetv", position: pos, data: { cn }, selected: true }]);
      scheduleSave();
      window.setTimeout(() => {
        void rf.setCenter(pos.x + 95, pos.y + 80, { zoom: Math.max(rf.getZoom(), 0.8), duration: 300 });
      }, 60);
      toast(t("生成完成——产物已落为独立节点"), "ok");
    },
    [nodesRef, episodeIdRef, pushUndo, setNodes, scheduleSave, rf, toast, t]
  );

  const nodeActions: NodeActions = useMemo(
    () => ({ patchConfig: patchNodeConfig, uploadNodeFile: uploadNodeFileById, spawnGenerateNode, spawnOutputNode }),
    [patchNodeConfig, uploadNodeFileById, spawnGenerateNode, spawnOutputNode]
  );

  /** 双击画布空白 → 就地弹出新建节点菜单（LibTV 式，复用右键 pane 菜单） */
  const handlePaneDoubleClick = useCallback(
    (e: ReactMouseEvent) => {
      handlePaneContextMenu(e);
    },
    [handlePaneContextMenu]
  );

  /* ---------- 工具栏动作 ---------- */

  const fitAll = useCallback(() => {
    void rf.fitView({ padding: 0.2, duration: 220 });
  }, [rf]);

  /* ---------- 拖拽创建（从面板拖到画布）+ 拖文件上传建素材节点（v2.26.27 即梦式） ---------- */

  const onDragOver = (e: ReactDragEvent<HTMLDivElement>) => {
    const hasFiles = Array.from(e.dataTransfer.types).includes("Files");
    if (e.dataTransfer.types.includes(NODE_DND_MIME) || hasFiles) {
      e.preventDefault();
      e.dataTransfer.dropEffect = hasFiles && !e.dataTransfer.types.includes(NODE_DND_MIME) ? "copy" : "move";
    }
  };

  /** 读取 File 为 base64（agentAttachData 落盘入资产库，单文件上限 50MB） */
  const fileToB64 = (f: File) =>
    new Promise<string>((res, rej) => {
      const r = new FileReader();
      r.onload = () => res(String(r.result).split(",")[1] ?? "");
      r.onerror = () => rej(r.error ?? new Error("读取失败"));
      r.readAsDataURL(f);
    });

  const onDrop = async (e: ReactDragEvent<HTMLDivElement>) => {
    e.preventDefault();
    const raw = e.dataTransfer.getData(NODE_DND_MIME);
    if (raw) {
      addNodeAt(raw as NodeType, { x: e.clientX, y: e.clientY });
      return;
    }
    // v2.26.27：从 Finder 拖文件进画布 → 自动上传入资产库并创建素材节点（即梦式）
    const files = Array.from(e.dataTransfer.files ?? []).slice(0, 5);
    if (files.length === 0) return;
    if (!episodeIdRef.current) {
      toast(t("请先选择分集"), "warn");
      return;
    }
    // v2.26.110：进入循环前固化分集 id——多文件拖入含多次 await，中途切分集会让后续
    // 节点落到新分集文档里（落点与预期不符）；检测到切换立即中止剩余文件。
    const dropEp = episodeIdRef.current;
    let created = 0;
    for (let i = 0; i < files.length; i++) {
      const f = files[i];
      if (episodeIdRef.current !== dropEp) {
        toast(t("分集已切换，剩余 {n} 个文件未导入", { n: files.length - i }), "warn");
        break;
      }
      if (f.size > 50 * 1024 * 1024) {
        toast(t("{name} 超过 50MB 上限，已跳过", { name: f.name }), "warn");
        continue;
      }
      try {
        const dataB64 = await fileToB64(f);
        const att = await api.agentAttachData({ name: f.name, dataB64 });
        const pos = rf.screenToFlowPosition({ x: e.clientX + i * 30, y: e.clientY + i * 26 });
        const cn = createCanvasNode("asset", dropEp, pos);
        cn.title = f.name.length > 24 ? `${f.name.slice(0, 24)}…` : f.name;
        cn.config = {
          ...cn.config,
          files: [{ id: att.assetId, name: att.name, path: att.path, kind: att.kind }],
          referenceAssetIds: [att.assetId],
          status: "ready",
        };
        pushUndo();
        setNodes((ns) => [
          ...ns.map((n) => ({ ...n, selected: false })),
          { id: cn.id, type: "onetv", position: pos, data: { cn }, selected: true },
        ]);
        created++;
      } catch (err) {
        toast(t("{name} 上传失败：{msg}", { name: f.name, msg: api.errMsg(err) }), "err");
      }
    }
    if (created > 0) {
      scheduleSave();
      toast(t("已从拖入文件创建 {n} 个素材节点（连线给生成节点作参考）", { n: created }), "ok");
    }
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
          onDeleteEdge={deleteEdgeById}
          onNodeDoubleClick={openNodeChat}
          onPaneDoubleClick={handlePaneDoubleClick}
          nodeActions={nodeActions}
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
        onUploadAsset={uploadAssetAtScreen}
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
