/**
 * useCanvasShortcuts —— 画布键盘快捷键 hook（从 CanvasView 拆出，逻辑不变）：
 * Ctrl/Cmd+Z 撤销，Ctrl/Cmd+Shift+Z 重做，Delete/Backspace 删除选中；
 * 输入控件聚焦时不拦截。
 */
import { useEffect } from "react";
import type { Edge } from "@xyflow/react";
import type { FlowNode } from "../components/canvas/canvas-model";

export function useCanvasShortcuts(opts: {
  nodesRef: { current: FlowNode[] };
  edgesRef: { current: Edge[] };
  undo: () => void;
  redo: () => void;
  deleteSelection: () => void;
}) {
  const { nodesRef, edgesRef, undo, redo, deleteSelection } = opts;

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
}
