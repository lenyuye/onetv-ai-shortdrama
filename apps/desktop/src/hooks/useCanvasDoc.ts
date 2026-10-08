/**
 * useCanvasDoc —— 画布文档状态核心 hook（从 CanvasView 拆出，逻辑不变）：
 * - ReactFlow nodes/edges 状态 + 供键盘/定时器等非渲染路径读取的镜像 refs；
 * - 撤销/重做快照栈（含节点拖动结束、检查器焦点区间两种快照时机）；
 * - 保存（手动 + 800ms debounce 自动）与分集切换加载 / 未落盘改动冲刷。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useEdgesState, useNodesState, useReactFlow } from "@xyflow/react";
import type { Edge } from "@xyflow/react";
import { SCHEMA_VERSION } from "@onetv/shared-types";
import type { CanvasDocument } from "@onetv/shared-types";
import * as apiCanvas from "../api-canvas";
import { useApp } from "../store";
import { useT } from "../i18n";
import {
  docCoreJson,
  docToFlow,
  errMsg,
  flowToDoc,
  type FlowNode,
} from "../components/canvas/canvas-model";
import { CANVAS_EXTERNAL_EVENT } from "../canvasSend";

export const FIT_VIEW_OPTIONS = { padding: 0.2, maxZoom: 1.2 };
const MAX_UNDO = 60;

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

export function useCanvasDoc(episodeId: string) {
  const t = useT();
  const { toast } = useApp();
  const rf = useReactFlow();
  const [nodes, setNodes, onNodesChange] = useNodesState<FlowNode>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [histLen, setHistLen] = useState({ u: 0, r: 0 });

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
        if (manual) toast(t("画布已保存"), "ok");
      } catch (e) {
        toast(t("保存画布失败：{msg}", { msg: errMsg(e) }), "err");
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
        toast(t("加载画布失败，已使用空白画布：{msg}", { msg: errMsg(e) }), "err");
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

  /* ---------- 外部变更联动（v2.26.29）：Agent 对话产物自动落画布后重载文档 ---------- */

  useEffect(() => {
    const onExternal = (e: Event) => {
      const detail = (e as CustomEvent<{ episodeId?: string }>).detail;
      // 只响应当前正在浏览的分集；其他分集切换加载时自然拿到最新文档
      if (!detail?.episodeId || detail.episodeId !== episodeIdRef.current || !loadedEpRef.current) return;
      apiCanvas
        .canvasGet(detail.episodeId)
        .then((doc) => {
          if (loadedEpRef.current !== detail.episodeId) return;
          applyDoc(normalizeCanvasDoc(doc, detail.episodeId!));
        })
        .catch(() => {});
    };
    window.addEventListener(CANVAS_EXTERNAL_EVENT, onExternal);
    return () => window.removeEventListener(CANVAS_EXTERNAL_EVENT, onExternal);
  }, [applyDoc]);

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

  /* ---------- 拖动节点：结束入撤销栈 + 自动保存 ---------- */

  const beginNodeDrag = useCallback(() => {
    dragSnapshot.current = docSnapshot();
  }, [docSnapshot]);

  const endNodeDrag = useCallback(() => {
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
  }, [docSnapshot, scheduleSave]);

  /* ---------- 检查器编辑（焦点区间做一次撤销快照） ---------- */

  const beginEdit = useCallback(() => {
    if (!editSnapshot.current) editSnapshot.current = docSnapshot();
  }, [docSnapshot]);

  const endEdit = useCallback(() => {
    const pre = editSnapshot.current;
    editSnapshot.current = null;
    if (!pre) return;
    if (docCoreJson(pre) === docCoreJson(docSnapshot())) return;
    undoStack.current.push(pre);
    if (undoStack.current.length > MAX_UNDO) undoStack.current.shift();
    redoStack.current = [];
    syncHist();
    scheduleSave();
  }, [docSnapshot, scheduleSave]);

  return {
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
  };
}
