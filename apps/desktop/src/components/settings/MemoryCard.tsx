/**
 * 🧠 意识模块（记忆）卡片 —— v2.26.16 三行式重构（对标 Codex 记忆设置页）：
 * 行1 自动记忆开关 / 行2 编辑记忆（打开管理弹窗）/ 行3 清空全部记忆（危险）。
 * 卡片保持紧凑与右侧 FFmpeg 卡对称；时间线/搜索/多选/导入导出/新增全部移入弹窗。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";
import * as api from "../../api";
import { memorySearch } from "../../api-extras";
import ConfirmDialog from "../ConfirmDialog";
import { useApp } from "../../store";
import { t, useT } from "../../i18n";

/** Tauri 命令 Err 时前端拿到 {message} 对象，统一提取可读文案 */
const errMsg = (e: unknown): string => {
  if (typeof e === "string") return e;
  if (e && typeof e === "object" && "message" in e) return String((e as { message: unknown }).message);
  try { return JSON.stringify(e); } catch { return String(e); }
};

/* ---------------- 🧠 意识模块（记忆）卡片 ---------------- */

/** 相对时间：3 分钟前 / 2 小时前 / 昨天 / 10-03 */
function memRelTime(iso: string): string {
  const ts = new Date(iso).getTime();
  if (Number.isNaN(ts)) return iso.slice(0, 10);
  const diff = Date.now() - ts;
  const m = Math.floor(diff / 60000);
  if (m < 1) return t("刚刚");
  if (m < 60) return t("{m} 分钟前", { m });
  const h = Math.floor(m / 60);
  if (h < 24) return t("{h} 小时前", { h });
  const d = Math.floor(h / 24);
  if (d === 1) return t("昨天");
  if (d < 7) return t("{d} 天前", { d });
  const dt = new Date(ts);
  return `${dt.getMonth() + 1}-${String(dt.getDate()).padStart(2, "0")}`;
}

function MemoryRow({
  rec,
  checked,
  multiSelect,
  saving,
  onCheck,
  onSave,
  onDelete,
}: {
  rec: api.MemoryRecord;
  checked: boolean;
  multiSelect: boolean;
  saving: boolean;
  onCheck: (id: string, v: boolean) => void;
  onSave: (id: string, text: string) => Promise<void>;
  onDelete: (id: string) => void;
}) {
  const t = useT();
  const [expanded, setExpanded] = useState(false);
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(rec.text);

  const longText = rec.text.includes("\n") || rec.text.length > 96;

  const stop = (fn: () => void) => (e: ReactMouseEvent) => { e.stopPropagation(); fn(); };

  if (editing) {
    return (
      <div className="mem-row editing">
        <div className="mem-row-head">
          <span className="mem-dot" />
          <span className="mem-time">{memRelTime(rec.createdAt ?? rec.created_at ?? "")}</span>
          <span style={{ flex: 1 }} />
          <span className="mem-chars">{t("{n} 字", { n: text.trim().length })}</span>
        </div>
        <textarea
          className="mem-edit"
          value={text}
          autoFocus
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
              e.preventDefault();
              if (text.trim()) void onSave(rec.id, text.trim()).then(() => setEditing(false));
            }
            if (e.key === "Escape") { setEditing(false); setText(rec.text); }
          }}
        />
        <div className="mem-row-actions">
          <span className="hint" style={{ marginRight: "auto" }}>{t("⌘+Enter 保存 · Esc 取消")}</span>
          <button
            className="btn sm primary"
            disabled={saving || !text.trim()}
            onClick={stop(async () => {
              await onSave(rec.id, text.trim());
              setEditing(false);
            })}
          >
            {saving ? t("保存中…") : t("保存修改")}
          </button>
          <button className="btn sm" onClick={stop(() => { setEditing(false); setText(rec.text); })}>{t("取消")}</button>
        </div>
      </div>
    );
  }

  return (
    <div className="mem-row">
      <div className="mem-row-head">
        {multiSelect ? (
          <input
            type="checkbox"
            checked={checked}
            onChange={(e) => onCheck(rec.id, e.target.checked)}
            onClick={(e) => e.stopPropagation()}
          />
        ) : (
          <span className="mem-dot" />
        )}
        <span className="mem-time">{memRelTime(rec.createdAt ?? rec.created_at ?? "")}</span>
        <span className="mem-scope tag blue">{rec.scope}</span>
        <span style={{ flex: 1 }} />
        <span className="mem-row-actions">
          <button title={t("编辑")} onClick={stop(() => { setEditing(true); setText(rec.text); })}>{t("编辑")}</button>
          <button
            title={t("复制到剪贴板")}
            onClick={stop(() => {
              void navigator.clipboard.writeText(rec.text).then(
                () => useApp.getState().toast(t("已复制到剪贴板"), "ok"),
                () => useApp.getState().toast(t("复制失败"), "err"),
              );
            })}
          >
            {t("复制")}
          </button>
          <button className="mem-danger-btn" title={t("删除（不可恢复）")} onClick={stop(() => onDelete(rec.id))}>{t("删除")}</button>
        </span>
      </div>
      <div
        className={`mem-text ${expanded ? "" : "clamped"} ${longText ? "clickable" : ""}`}
        title={longText && !expanded ? t("点击展开全文") : undefined}
        onClick={() => longText && setExpanded((v) => !v)}
      >
        {rec.text}
      </div>
      {longText && (
        <button className="mem-toggle" onClick={stop(() => setExpanded((v) => !v))}>
          {expanded ? t("收起 ▲") : t("展开全文 ▼")}
        </button>
      )}
    </div>
  );
}

/** 记忆管理弹窗：时间线 / 语义搜索 / 多选批量 / 导入导出 / 新增（全部从卡片移入） */
function MemoryManagerModal({ onClose }: { onClose: () => void }) {
  const { toast } = useApp();
  const t = useT();
  const [records, setRecords] = useState<api.MemoryRecord[] | null>(null);
  const [loadErr, setLoadErr] = useState("");
  const [newText, setNewText] = useState("");
  const [addBusy, setAddBusy] = useState(false);
  const [savingId, setSavingId] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [multiSelect, setMultiSelect] = useState(false);
  const [importRef, setImportRef] = useState<HTMLInputElement | null>(null);
  const newTextRef = useRef<HTMLTextAreaElement | null>(null);

  const refresh = useCallback(async () => {
    setLoadErr("");
    try {
      setRecords(await api.memoryList());
    } catch (e) {
      setLoadErr(errMsg(e));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const list = records ?? [];
  const q = query.trim().toLowerCase();
  const [semanticIds, setSemanticIds] = useState<Map<string, number> | null>(null);
  useEffect(() => {
    if (!q) {
      setSemanticIds(null);
      return;
    }
    let alive = true;
    memorySearch(q, 50)
      .then((rows) => {
        if (!alive) return;
        setSemanticIds(new Map(rows.map((r) => [r.record.id, r.score])));
      })
      .catch(() => alive && setSemanticIds(null));
    return () => {
      alive = false;
    };
  }, [q]);
  const filtered = q
    ? semanticIds
      ? list
          .map((m, i) => ({ m, i, score: semanticIds.get(m.id) ?? 0, includes: m.text.toLowerCase().includes(q) ? 2 : 0 }))
          .filter((x) => x.score > 0 || x.includes)
          .sort((a, b) => b.score + b.includes - (a.score + a.includes) || a.i - b.i)
          .map((x) => x.m)
      : list.filter((m) => m.text.toLowerCase().includes(q))
    : list;

  const addMemory = async () => {
    const text = newText.trim();
    if (!text) return;
    setAddBusy(true);
    try {
      const rec = await api.memoryAdd(text);
      setRecords((r) => [rec, ...(r ?? [])]);
      setNewText("");
      toast(t("记忆已保存"), "ok");
    } catch (e) {
      toast(t("添加失败：{msg}", { msg: errMsg(e) }), "err");
    } finally {
      setAddBusy(false);
    }
  };

  const saveEdit = async (id: string, text: string) => {
    if (!text) return;
    setSavingId(id);
    try {
      await api.memoryUpdate(id, text);
      setRecords((r) => (r ?? []).map((m) => (m.id === id ? { ...m, text } : m)));
      toast(t("记忆已更新"), "ok");
    } catch (e) {
      toast(t("保存失败：{msg}", { msg: errMsg(e) }), "err");
    } finally {
      setSavingId(null);
    }
  };

  const removeMemory = async (id: string) => {
    if (!window.confirm(t("确定删除这条记忆？不可恢复"))) return;
    try {
      await api.memoryDelete(id);
      setRecords((r) => (r ?? []).filter((m) => m.id !== id));
      setSelected((s) => { const n = new Set(s); n.delete(id); return n; });
      toast(t("已删除"), "ok");
    } catch (e) {
      toast(t("删除失败：{msg}", { msg: errMsg(e) }), "err");
    }
  };

  const batchDelete = async () => {
    const ids = [...selected];
    if (ids.length === 0) return;
    if (!window.confirm(t("确定删除选中的 {n} 条记忆？不可恢复", { n: ids.length }))) return;
    let ok = 0;
    for (const id of ids) {
      try {
        await api.memoryDelete(id);
        ok += 1;
      } catch { /* 单条失败继续 */ }
    }
    setRecords((r) => (r ?? []).filter((m) => !ids.includes(m.id)));
    setSelected(new Set());
    setMultiSelect(false);
    toast(t("已删除 {ok}/{total} 条记忆", { ok, total: ids.length }), ok === ids.length ? "ok" : "warn");
  };

  const exportMd = () => {
    const items = selected.size > 0 ? list.filter((m) => selected.has(m.id)) : list;
    if (items.length === 0) { toast(t("没有可导出的记忆"), "warn"); return; }
    const lines = ["# OneTV 记忆导出", "", `> ${items.length} 条 · ${new Date().toLocaleString()}`, ""];
    for (const m of items) {
      lines.push(`- [${(m.createdAt ?? m.created_at ?? "").replace("T", " ").slice(0, 16)}] ${m.text.split("\n").join("\n  ")}`);
    }
    const blob = new Blob([lines.join("\n")], { type: "text/markdown;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "OneTV-记忆.md";
    a.click();
    URL.revokeObjectURL(a.href);
    toast(t("已导出 {n} 条记忆", { n: items.length }), "ok");
  };

  const importFile = async (file: File) => {
    const raw = await file.text();
    const parts = raw.split(/\n\s*\n/).map((x) => x.trim()).filter((x) => x.length > 0).slice(0, 200);
    if (parts.length === 0) { toast(t("文件中没有可导入的内容"), "warn"); return; }
    let ok = 0;
    for (const part of parts) {
      try { await api.memoryAdd(part); ok += 1; } catch { /* 单条失败继续 */ }
    }
    await refresh();
    toast(t("导入完成：成功 {ok}/{total} 条", { ok, total: parts.length }), ok === parts.length ? "ok" : "warn");
  };

  const toggleCheck = (id: string, v: boolean) => {
    setSelected((s) => { const n = new Set(s); if (v) n.add(id); else n.delete(id); return n; });
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" style={{ width: "min(760px, 94vw)" }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <span>{t("🧠 编辑记忆（{n} 条）", { n: list.length })}</span>
          <button className="btn sm ghost" onClick={onClose}>✕</button>
        </div>
        <div className="modal-body">
          {loadErr ? (
            <div className="hint mem-notice">{t("加载失败：{msg}", { msg: loadErr })}</div>
          ) : records === null ? (
            <div className="hint">{t("加载中…")}</div>
          ) : (
            <>
              {/* 统计 + 工具条 */}
              <div className="mem-stats">
                <span className="tag green">{t("仅存本机工程内")}</span>
                <span style={{ flex: 1 }} />
                <button className="btn sm" onClick={() => { setMultiSelect((v) => !v); setSelected(new Set()); }}>
                  {multiSelect ? t("退出多选") : t("多选")}
                </button>
                <button className="btn sm" title={t("导出为 Markdown")} onClick={exportMd}>{t("⬇ 导出")}</button>
                <button className="btn sm" title={t("从 .txt/.md 导入（空行分段，每段一条）")} onClick={() => importRef?.click()}>{t("⬆ 导入")}</button>
                <input
                  ref={setImportRef}
                  type="file"
                  accept=".txt,.md,.markdown,text/plain,text/markdown"
                  style={{ display: "none" }}
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    e.target.value = "";
                    if (f) void importFile(f);
                  }}
                />
              </div>

              {list.length > 0 && (
                <input
                  className="mem-search"
                  type="text"
                  placeholder={t("🔍 搜索记忆（语义排序：相关度优先）…")}
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
              )}

              {multiSelect && list.length > 0 && (
                <div className="mem-bulk">
                  <label style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <input
                      type="checkbox"
                      checked={filtered.length > 0 && filtered.every((m) => selected.has(m.id))}
                      onChange={(e) => {
                        if (e.target.checked) setSelected(new Set(filtered.map((m) => m.id)));
                        else setSelected(new Set());
                      }}
                    />
                    {t("全选（当前筛选 {n} 条）", { n: filtered.length })}
                  </label>
                  <span style={{ flex: 1 }} />
                  <span className="hint">{t("已选 {n} 条", { n: selected.size })}</span>
                  <button className="btn sm danger" disabled={selected.size === 0} onClick={() => void batchDelete()}>
                    {t("删除所选")}
                  </button>
                </div>
              )}

              {list.length === 0 ? (
                <div className="mem-empty">
                  <div className="mem-empty-icon">🧠</div>
                  <div className="mem-empty-title">{t("还没有记忆")}</div>
                  <div className="hint">{t("把主角设定、风格约定、剧情要点告诉 Agent —— 开启自动记忆后对话会自动提取，或在下方手写第一条")}</div>
                </div>
              ) : filtered.length === 0 ? (
                <div className="hint" style={{ margin: "10px 0" }}>{t("没有匹配「{q}」的记忆", { q: query })}</div>
              ) : (
                <div className="mem-list mem-timeline">
                  {filtered.map((rec) => (
                    <MemoryRow
                      key={rec.id}
                      rec={rec}
                      checked={selected.has(rec.id)}
                      multiSelect={multiSelect}
                      saving={savingId === rec.id}
                      onCheck={toggleCheck}
                      onSave={saveEdit}
                      onDelete={(id) => void removeMemory(id)}
                    />
                  ))}
                </div>
              )}

              {/* 新增输入区 */}
              <div className="mem-composer">
                <textarea
                  ref={newTextRef}
                  className="mem-edit"
                  rows={2}
                  value={newText}
                  placeholder={t("写下要记住的内容，例如：主角林晚是冷静的刑警，口头禅「证据说话」…（⌘+Enter 保存；粘贴多段文字后保存会按原样存为一条）")}
                  onChange={(e) => setNewText(e.target.value)}
                  onKeyDown={(e) => {
                    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                      e.preventDefault();
                      void addMemory();
                    }
                  }}
                />
                <div className="mem-composer-bar">
                  <span className="hint" style={{ marginRight: "auto" }}>{t("{n} 字 · ⌘+Enter 保存", { n: newText.trim().length })}</span>
                  <button className="btn primary" disabled={addBusy || !newText.trim()} onClick={() => void addMemory()}>
                    {addBusy ? t("保存中…") : t("保存记忆")}
                  </button>
                </div>
              </div>
            </>
          )}
        </div>
        <div className="modal-foot">
          <button className="btn" onClick={onClose}>{t("关闭")}</button>
        </div>
      </div>
    </div>
  );
}

/** 三行式紧凑卡片（与右侧 FFmpeg 卡对称）：开关 / 编辑记忆 / 清空全部 */
export function MemoryCard() {
  const { toast, settings, patchSettings } = useApp();
  const t = useT();
  const [count, setCount] = useState<number | null>(null);
  const [latestLabel, setLatestLabel] = useState("—");
  const [managerOpen, setManagerOpen] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);
  const [notOpen, setNotOpen] = useState(false);

  const refreshStat = useCallback(async () => {
    setNotOpen(false);
    try {
      const list = await api.memoryList();
      setCount(list.length);
      const latest = list.length
        ? list.reduce((a, b) => ((a.createdAt ?? a.created_at ?? "") > (b.createdAt ?? b.created_at ?? "") ? a : b))
        : null;
      setLatestLabel(latest ? memRelTime(latest.createdAt ?? latest.created_at ?? "") : "—");
    } catch (e) {
      if (errMsg(e).includes("未打开项目")) setNotOpen(true);
      else setCount(null);
    }
  }, []);

  useEffect(() => {
    void refreshStat();
  }, [refreshStat]);

  const autoMemory = settings?.autoMemory ?? true;
  const toggleAutoMemory = async (v: boolean) => {
    try {
      await patchSettings({ autoMemory: v });
      toast(v ? t("自动记忆已开启：对话后自动提取，生成时注入上下文") : t("自动记忆已关闭：仅手动管理记忆"), "ok");
    } catch (e) {
      toast(t("保存失败：{msg}", { msg: errMsg(e) }), "err");
    }
  };

  const clearAll = async () => {
    setConfirmClear(false);
    try {
      const list = await api.memoryList();
      let ok = 0;
      for (const m of list) {
        try { await api.memoryDelete(m.id); ok += 1; } catch { /* 单条失败继续 */ }
      }
      await refreshStat();
      toast(t("已清空 {ok}/{total} 条记忆", { ok, total: list.length }), ok === list.length ? "ok" : "warn");
    } catch (e) {
      toast(t("清空失败：{msg}", { msg: errMsg(e) }), "err");
    }
  };

  return (
    <div className="card mem-card">
      <style>{MEM_CSS}</style>
      <h3>{t("🧠 意识模块（记忆）")}</h3>
      <div className="hint" style={{ marginBottom: 8 }}>
        {t("Agent 的长期记忆，随项目保存在本机；生成时作为上下文参考。")}
      </div>

      {/* 行1：自动记忆开关 */}
      <div className="mem-setting-row" onClick={(e) => { if ((e.target as HTMLElement).tagName !== "INPUT") void toggleAutoMemory(!autoMemory); }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="mem-setting-title">{t("启用自动记忆")}</div>
          <div className="hint">{t("每轮对话自动提取值得记住的信息存入本机，并在后续对话/生成时自动作为上下文（数据不出本机）")}</div>
        </div>
        <input type="checkbox" checked={autoMemory} onChange={(e) => void toggleAutoMemory(e.target.checked)} />
      </div>

      {/* 行2：编辑记忆（打开管理弹窗） */}
      <div className="mem-setting-row" onClick={() => { if (!notOpen) setManagerOpen(true); }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="mem-setting-title">{t("编辑记忆")}</div>
          <div className="hint">
            {notOpen
              ? t("意识模块按项目存储，请先在工作区打开一个项目")
              : count === null
                ? t("加载中…")
                : t("{n} 条记忆 · 最近更新 {time}", { n: count, time: latestLabel })}
          </div>
        </div>
        <button className="btn sm" disabled={notOpen} onClick={(e) => { e.stopPropagation(); if (!notOpen) setManagerOpen(true); }}>
          {t("管理 ›")}
        </button>
      </div>

      {/* 行3：清空全部记忆（危险） */}
      <div className="mem-setting-row">
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="mem-setting-title">{t("清空全部记忆")}</div>
          <div className="hint">{t("删除本项目内的全部记忆（含自动与手动），不可恢复")}</div>
        </div>
        <button className="btn sm danger" disabled={notOpen || count === 0} onClick={() => setConfirmClear(true)}>
          {t("清空")}
        </button>
      </div>

      {managerOpen && (
        <MemoryManagerModal
          onClose={() => {
            setManagerOpen(false);
            void refreshStat();
          }}
        />
      )}
      {confirmClear && (
        <ConfirmDialog
          title={t("清空全部记忆")}
          message={t("将删除本项目内的全部记忆（含自动提取与手动添加），不可恢复。确定继续？")}
          danger
          onCancel={() => setConfirmClear(false)}
          onConfirm={() => void clearAll()}
        />
      )}
    </div>
  );
}

/* ---------------- 意识模块（记忆）卡片局部样式（补充 global.css，深色一致） ---------------- */

export const MEM_CSS = `
.mem-card { margin-bottom: 14px; align-self: stretch; height: 100%; display: flex; flex-direction: column; }
.mem-setting-row {
  display: flex; align-items: center; gap: 12px; margin-bottom: 8px;
  background: var(--panel-2); border: 1px solid var(--border); border-radius: 10px;
  padding: 10px 12px; cursor: pointer; transition: border-color .15s ease;
}
.mem-setting-row:hover { border-color: var(--border-strong); }
.mem-setting-row:last-of-type { margin-bottom: 0; }
.mem-setting-title { font-size: 12.5px; font-weight: 600; margin-bottom: 2px; }
.mem-setting-row .hint { font-size: 11.5px; }
.mem-setting-row input[type="checkbox"] { width: 17px; height: 17px; flex-shrink: 0; cursor: pointer; }
.mem-list { flex: 1 1 auto; min-height: 140px; }
.mem-stats { display: flex; align-items: center; gap: 8px; font-size: 12px; color: var(--text-dim); margin-bottom: 8px; flex-wrap: wrap; }
.mem-stats b { color: var(--text); }
.mem-sep { color: var(--border-strong); }
.mem-search {
  width: 100%; margin-bottom: 10px;
  background: var(--bg-deep); border: 1px solid var(--border-strong);
  border-radius: 10px; padding: 8px 12px; color: var(--text); font-size: 12.5px;
}
.mem-search:focus { outline: none; border-color: var(--blue); box-shadow: 0 0 0 3px rgba(77,124,254,.18); }
.mem-bulk {
  display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
  background: var(--panel-2); border: 1px solid var(--border);
  border-radius: 8px; padding: 8px 10px; margin-bottom: 10px; font-size: 12px;
}
.mem-timeline { position: relative; padding-left: 18px; }
.mem-timeline::before {
  content: ""; position: absolute; left: 5px; top: 8px; bottom: 8px;
  width: 2px; background: var(--border); border-radius: 2px; opacity: .6;
}
.mem-list { display: flex; flex-direction: column; gap: 8px; margin-bottom: 12px; max-height: 46vh; overflow: auto; }
.mem-row {
  position: relative;
  border: 1px solid var(--border); border-radius: var(--radius-sm);
  background: var(--bg-deep); padding: 8px 10px;
  display: flex; flex-direction: column; gap: 6px;
  transition: border-color .15s ease;
}
.mem-row:hover { border-color: var(--border-strong); }
.mem-dot {
  width: 9px; height: 9px; border-radius: 50%; flex-shrink: 0;
  background: var(--blue); box-shadow: 0 0 0 3px rgba(77,124,254,.18);
}
.mem-row-head { display: flex; align-items: center; gap: 7px; flex-wrap: wrap; min-height: 20px; }
.mem-time { font-size: 11.5px; color: var(--muted); font-variant-numeric: tabular-nums; }
.mem-scope { font-size: 10.5px; padding: 1px 7px; }
.mem-row-actions { display: inline-flex; align-items: center; gap: 2px; }
.mem-row-actions button {
  background: none; border: none; cursor: pointer; font-family: var(--font);
  color: var(--muted); font-size: 11.5px; padding: 2px 7px; border-radius: 5px;
}
.mem-row-actions button:hover { color: var(--text); background: rgba(255,255,255,.08); }
.mem-danger-btn:hover { color: var(--red) !important; background: rgba(255,84,112,.12) !important; }
.mem-chars { font-size: 11px; color: var(--muted); }
.mem-text { font-size: 12.5px; color: var(--text); white-space: pre-wrap; word-break: break-word; user-select: text; }
.mem-text.clamped {
  display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 3; overflow: hidden;
}
.mem-text.clickable { cursor: pointer; }
.mem-toggle {
  align-self: flex-start; background: none; border: none; padding: 0;
  font-size: 11px; color: var(--cyan); cursor: pointer; user-select: none;
}
.mem-toggle:hover { text-decoration: underline; }
.mem-edit { min-height: 64px; resize: vertical; width: 100%; }
.mem-composer {
  border: 1px solid var(--border-strong); border-radius: 10px;
  background: var(--bg-deep); padding: 10px;
  transition: border-color .15s ease, box-shadow .15s ease;
}
.mem-composer:focus-within { border-color: var(--blue); box-shadow: 0 0 0 3px rgba(77,124,254,.15); }
.mem-composer .mem-edit { border: none; background: transparent; box-shadow: none; padding: 0; min-height: 44px; }
.mem-composer .mem-edit:focus { outline: none; }
.mem-composer-bar { display: flex; align-items: center; gap: 8px; margin-top: 6px; }
.mem-empty { text-align: center; padding: 26px 12px 18px; }
.mem-empty-icon { font-size: 34px; margin-bottom: 6px; opacity: .85; }
.mem-empty-title { font-size: 14px; font-weight: 600; margin-bottom: 4px; }
.mem-notice {
  border: 1px dashed var(--border-strong); border-radius: var(--radius-sm);
  padding: 10px 12px; color: var(--amber, #ffb454);
}
`;
