/**
 * 时间线视图专用样式(参照 agentchat/styles.ts 的 AGENT_CSS 模式):
 * 复用 global.css 设计变量,仅补充时间线布局/泳道/片段/检查器样式,类名前缀 tl-。
 */
export const TL_CSS = `
.tl-root { display: flex; flex-direction: column; height: 100%; min-height: 0; }
.tl-root.page { max-width: none; height: 100%; }
.tl-toolbar { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.tl-toolbar select { min-width: 170px; }
.tl-zoom { display: flex; align-items: center; gap: 6px; color: var(--muted); font-size: 12px; }
.tl-zoom input[type="range"] { width: 130px; accent-color: var(--blue); }

.tl-body { display: flex; gap: 12px; flex: 1; min-height: 0; }
.tl-main {
  flex: 1; min-width: 0; display: flex; flex-direction: column;
  background: var(--panel); border: 1px solid var(--border); border-radius: var(--radius);
  overflow: hidden;
}
.tl-scroll { flex: 1; overflow: auto; min-height: 0; }

/* ---------- 行(标尺 + 泳道) ---------- */
.tl-row { display: flex; align-items: stretch; height: 76px; border-bottom: 1px solid var(--border); }
.tl-row:last-child { border-bottom: none; }
.tl-row.tl-ruler-row {
  height: 26px; position: sticky; top: 0; z-index: 4;
  background: var(--panel); border-bottom: 1px solid var(--border-strong);
}
.tl-rowhead {
  position: sticky; left: 0; z-index: 5; flex-shrink: 0;
  width: 128px; padding: 6px 8px;
  display: flex; flex-direction: column; justify-content: center; gap: 5px;
  background: var(--panel-2); border-right: 1px solid var(--border);
}
.tl-ruler-row .tl-rowhead { background: var(--panel); justify-content: center; }
.tl-trackmeta { display: flex; align-items: center; gap: 6px; min-width: 0; }
.tl-trackname { font-size: 12.5px; color: var(--text); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.tl-trackcount { font-size: 10.5px; color: var(--muted); }
.tl-rowhead .btn { padding: 1px 7px; font-size: 11px; align-self: flex-start; }
.tl-ruler-head { font-size: 11px; color: var(--muted); }

/* ---------- 标尺 ---------- */
.tl-ruler { position: relative; height: 100%; }
.tl-tick {
  position: absolute; bottom: 0; height: 100%;
  border-left: 1px solid var(--border);
  padding: 2px 0 0 4px; font-size: 10px; color: var(--muted);
  pointer-events: none; white-space: nowrap;
}

/* ---------- 泳道 ---------- */
.tl-lane { position: relative; flex: none; min-width: 0; }
.tl-lane-grid {
  position: absolute; inset: 0; pointer-events: none;
  background-image: repeating-linear-gradient(
    to right, transparent 0, transparent calc(var(--secw) - 1px),
    var(--border) calc(var(--secw) - 1px), var(--border) var(--secw)
  );
  opacity: 0.55;
}

/* ---------- 片段块 ---------- */
.tl-clip {
  position: absolute; top: 7px; bottom: 7px;
  border-radius: var(--radius-sm); border: 1px solid;
  overflow: hidden; cursor: grab; user-select: none;
}
.tl-clip:active { cursor: grabbing; }
.tl-clip.kind-video { background: rgba(77, 124, 254, 0.16); border-color: rgba(77, 124, 254, 0.55); }
.tl-clip.kind-audio { background: rgba(53, 208, 127, 0.14); border-color: rgba(53, 208, 127, 0.5); }
.tl-clip.kind-subtitle { background: rgba(255, 61, 154, 0.14); border-color: rgba(255, 61, 154, 0.5); }
.tl-clip:hover { filter: brightness(1.15); }
.tl-clip.selected { border-color: var(--blue); box-shadow: var(--glow-blue); z-index: 2; filter: none; }
.tl-clip-thumb { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; opacity: 0.75; }
.tl-clip-icon { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; font-size: 20px; opacity: 0.7; }
.tl-clip-label {
  position: absolute; left: 0; right: 0; bottom: 0; z-index: 1;
  padding: 2px 18px 2px 6px; font-size: 10.5px; color: #fff;
  background: rgba(0, 0, 0, 0.55);
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.tl-clip-badge {
  position: absolute; top: 3px; right: 9px; z-index: 1;
  font-size: 9.5px; color: #fff; background: rgba(0, 0, 0, 0.5);
  border-radius: 3px; padding: 0 4px;
}
.tl-clip-handle { position: absolute; top: 0; bottom: 0; width: 8px; cursor: ew-resize; z-index: 2; }
.tl-clip-handle.left { left: 0; }
.tl-clip-handle.right { right: 0; }
.tl-clip-handle::after {
  content: ""; position: absolute; top: 20%; bottom: 20%; width: 2px;
  background: rgba(255, 255, 255, 0.65); border-radius: 1px; opacity: 0;
}
.tl-clip-handle.left::after { left: 2px; }
.tl-clip-handle.right::after { right: 2px; }
.tl-clip:hover .tl-clip-handle::after,
.tl-clip.selected .tl-clip-handle::after { opacity: 1; }

/* ---------- 字幕内联添加行 ---------- */
.tl-sub-form { height: 56px; border-bottom: 1px solid var(--border); display: flex; align-items: center; }
.tl-sub-form-body { display: flex; align-items: center; gap: 8px; padding: 0 10px; flex: 1; min-width: 0; }
.tl-sub-form-body input[type="text"] { flex: 1; min-width: 0; }
.tl-sub-form-body input[type="number"] { width: 76px; }
.tl-sub-form-label { font-size: 11.5px; color: var(--text-dim); white-space: nowrap; }

/* ---------- 右侧检查器 ---------- */
.tl-inspector { width: 288px; flex-shrink: 0; min-height: 0; overflow: auto; }
.tl-inspector .card { padding: 12px; height: 100%; overflow: auto; }
.tl-ins-title { font-size: 13px; font-weight: 600; color: var(--text); margin-bottom: 2px; }
.tl-ins-sub { font-size: 11px; color: var(--muted); margin-bottom: 10px; word-break: break-all; }
.tl-ins-row { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
.tl-ins-media { margin-bottom: 12px; }
.tl-ins-media img { width: 100%; max-height: 150px; object-fit: cover; border-radius: var(--radius-sm); display: block; background: var(--bg-deep); }
.tl-ins-media audio { width: 100%; height: 36px; }
.tl-vol-row { display: flex; align-items: center; gap: 8px; }
.tl-vol-row input[type="range"] { flex: 1; accent-color: var(--blue); }
.tl-vol-row input[type="number"] { width: 64px; }
.tl-ins-empty { display: flex; flex-direction: column; align-items: center; gap: 8px; padding: 40px 8px; color: var(--muted); text-align: center; }
.tl-ins-empty .big { font-size: 30px; opacity: 0.55; }

/* ---------- 时间线空态 ---------- */
.tl-empty-actions { display: flex; gap: 10px; }

/* ---------- 资产选择弹窗 ---------- */
.tl-picker-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(120px, 1fr)); gap: 10px; max-height: 420px; overflow: auto; }
.tl-picker-item {
  position: relative; display: flex; flex-direction: column; gap: 6px;
  padding: 6px; text-align: left; cursor: pointer;
  background: var(--bg-deep); border: 1px solid var(--border-strong);
  border-radius: var(--radius-sm); color: var(--text-dim);
}
.tl-picker-item:hover { border-color: var(--blue); color: var(--text); }
.tl-picker-item:disabled { opacity: 0.5; cursor: not-allowed; }
.tl-picker-item img { width: 100%; height: 84px; object-fit: cover; border-radius: 4px; display: block; }
.tl-picker-icon { height: 84px; display: flex; align-items: center; justify-content: center; font-size: 30px; opacity: 0.7; }
.tl-picker-name { font-size: 11px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.tl-picker-probing { position: absolute; top: 4px; right: 4px; font-size: 10px; color: var(--amber); background: rgba(0,0,0,0.55); border-radius: 3px; padding: 1px 5px; }
`;
