/**
 * 设置视图 —— 隐私 / 意识模块（记忆）/ FFmpeg / 并发 / 外观与主题（v2.1）/ 账户安全（v2.1）。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";
import * as api from "../api";
import { costsGet, memorySearch } from "../api-extras";
import { useApp } from "../store";
import { getLang, setLang, t, useT } from "../i18n";

/** Tauri 命令 Err 时前端拿到 {message} 对象，统一提取可读文案 */
const errMsg = (e: unknown): string => {
  if (typeof e === "string") return e;
  if (e && typeof e === "object" && "message" in e) return String((e as { message: unknown }).message);
  try { return JSON.stringify(e); } catch { return String(e); }
};

/* ---------------- 🧠 意识模块（记忆）卡片 ---------------- */

/** 记忆条目行：scope tag + 文本（点击展开/收起）+ 就地编辑 + 删除 */
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
  onEdit,
}: {
  rec: api.MemoryRecord;
  checked: boolean;
  multiSelect: boolean;
  saving: boolean;
  onCheck: (id: string, v: boolean) => void;
  onSave: (id: string, text: string) => Promise<void>;
  onDelete: (id: string) => void;
  onEdit: (id: string) => void;
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
          <button className="btn sm" onClick={stop(() => { setEditing(false); setText(rec.text); onEdit(""); })}>{t("取消")}</button>
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
          <button title={t("编辑")} onClick={stop(() => { setEditing(true); setText(rec.text); onEdit(rec.id); })}>{t("编辑")}</button>
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

function MemoryCard() {
  const { toast } = useApp();
  const t = useT();
  const [records, setRecords] = useState<api.MemoryRecord[] | null>(null);
  const [notOpen, setNotOpen] = useState(false);
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
    setNotOpen(false);
    setLoadErr("");
    try {
      setRecords(await api.memoryList());
    } catch (e) {
      const msg = errMsg(e);
      if (msg.includes("未打开项目")) {
        setNotOpen(true);
        setRecords(null);
      } else {
        setLoadErr(msg);
      }
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const list = records ?? [];
  const q = query.trim().toLowerCase();
  // v2.14 语义搜索：后端余弦相似度排序（含 includes 兜底；后端不可用时不影响原行为）
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
      ? // 语义排序：命中分 > 0 的按分排序，includes 命中的必定分高；零分记录按原序垫底
        list
          .map((m, i) => ({ m, i, score: semanticIds.get(m.id) ?? 0, includes: m.text.toLowerCase().includes(q) ? 2 : 0 }))
          .filter((x) => x.score > 0 || x.includes)
          .sort((a, b) => b.score + b.includes - (a.score + a.includes) || a.i - b.i)
          .map((x) => x.m)
      : list.filter((m) => m.text.toLowerCase().includes(q))
    : list;
  const latest = list.length
    ? list.reduce((a, b) => ((a.createdAt ?? a.created_at ?? "") > (b.createdAt ?? b.created_at ?? "") ? a : b))
    : null;

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
    <div className="card mem-card">
      <h3>{t("🧠 意识模块（记忆）")}</h3>
      <div className="hint" style={{ marginBottom: 8 }}>
        {t("Agent 的长期记忆，随项目保存在本机；生成时作为上下文参考。支持搜索、批量管理与导入导出。")}
      </div>

      {notOpen ? (
        <div className="hint mem-notice">{t("意识模块按项目存储，请先在工作区打开一个项目")}</div>
      ) : loadErr ? (
        <div className="hint mem-notice">{t("加载失败：{msg}", { msg: loadErr })}</div>
      ) : records === null ? (
        <div className="hint">{t("加载中…")}</div>
      ) : (
        <>
          {/* 统计条 */}
          <div className="mem-stats">
            <span><b>{list.length}</b> {t("条记忆")}</span>
            <span className="mem-sep">·</span>
            <span>{t("最近更新 {time}", { time: latest ? memRelTime(latest.createdAt ?? latest.created_at ?? "") : "—" })}</span>
            <span className="mem-sep">·</span>
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

          {/* 搜索 */}
          {list.length > 0 && (
            <input
              className="mem-search"
              type="text"
              placeholder={t("🔍 搜索记忆（语义排序：相关度优先）…")}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
            />
          )}

          {/* 批量操作条 */}
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

          {/* 时间线列表 */}
          {list.length === 0 ? (
            <div className="mem-empty">
              <div className="mem-empty-icon">🧠</div>
              <div className="mem-empty-title">{t("还没有记忆")}</div>
              <div className="hint">{t("把主角设定、风格约定、剧情要点告诉 Agent —— 在下方输入第一条记忆，生成剧本/分镜时会自动参考")}</div>
              <button className="btn primary sm" style={{ marginTop: 10 }} onClick={() => newTextRef.current?.focus()}>
                {t("写下第一条记忆")}
              </button>
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
                  onEdit={() => {}}
                />
              ))}
            </div>
          )}

          {/* 常驻输入区（Codex 式） */}
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
  );
}

export default function SettingsView() {
  const { settings, patchSettings, ffmpeg, loadFfmpeg, toast, loadSettings, appVersion } = useApp();
  const t = useT();
  const [ffmpegPath, setFfmpegPath] = useState(settings?.ffmpegPath ?? "");
  const [auth, setAuth] = useState<api.AuthStatus | null>(null);
  const [dataDir, setDataDir] = useState<string>("");
  const [checking, setChecking] = useState(false);
  const [updateMsg, setUpdateMsg] = useState("");

  useEffect(() => {
    api.appInfo().then((info) => setDataDir(info.dataDir)).catch(() => {});
  }, []);

  const checkUpdate = async () => {
    setChecking(true);
    setUpdateMsg("");
    try {
      // v2.3.2：本地版本，无更新服务器；后续接入发布源后在此返回真实结果
      await new Promise((r) => setTimeout(r, 600));
      setUpdateMsg(t("这已经是最新版本"));
      toast(t("这已经是最新版本"), "ok");
    } finally {
      setChecking(false);
    }
  };

  // v2.3.5 测试时钟钩子入口：连点版本号 5 次唤出（时间边界测试用，普通用户无感）
  const [verClicks, setVerClicks] = useState(0);
  const [timeHookOpen, setTimeHookOpen] = useState(false);
  const [offsetInput, setOffsetInput] = useState("0");
  const [hookStatus, setHookStatus] = useState<string>("");

  const onVersionClick = () => {
    setVerClicks((c) => {
      if (c + 1 >= 5) {
        setTimeHookOpen(true);
        setVerClicks(0);
        return 0;
      }
      // 3 秒内连点才累计
      window.setTimeout(() => setVerClicks(0), 3000);
      return c + 1;
    });
  };

  const applyTimeOffset = async () => {
    const secs = Number(offsetInput);
    if (!Number.isFinite(secs)) { setHookStatus(t("偏移量必须是整数秒（可为负）")); return; }
    try {
      await api.debugSetTimeOffset(Math.trunc(secs));
      const st = await api.debugSessionStatus();
      const remain = st.remainingSecs === null ? t("无会话") : t("{d}天{h}时{m}分", { d: Math.floor(st.remainingSecs / 86400), h: Math.floor((st.remainingSecs % 86400) / 3600), m: Math.floor((st.remainingSecs % 3600) / 60) });
      setHookStatus(t("已设置偏移 {secs}s（正值=时钟前移）。会话剩余：{remain}。设为 0 恢复真实时钟。", { secs: st.offsetSecs, remain }));
    } catch (e) {
      setHookStatus(t("设置失败：{msg}", { msg: errMsg(e) }));
    }
  };

  const pickDefaultFolder = async () => {
    try {
      const dir = await api.projectPickDirectory(t("选择默认项目文件夹（新项目将创建在这里）"));
      if (!dir) return;
      await patchSettings({ defaultProjectFolder: dir });
      toast(t("默认项目文件夹已保存"), "ok");
    } catch (e) {
      toast(t("设置失败：{msg}", { msg: errMsg(e) }), "err");
    }
  };

  const clearDefaultFolder = async () => {
    await patchSettings({ defaultProjectFolder: "" });
    toast(t("已清除默认项目文件夹"), "ok");
  };

  // 账户表单
  // v2.10 预算守卫
  const [cgEnabled, setCgEnabled] = useState(false);
  const [cgDaily, setCgDaily] = useState(100);
  const [cgTotal, setCgTotal] = useState(1000);
  // v2.11.1 当前项目远程生成用量（看板数据）
  const [costs, setCosts] = useState<{ today: number; total: number; todayCost: number; totalCost: number } | null>(null);
  const projectTitle = useApp((s) => s.project?.project?.title ?? null);
  useEffect(() => {
    costsGet()
      .then((c) => setCosts({ today: c.today, total: c.total, todayCost: c.todayCost, totalCost: c.totalCost }))
      .catch(() => setCosts(null));
  }, [projectTitle]);
  const costsTodayCost = costs?.todayCost ?? 0;
  const costsTotalCost = costs?.totalCost ?? 0;
  const [curPass, setCurPass] = useState("");
  const [newUser, setNewUser] = useState("");
  const [newPass, setNewPass] = useState("");
  const [email, setEmail] = useState("");
  const [accErr, setAccErr] = useState("");
  const [accBusy, setAccBusy] = useState(false);

  // v2.2 邮件发送设置（验证码验证暂未启用，SMTP 配置保留用于测试邮件与后续恢复）
  const [mailInfo, setMailInfo] = useState<api.MailConfigInfo | null>(null);
  const [smtpHost, setSmtpHost] = useState("");
  const [smtpPort, setSmtpPort] = useState(465);
  const [useTls, setUseTls] = useState(true);
  const [smtpAuth, setSmtpAuth] = useState("");
  const [mailMsg, setMailMsg] = useState("");

  // 皮肤不透明度：拖动只改本地（避免每个 tick 写盘+受控回跳），松手才提交
  const [skinOpacityLocal, setSkinOpacityLocal] = useState<number | null>(null);
  const skinOpacityShown = skinOpacityLocal ?? (settings?.skinOpacity ?? 0.18);

  const lookupMail = (e: string) => {
    if (!e.includes("@")) { setMailInfo(null); return; }
    api.mailConfigGet(e.trim()).then((m) => {
      setMailInfo(m);
      if (m.configured && m.host) {
        setSmtpHost(m.host);
        setSmtpPort(m.port ?? 465);
        setUseTls(m.useTls ?? true);
      } else if (m.preset) {
        setSmtpHost(m.preset[0]);
        setSmtpPort(m.preset[1]);
        setUseTls(m.preset[2]);
      }
    }).catch(() => {});
  };

  const refreshAuth = () => api.authStatus().then(setAuth).catch(() => {});
  useEffect(() => {
    refreshAuth();
  }, []);

  useEffect(() => {
    setFfmpegPath(settings?.ffmpegPath ?? "");
    setCgEnabled(settings?.costGuard?.enabled ?? false);
    setCgDaily(settings?.costGuard?.dailyRemoteLimit ?? 100);
    setCgTotal(settings?.costGuard?.projectTotalLimit ?? 1000);
  }, [settings?.ffmpegPath, settings?.costGuard]);

  if (!settings) return <div className="page hint">{t("加载中…")}</div>;

  const saveFfmpeg = async () => {
    try {
      await patchSettings({ ffmpegPath: ffmpegPath.trim() || undefined });
      await loadFfmpeg();
      toast(t("设置已保存"), "ok");
    } catch (e) {
      if (!errMsg(e).includes("已取消")) toast(t("保存失败：{msg}", { msg: errMsg(e) }), "err");
    }
  };

  const saveAppearance = async (patch: Partial<api.AppSettings>) => {
    await patchSettings(patch);
    toast(t("外观已更新"), "ok");
  };

  const saveCostGuard = (patch: { enabled?: boolean; dailyRemoteLimit?: number; projectTotalLimit?: number }) => {
    const next = {
      enabled: patch.enabled ?? cgEnabled,
      dailyRemoteLimit: Math.max(1, Math.round(patch.dailyRemoteLimit ?? cgDaily)),
      projectTotalLimit: Math.max(1, Math.round(patch.projectTotalLimit ?? cgTotal)),
    };
    void patchSettings({ costGuard: next })
      .then(() => toast(t("预算守卫已更新"), "ok"))
      .catch((e) => toast(t("保存失败：{msg}", { msg: errMsg(e) }), "err"));
  };

  const submitAccount = async () => {
    setAccErr("");
    setAccBusy(true);
    try {
      const hasAnything = newUser.trim() || newPass || email.trim();
      if (!hasAnything) {
        setAccErr(t("请至少填写一项要修改的内容"));
        return;
      }
      await api.authChangeCredentials({
        currentPassword: curPass,
        newUsername: newUser.trim() || undefined,
        newPassword: newPass || undefined,
        email: email.trim() || undefined,
      });
      toast(t("账户信息已更新"), "ok");
      setCurPass("");
      setNewUser("");
      setNewPass("");
      setEmail("");
      refreshAuth();
      // 若改了用户名/密码，退出登录要求重新验证
      if (newPass) {
        await api.authLogout();
        useApp.getState().setAuthed(false);
      }
    } catch (e) {
      setAccErr(errMsg(e));
    } finally {
      setAccBusy(false);
    }
  };

  const uploadSkin = async () => {
    try {
      await api.themeSetSkin();
      await loadSettings();
      toast(t("皮肤已应用"), "ok");
    } catch (e) {
      if (!errMsg(e).includes("取消")) toast(t("皮肤设置失败：{msg}", { msg: errMsg(e) }), "err");
    }
  };

  const clearSkin = async () => {
    await api.themeClearSkin();
    await loadSettings();
    toast(t("已恢复默认背景"), "ok");
  };

  return (
    <div className="page">
      <style>{MEM_CSS}</style>
      <style>{PRIV_CSS}</style>
      <div className="page-header">
        <div>
          <h1>{t("设置")}</h1>
          <div className="desc">{t("隐私与安全是默认值，不是选项")}</div>
        </div>
      </div>

      <div className="grid-2">
        {/* 外观设置（v2.1）—— alignSelf:start 避免被右侧更高的卡片拉伸出大片空白 */}
        <div className="card" style={{ alignSelf: "start" }}>
          <h3>{t("🎨 外观设置")}</h3>
          <div className="field">
            <label>{t("外观模式")}</label>
            <div style={{ display: "flex", gap: 8 }}>
              <button
                className={`btn ${settings.theme !== "light" ? "primary" : ""}`}
                onClick={() => saveAppearance({ theme: "dark" })}
              >
                {t("🌙 暗色")}
              </button>
              <button
                className={`btn ${settings.theme === "light" ? "primary" : ""}`}
                onClick={() => saveAppearance({ theme: "light" })}
              >
                {t("☀️ 浅色")}
              </button>
            </div>
          </div>

          <div className="field">
            <label>{t("界面语言")}</label>
            <div style={{ display: "flex", gap: 8 }}>
              <button
                className={`btn ${getLang() !== "en" ? "primary" : ""}`}
                onClick={() => setLang("zh")}
              >
                中文
              </button>
              <button
                className={`btn ${getLang() === "en" ? "primary" : ""}`}
                onClick={() => setLang("en")}
              >
                English
              </button>
            </div>
          </div>

          <div className="field">
            <label>{t("主题皮肤")}</label>
            <div className="hint" style={{ marginBottom: 8 }}>
              {t("内置两套主题（暗色霓虹 / 浅色晨雾）。上传图片可作全局背景皮肤（类似 Aion UI 的自定义皮肤）， 仅存本机。")}
            </div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <button
                className={`btn ${!settings.skin ? "blue" : ""}`}
                onClick={clearSkin}
              >
                {t("默认渐变背景")}
              </button>
              <button className="btn" onClick={uploadSkin}>{t("🖼️ 上传图片皮肤…")}</button>
              {settings.skin && (
                <button className="btn danger" onClick={clearSkin}>{t("清除皮肤")}</button>
              )}
            </div>
            {settings.skin && (
              <div className="kv" style={{ marginTop: 8 }}>
                <span className="k">{t("当前皮肤")}</span>
                <span className="v">{settings.skin}</span>
              </div>
            )}
          </div>

          <div className="field">
            <label>{t("皮肤清晰度：{n}%（数值越小皮肤越明显）", { n: Math.round(skinOpacityShown * 100) })}</label>
            <input
              type="range"
              min={0}
              max={50}
              value={Math.round(skinOpacityShown * 100)}
              onChange={(e) => {
                const v = Number(e.target.value) / 100;
                setSkinOpacityLocal(v);
                // 实时预览：只改前端变量，不写盘
                const layer = document.querySelector<HTMLDivElement>(".skin-layer");
                if (layer && settings.skin) {
                  const img = `url(onetv-app://localhost/${encodeURIComponent(settings.skin)})`;
                  const veil = Math.min(0.92, Math.max(0, 1 - v * 2));
                  const rgb = settings.theme === "light" ? "242, 244, 250" : "10, 13, 24";
                  layer.style.backgroundImage = `linear-gradient(rgba(${rgb}, ${veil.toFixed(2)}), rgba(${rgb}, ${veil.toFixed(2)})), ${img}`;
                }
              }}
              onPointerUp={() => {
                if (skinOpacityLocal !== null) {
                  void patchSettings({ skinOpacity: skinOpacityLocal });
                  setSkinOpacityLocal(null);
                }
              }}
              onKeyUp={() => {
                if (skinOpacityLocal !== null) {
                  void patchSettings({ skinOpacity: skinOpacityLocal });
                  setSkinOpacityLocal(null);
                }
              }}
              onBlur={() => {
                // 拖动中失焦（如切窗口/点其他控件）时兜底提交，避免丢值
                if (skinOpacityLocal !== null) {
                  void patchSettings({ skinOpacity: skinOpacityLocal });
                  setSkinOpacityLocal(null);
                }
              }}
            />
            {settings.skin && (
              <div style={{ marginTop: 14 }}>
                {/* 通栏大图预览：占满卡片宽度，清晰度遮罩与滑杆实时联动，效果即主界面所见 */}
                <div
                  style={{
                    width: "100%",
                    height: 300,
                    borderRadius: 12,
                    position: "relative",
                    overflow: "hidden",
                    border: "1px solid var(--border-strong)",
                    boxShadow: "0 4px 18px rgba(0,0,0,.22)",
                    backgroundImage: `linear-gradient(rgba(${
                      settings.theme === "light" ? "242,244,250" : "10,13,24"
                    }, ${Math.min(0.92, Math.max(0, 1 - skinOpacityShown * 2)).toFixed(2)}), rgba(${
                      settings.theme === "light" ? "242,244,250" : "10,13,24"
                    }, ${Math.min(0.92, Math.max(0, 1 - skinOpacityShown * 2)).toFixed(2)})), url(onetv-app://localhost/${encodeURIComponent(settings.skin)})`,
                    backgroundSize: "cover",
                    backgroundPosition: "center",
                  }}
                  title={t("当前皮肤预览（随清晰度滑杆实时变化，与主界面实际效果一致）")}
                >
                  <div
                    style={{
                      position: "absolute", left: 0, right: 0, bottom: 0,
                      padding: "26px 14px 10px",
                      background: "linear-gradient(transparent, rgba(0,0,0,.55))",
                      color: "#fff", fontSize: 12.5,
                      display: "flex", alignItems: "baseline", gap: 10,
                    }}
                  >
                    <b style={{ fontSize: 13 }}>{t("当前皮肤")}</b>
                    <span style={{ opacity: .85 }}>{settings.skin}</span>
                    <span style={{ flex: 1 }} />
                    <span style={{ opacity: .85 }}>{t("清晰度 {n}%", { n: Math.round(skinOpacityShown * 100) })}</span>
                  </div>
                </div>
                <div className="hint" style={{ marginTop: 8 }}>
                  {t("预览随上方滑杆实时变化，与主界面实际效果一致；拖动「清晰度」可调整皮肤浓淡。")}
                </div>
              </div>
            )}
          </div>
        </div>

        {/* 预算守卫（v2.10） */}
        <div className="card" style={{ alignSelf: "stretch", height: "100%", display: "flex", flexDirection: "column" }}>
          <h3 style={{ flexShrink: 0 }}>{t("💰 预算守卫")}</h3>
          <div className="hint" style={{ flexShrink: 0 }}>
            {t("限制远程生成（生图 / 生视频 / 配音）的调用次数，防止意外烧钱。本地 Mock / ComfyUI / Ollama 不计数。")}
          </div>
          <label style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 10, cursor: "pointer", flexShrink: 0 }}>
            <input
              type="checkbox"
              checked={cgEnabled}
              onChange={(e) => { setCgEnabled(e.target.checked); saveCostGuard({ enabled: e.target.checked }); }}
            />
            <span style={{ fontSize: 12.5 }}>{t("启用预算守卫（达到上限后新任务会被拦截并提示）")}</span>
          </label>
          <div className="grid-2" style={{ marginTop: 10 }}>
            <div className="field">
              <label>{t("每日上限（次 / 项目）")}</label>
              <input
                type="number" min={1}
                value={cgDaily}
                disabled={!cgEnabled}
                onChange={(e) => setCgDaily(Number(e.target.value) || 0)}
                onBlur={() => saveCostGuard({ dailyRemoteLimit: cgDaily })}
              />
            </div>
            <div className="field">
              <label>{t("项目累计上限（次）")}</label>
              <input
                type="number" min={1}
                value={cgTotal}
                disabled={!cgEnabled}
                onChange={(e) => setCgTotal(Number(e.target.value) || 0)}
                onBlur={() => saveCostGuard({ projectTotalLimit: cgTotal })}
              />
            </div>
          </div>
          <div className="hint" style={{ flexShrink: 0, marginBottom: 4 }}>{t("计数在任务成功后写入项目 costs.json（不出本机）。")}{projectTitle ? t("当前项目：{name}", { name: projectTitle }) : t("未打开项目——打开项目后显示真实用量")}</div>

          {/* 用量看板（v2.11.1）：与隐私卡同款瓷贴，随卡片高度自动铺满 */}
          <div className="prv-tiles">
            <div className="prv-tile prv-t2">
              <span className="prv-tic">📊</span>
              <div><b>{t("今日已用 {n}", { n: costs ? t("{n} 次", { n: costs.today }) : "—" })}</b><span className="prv-td">{t("每日上限 {n} 次（{status}）", { n: settings?.costGuard?.dailyRemoteLimit ?? 100, status: cgEnabled ? t("守卫中") : t("守卫未启用") })}</span></div>
            </div>
            <div className="prv-tile prv-t1">
              <span className="prv-tic">💰</span>
              <div><b>{t("项目累计 {n}", { n: costs ? t("{n} 次", { n: costs.total }) : "—" })}</b><span className="prv-td">{t("累计上限 {n} 次", { n: settings?.costGuard?.projectTotalLimit ?? 1000 })}</span></div>
            </div>
            <div className="prv-tile prv-t3">
              <span className="prv-tic">🛡️</span>
              <div><b>{t("超限自动拦截")}</b><span className="prv-td">{t("达到上限后新任务不提交、不扣费，给出可读提示")}</span></div>
            </div>
            <div className="prv-tile prv-t4">
              <span className="prv-tic">🏠</span>
              <div><b>{t("本地任务不计数")}</b><span className="prv-td">{t("Mock / ComfyUI / Ollama 本地创作随便跑")}</span></div>
            </div>
          </div>
        </div>

        {/* 账户安全（v2.1） */}
        <div className="card">
          <h3>{t("👤 账户安全")}</h3>
          {auth ? (
            <>
              <div className="kv"><span className="k">{t("用户名")}</span><span className="v">{auth.username}</span></div>
              <div className="kv">
                <span className="k">{t("绑定邮箱")}</span>
                <span className="v">
                  {auth.email ? (
                    auth.email
                  ) : (
                    <span className="tag amber">{t("未绑定（修改用户名/密码前必须绑定）")}</span>
                  )}
                </span>
              </div>
              {auth.hasDefaultPassword && (
                <div className="kv">
                  <span className="k"></span>
                  <span className="v"><span className="tag red">{t("仍在使用默认密码 12345，请尽快修改（未修改前忘记密码不可用，请按默认方式登录）")}</span></span>
                </div>
              )}
              <div style={{ borderTop: "1px solid var(--border)", margin: "10px 0" }} />
              <div className="field">
                <label>{t("当前密码（必填）")}</label>
                <input type="password" value={curPass} onChange={(e) => setCurPass(e.target.value)} />
              </div>
              <div className="grid-2">
                <div className="field">
                  <label>{t("新用户名（可选）")}</label>
                  <input type="text" placeholder={t("保持不变则留空")} value={newUser} onChange={(e) => setNewUser(e.target.value)} />
                </div>
                <div className="field">
                  <label>{t("新密码（可选，≥5 位）")}</label>
                  <input type="password" placeholder={t("保持不变则留空")} value={newPass} onChange={(e) => setNewPass(e.target.value)} />
                </div>
              </div>
              <div className="field">
                <label>
                  {t("绑定/更换邮箱")}{auth.email ? t("（当前 {email}）", { email: auth.email }) : t("（必填——未绑定邮箱时修改用户名/密码必须同时填写）")}
                </label>
                <input
                  type="text"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  placeholder="you@example.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  onBlur={() => lookupMail(email)}
                />
              </div>
              {email.trim().includes("@") && mailInfo && (
                <div className="field" style={{ background: "var(--panel-2)", borderRadius: 8, padding: 12, border: "1px solid var(--border)" }}>
                  <label>{t("📧 邮件发送设置（本机软件经此 SMTP 直发邮件，无须任何服务器；授权码只存本机钥匙串）")}</label>
                  <div className="grid-2">
                    <div className="field">
                      <label>{t("SMTP 服务器")}{mailInfo.preset ? t("（已按邮箱自动匹配预设）") : ""}</label>
                      <input type="text" value={smtpHost} onChange={(e) => setSmtpHost(e.target.value)} placeholder="smtp.qq.com" />
                    </div>
                    <div className="field">
                      <label>{t("端口（465=TLS / 587=STARTTLS）")}</label>
                      <input type="number" value={smtpPort} onChange={(e) => { const v = Number(e.target.value); setSmtpPort(v); setUseTls(v === 465); }} />
                    </div>
                  </div>
                  <div className="field">
                    <label>{t("SMTP 授权码（不是邮箱登录密码；QQ/163 邮箱在设置中开启 SMTP 后获取）")}</label>
                    <input type="password" value={smtpAuth} onChange={(e) => setSmtpAuth(e.target.value)} placeholder="••••••••••••" />
                  </div>
                  <div style={{ display: "flex", gap: 8 }}>
                    <button
                      className="btn blue"
                      disabled={!smtpHost || !smtpAuth || !email.trim()}
                      onClick={async () => {
                        setMailMsg("");
                        try {
                          await api.mailConfigSave({ email: email.trim(), smtpHost: smtpHost.trim(), smtpPort, useTls, authCode: smtpAuth });
                          lookupMail(email);
                          setMailMsg(t("✅ 已保存"));
                        } catch (e) {
                          setMailMsg(t("⚠️ {msg}", { msg: errMsg(e) }));
                        }
                      }}
                    >
                      {t("保存发送设置")}
                    </button>
                    <button
                      className="btn"
                      disabled={!mailInfo?.configured}
                      onClick={async () => {
                        setMailMsg("");
                        try {
                          const r = await api.mailTestSend(email.trim());
                          setMailMsg(r.ok ? t("✅ {msg}", { msg: r.message }) : t("⚠️ {msg}", { msg: r.message }));
                        } catch (e) {
                          setMailMsg(t("⚠️ {msg}", { msg: errMsg(e) }));
                        }
                      }}
                    >
                      {t("发送测试邮件")}
                    </button>
                    {useTls && <span className="tag blue">TLS</span>}
                  </div>
                  {mailMsg && <div className="hint" style={{ marginTop: 6 }}>{mailMsg}</div>}
                  <div className="hint" style={{ marginTop: 6 }}>
                    {t("常见服务商：QQ/foxmail → smtp.qq.com:465 ｜ 163 → smtp.163.com:465 ｜ 126 → smtp.126.com:465 ｜ Gmail → smtp.gmail.com:465")}
                  </div>
                </div>
              )}
              {accErr && <div className="login-err">{t("⚠️ {msg}", { msg: accErr })}</div>}
              <button className="btn primary" disabled={accBusy} onClick={submitAccount}>
                {accBusy ? t("保存中…") : t("保存账户修改")}
              </button>
              <div className="hint" style={{ marginTop: 10 }}>
                {t("忘记密码可在登录页凭绑定邮箱重置（本地验证邮箱地址一致即可）。修改密码后需重新登录。")}
              </div>
              <div
                style={{
                  marginTop: 12,
                  padding: "10px 12px",
                  borderRadius: 8,
                  background: "rgba(53, 208, 127, 0.08)",
                  border: "1px solid rgba(53, 208, 127, 0.3)",
                  fontSize: 12,
                  color: "var(--text-dim)",
                }}
              >
                {t("🔒 本 agent 为开源平台，你的密码和账号只会存储到本地，不会上传给任何第三方。")}
              </div>
              <button
                className="btn danger"
                style={{ marginTop: 12 }}
                onClick={async () => {
                  try {
                    await api.authLogout();
                    useApp.getState().setAuthed(false);
                  } catch (e) {
                    toast(t("退出失败：{msg}", { msg: errMsg(e) }), "err");
                  }
                }}
              >
                {t("退出账号")}
              </button>
            </>
          ) : (
            <div className="hint">{t("加载中…")}</div>
          )}
        </div>

        {/* 隐私（v2.5：普通网格子项，列宽与上下行对齐；height:100% 保证与同行卡片等高） */}
        <div className="card prv-card" style={{ alignSelf: "stretch", height: "100%", display: "flex", flexDirection: "column" }}>
          <h3>{t("🛡️ 隐私")}</h3>
          <label className="checkbox-row" style={{ marginBottom: 8 }}>
            <input
              type="checkbox"
              checked
              onChange={() =>
                toast(t("OneTV 采用本地优先设计：代码中不存在任何遥测 SDK，因此该选项始终开启，也不会收集任何数据"), "info")
              }
            />
            {t("禁用遥测（默认关闭，代码中不存在任何分析 SDK）（本项始终开启：无遥测可禁用）")}
          </label>
          <label className="checkbox-row" style={{ marginBottom: 8 }}>
            <input
              type="checkbox"
              checked={settings.offlineMode}
              onChange={(e) => patchSettings({ offlineMode: e.target.checked }).then(() => toast(e.target.checked ? t("已开启 Local-only：公网 Provider 请求将被拒绝") : t("已关闭 Local-only"), "ok"))}
            />
            {t("Local-only 完全离线模式（仅本机 Ollama / ComfyUI / SD WebUI 可用）")}
          </label>
          <div className="hint">
            {t("开启后：所有云端 Provider 变灰并被策略引擎拒绝；项目管理、剧本、分镜、素材与 FFmpeg 合成不受影响。")}
          </div>

          {/* 数据看板（v2.4.6，方案A）：四块安全状态瓷贴，随卡片高度自动铺满 */}
          <div className="prv-tiles">
            <div className="prv-tile prv-t1">
              <span className="prv-tic">🚫</span>
              <div><b>{t("遥测 SDK：0 个")}</b><span className="prv-td">{t("代码中不存在任何分析/上报组件")}</span></div>
            </div>
            <div className="prv-tile prv-t2">
              <span className="prv-tic">🔐</span>
              <div><b>{t("API Key 只进钥匙串")}</b><span className="prv-td">{t("macOS Keychain 托管，不落盘明文")}</span></div>
            </div>
            <div className="prv-tile prv-t3">
              <span className="prv-tic">🏠</span>
              <div><b>{t("项目 100% 本机")}</b><span className="prv-td">{t("剧本/分镜/素材只存在你的工程文件夹")}</span></div>
            </div>
            <div className="prv-tile prv-t4">
              <span className="prv-tic">📤</span>
              <div><b>{t("出站先经策略引擎")}</b><span className="prv-td">{t("调用云端模型前自动审计与拦截")}</span></div>
            </div>
          </div>
        </div>

        {/* 意识模块（记忆，v2.3.5+；按项目存储） */}
        <MemoryCard />

        {/* FFmpeg */}
        <div className="card">
          <h3>{t("🎞️ FFmpeg / FFprobe")}</h3>
          {ffmpeg ? (
            <>
              <div className="kv"><span className="k">ffmpeg</span><span className="v">{ffmpeg.ffmpegPath ?? t("未找到")}</span></div>
              <div className="kv"><span className="k">ffprobe</span><span className="v">{ffmpeg.ffprobePath ?? t("未找到")}</span></div>
              <div className="kv"><span className="k">{t("版本")}</span><span className="v">{ffmpeg.ffmpegVersion ?? "—"}</span></div>
              <div className="hint" style={{ margin: "6px 0 10px" }}>{ffmpeg.message}</div>
            </>
          ) : (
            <div className="hint">{t("检测中…")}</div>
          )}
          <div className="field">
            <label>{t("自定义 ffmpeg 路径（仅当自动探测失败时填写完整路径）")}</label>
            <input type="text" value={ffmpegPath} placeholder={t("留空 = 自动探测（PATH / /usr/local/bin / /opt/homebrew/bin）")} onChange={(e) => setFfmpegPath(e.target.value)} />
          </div>
          <button className="btn" onClick={saveFfmpeg}>{t("保存并重新检测")}</button>
        </div>

        <div className="card">
          <h3>{t("⚙️ 任务引擎")}</h3>
          <div className="field">
            <label>{t("最大并发任务数")}</label>
            <input
              type="number"
              min={1}
              max={8}
              value={settings.maxConcurrentJobs}
              onChange={(e) => patchSettings({ maxConcurrentJobs: Math.max(1, Math.min(8, Number(e.target.value) || 2)) })}
            />
          </div>
          <div className="field">
            <label>{t("自动保存间隔（秒）")}</label>
            <input
              type="number"
              min={5}
              max={300}
              value={settings.autoSaveIntervalSec}
              onChange={(e) => patchSettings({ autoSaveIntervalSec: Math.max(5, Math.min(300, Number(e.target.value) || 30)) })}
            />
          </div>
        </div>

        {/* 存储位置（v2.3.2） */}
        <div className="card">
          <h3>{t("💾 存储位置")}</h3>
          <div className="kv">
            <span className="k">{t("应用数据目录")}</span>
            <span className="v">{dataDir || "—"}</span>
          </div>
          <div className="kv">
            <span className="k">{t("默认项目文件夹")}</span>
            <span className="v">{settings.defaultProjectFolder || t("未设置（创建项目时手动选择）")}</span>
          </div>
          <div style={{ display: "flex", gap: 8, margin: "10px 0 8px", flexWrap: "wrap" }}>
            <button className="btn" onClick={pickDefaultFolder}>{t("📁 选择默认项目文件夹…")}</button>
            {settings.defaultProjectFolder && (
              <button className="btn danger" onClick={clearDefaultFolder}>{t("清除")}</button>
            )}
          </div>
          <div className="hint">
            {t("设置后，「工作区 → 创建项目」会直接创建到该文件夹，不再每次弹窗选择。 应用数据（设置、皮肤、日志等）固定存放在应用数据目录，随系统用户隔离。")}
          </div>
        </div>

        <div className="card">
          <h3>{t("🔐 密钥存储")}</h3>
          <div className="hint">
            {t("API Key 只写入 macOS 钥匙串（Keychain），不落 SQLite、不落 project.json、不进日志。 Agent 只能通过 Provider 句柄获得「执行能力」，无法读取原始 Key。")}
          </div>
        </div>

        {/* 关于 / 版本（v2.3.2） */}
        <div className="card">
          <h3>{t("ℹ️ 关于 OneTV")}</h3>
          <div className="kv">
            <span className="k">{t("当前版本")}</span>
            <span
              className="v"
              style={{ cursor: "pointer", userSelect: "none" }}
              title="OneTV"
              onClick={onVersionClick}
            >
              v{appVersion ?? "…"}
            </span>
          </div>
          {timeHookOpen && (
            <div className="field" style={{ background: "var(--panel-2)", borderRadius: 8, padding: 12, border: "1px solid var(--border)" }}>
              <label>{t("🧪 测试时钟（时间边界测试钩子；单位秒，正值=时钟前移，0=恢复真实时钟；仅影响会话过期判断）")}</label>
              <div style={{ display: "flex", gap: 8, marginTop: 6 }}>
                <input
                  type="number"
                  value={offsetInput}
                  onChange={(e) => setOffsetInput(e.target.value)}
                  placeholder={t("例如 432001 = 5天+1秒")}
                />
                <button className="btn blue" onClick={applyTimeOffset}>{t("应用")}</button>
                <button className="btn" onClick={() => { setOffsetInput("0"); void applyTimeOffset(); }}>{t("恢复真实时钟")}</button>
              </div>
              <div className="hint" style={{ marginTop: 6 }}>
                {t("快捷值：4 天 23:59:59 = 431999 ｜ 5 天 = 432000 ｜ 5 天 + 1 秒 = 432001")}
              </div>
              {hookStatus && <div className="hint" style={{ marginTop: 4 }}>{hookStatus}</div>}
            </div>
          )}
          <div className="kv"><span className="k">{t("软件名称")}</span><span className="v">{t("OneTV — 本地优先的短剧创作工作台")}</span></div>
          {/* v2.11.0：检查更新为无发布源的占位实现，隐藏待接入 tauri-plugin-updater */}
        </div>
      </div>
    </div>
  );
}

/* ---------------- 意识模块（记忆）卡片局部样式（补充 global.css，深色一致） ---------------- */

const MEM_CSS = `
.mem-card { margin-bottom: 14px; align-self: stretch; height: 100%; display: flex; flex-direction: column; }
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
.mem-list { display: flex; flex-direction: column; gap: 8px; margin-bottom: 12px; max-height: 460px; overflow: auto; }
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

const PRIV_CSS = `
.prv-card { min-width: 0; }
.prv-card > .hint { flex-shrink: 0; }
.prv-tiles {
  flex: 1; display: grid; grid-template-columns: 1fr 1fr; gap: 12px;
  margin-top: 14px; align-content: stretch; min-height: 0;
}
.prv-tile {
  border: 1px solid var(--border); border-radius: 12px;
  padding: 13px 15px; display: flex; gap: 11px; align-items: center;
  background: var(--bg-deep);
}
.prv-tic {
  width: 40px; height: 40px; border-radius: 11px; flex-shrink: 0;
  display: flex; align-items: center; justify-content: center; font-size: 20px;
}
.prv-tile b { display: block; font-size: 13px; color: var(--text); margin-bottom: 2px; }
.prv-td { font-size: 11.5px; color: var(--muted); }
.prv-t1 { background: linear-gradient(135deg, rgba(255,120,140,.12), rgba(255,120,140,.05)); }
.prv-t1 .prv-tic { background: rgba(255, 84, 112, 0.18); }
.prv-t2 { background: linear-gradient(135deg, rgba(77,124,254,.12), rgba(77,124,254,.05)); }
.prv-t2 .prv-tic { background: rgba(77, 124, 254, 0.18); }
.prv-t3 { background: linear-gradient(135deg, rgba(53,208,127,.12), rgba(53,208,127,.05)); }
.prv-t3 .prv-tic { background: rgba(53, 208, 127, 0.18); }
.prv-t4 { background: linear-gradient(135deg, rgba(255,181,71,.14), rgba(255,181,71,.05)); }
.prv-t4 .prv-tic { background: rgba(255, 181, 71, 0.2); }
`
