/**
 * 设置视图 —— 隐私 / 意识模块（记忆）/ FFmpeg / 并发 / 外观与主题（v2.1）/ 账户安全（v2.1）。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";
import * as api from "../api";
import { useApp } from "../store";

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
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return iso.slice(0, 10);
  const diff = Date.now() - t;
  const m = Math.floor(diff / 60000);
  if (m < 1) return "刚刚";
  if (m < 60) return `${m} 分钟前`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} 小时前`;
  const d = Math.floor(h / 24);
  if (d === 1) return "昨天";
  if (d < 7) return `${d} 天前`;
  const dt = new Date(t);
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
          <span className="mem-chars">{text.trim().length} 字</span>
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
          <span className="hint" style={{ marginRight: "auto" }}>⌘+Enter 保存 · Esc 取消</span>
          <button
            className="btn sm primary"
            disabled={saving || !text.trim()}
            onClick={stop(async () => {
              await onSave(rec.id, text.trim());
              setEditing(false);
            })}
          >
            {saving ? "保存中…" : "保存修改"}
          </button>
          <button className="btn sm" onClick={stop(() => { setEditing(false); setText(rec.text); onEdit(""); })}>取消</button>
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
          <button title="编辑" onClick={stop(() => { setEditing(true); setText(rec.text); onEdit(rec.id); })}>编辑</button>
          <button
            title="复制到剪贴板"
            onClick={stop(() => {
              void navigator.clipboard.writeText(rec.text).then(
                () => useApp.getState().toast("已复制到剪贴板", "ok"),
                () => useApp.getState().toast("复制失败", "err"),
              );
            })}
          >
            复制
          </button>
          <button className="mem-danger-btn" title="删除（不可恢复）" onClick={stop(() => onDelete(rec.id))}>删除</button>
        </span>
      </div>
      <div
        className={`mem-text ${expanded ? "" : "clamped"} ${longText ? "clickable" : ""}`}
        title={longText && !expanded ? "点击展开全文" : undefined}
        onClick={() => longText && setExpanded((v) => !v)}
      >
        {rec.text}
      </div>
      {longText && (
        <button className="mem-toggle" onClick={stop(() => setExpanded((v) => !v))}>
          {expanded ? "收起 ▲" : "展开全文 ▼"}
        </button>
      )}
    </div>
  );
}

function MemoryCard() {
  const { toast } = useApp();
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
  const filtered = q ? list.filter((m) => m.text.toLowerCase().includes(q)) : list;
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
      toast("记忆已保存", "ok");
    } catch (e) {
      toast(`添加失败：${errMsg(e)}`, "err");
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
      toast("记忆已更新", "ok");
    } catch (e) {
      toast(`保存失败：${errMsg(e)}`, "err");
    } finally {
      setSavingId(null);
    }
  };

  const removeMemory = async (id: string) => {
    if (!window.confirm("确定删除这条记忆？不可恢复")) return;
    try {
      await api.memoryDelete(id);
      setRecords((r) => (r ?? []).filter((m) => m.id !== id));
      setSelected((s) => { const n = new Set(s); n.delete(id); return n; });
      toast("已删除", "ok");
    } catch (e) {
      toast(`删除失败：${errMsg(e)}`, "err");
    }
  };

  const batchDelete = async () => {
    const ids = [...selected];
    if (ids.length === 0) return;
    if (!window.confirm(`确定删除选中的 ${ids.length} 条记忆？不可恢复`)) return;
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
    toast(`已删除 ${ok}/${ids.length} 条记忆`, ok === ids.length ? "ok" : "warn");
  };

  const exportMd = () => {
    const items = selected.size > 0 ? list.filter((m) => selected.has(m.id)) : list;
    if (items.length === 0) { toast("没有可导出的记忆", "warn"); return; }
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
    toast(`已导出 ${items.length} 条记忆`, "ok");
  };

  const importFile = async (file: File) => {
    const raw = await file.text();
    const parts = raw.split(/\n\s*\n/).map((x) => x.trim()).filter((x) => x.length > 0).slice(0, 200);
    if (parts.length === 0) { toast("文件中没有可导入的内容", "warn"); return; }
    let ok = 0;
    for (const part of parts) {
      try { await api.memoryAdd(part); ok += 1; } catch { /* 单条失败继续 */ }
    }
    await refresh();
    toast(`导入完成：成功 ${ok}/${parts.length} 条`, ok === parts.length ? "ok" : "warn");
  };

  const toggleCheck = (id: string, v: boolean) => {
    setSelected((s) => { const n = new Set(s); if (v) n.add(id); else n.delete(id); return n; });
  };

  return (
    <div className="card mem-card">
      <h3>🧠 意识模块（记忆）</h3>
      <div className="hint" style={{ marginBottom: 8 }}>
        Agent 的长期记忆，随项目保存在本机；生成时作为上下文参考。支持搜索、批量管理与导入导出。
      </div>

      {notOpen ? (
        <div className="hint mem-notice">意识模块按项目存储，请先在工作区打开一个项目</div>
      ) : loadErr ? (
        <div className="hint mem-notice">加载失败：{loadErr}</div>
      ) : records === null ? (
        <div className="hint">加载中…</div>
      ) : (
        <>
          {/* 统计条 */}
          <div className="mem-stats">
            <span><b>{list.length}</b> 条记忆</span>
            <span className="mem-sep">·</span>
            <span>最近更新 {latest ? memRelTime(latest.createdAt ?? latest.created_at ?? "") : "—"}</span>
            <span className="mem-sep">·</span>
            <span className="tag green">仅存本机工程内</span>
            <span style={{ flex: 1 }} />
            <button className="btn sm" onClick={() => { setMultiSelect((v) => !v); setSelected(new Set()); }}>
              {multiSelect ? "退出多选" : "多选"}
            </button>
            <button className="btn sm" title="导出为 Markdown" onClick={exportMd}>⬇ 导出</button>
            <button className="btn sm" title="从 .txt/.md 导入（空行分段，每段一条）" onClick={() => importRef?.click()}>⬆ 导入</button>
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
              placeholder="🔍 搜索记忆内容…"
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
                全选（当前筛选 {filtered.length} 条）
              </label>
              <span style={{ flex: 1 }} />
              <span className="hint">已选 {selected.size} 条</span>
              <button className="btn sm danger" disabled={selected.size === 0} onClick={() => void batchDelete()}>
                删除所选
              </button>
            </div>
          )}

          {/* 时间线列表 */}
          {list.length === 0 ? (
            <div className="mem-empty">
              <div className="mem-empty-icon">🧠</div>
              <div className="mem-empty-title">还没有记忆</div>
              <div className="hint">把主角设定、风格约定、剧情要点告诉 Agent —— 在下方输入第一条记忆，生成剧本/分镜时会自动参考</div>
              <button className="btn primary sm" style={{ marginTop: 10 }} onClick={() => newTextRef.current?.focus()}>
                写下第一条记忆
              </button>
            </div>
          ) : filtered.length === 0 ? (
            <div className="hint" style={{ margin: "10px 0" }}>没有匹配「{query}」的记忆</div>
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
              placeholder="写下要记住的内容，例如：主角林晚是冷静的刑警，口头禅「证据说话」…（⌘+Enter 保存；粘贴多段文字后保存会按原样存为一条）"
              onChange={(e) => setNewText(e.target.value)}
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                  e.preventDefault();
                  void addMemory();
                }
              }}
            />
            <div className="mem-composer-bar">
              <span className="hint" style={{ marginRight: "auto" }}>{newText.trim().length} 字 · ⌘+Enter 保存</span>
              <button className="btn primary" disabled={addBusy || !newText.trim()} onClick={() => void addMemory()}>
                {addBusy ? "保存中…" : "保存记忆"}
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
      setUpdateMsg("这已经是最新版本");
      toast("这已经是最新版本", "ok");
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
    if (!Number.isFinite(secs)) { setHookStatus("偏移量必须是整数秒（可为负）"); return; }
    try {
      await api.debugSetTimeOffset(Math.trunc(secs));
      const st = await api.debugSessionStatus();
      const remain = st.remainingSecs === null ? "无会话" : `${Math.floor(st.remainingSecs / 86400)}天${Math.floor((st.remainingSecs % 86400) / 3600)}时${Math.floor((st.remainingSecs % 3600) / 60)}分`;
      setHookStatus(`已设置偏移 ${st.offsetSecs}s（正值=时钟前移）。会话剩余：${remain}。设为 0 恢复真实时钟。`);
    } catch (e) {
      setHookStatus(`设置失败：${errMsg(e)}`);
    }
  };

  const pickDefaultFolder = async () => {
    try {
      const dir = await api.projectPickDirectory("选择默认项目文件夹（新项目将创建在这里）");
      if (!dir) return;
      await patchSettings({ defaultProjectFolder: dir });
      toast("默认项目文件夹已保存", "ok");
    } catch (e) {
      toast(`设置失败：${errMsg(e)}`, "err");
    }
  };

  const clearDefaultFolder = async () => {
    await patchSettings({ defaultProjectFolder: "" });
    toast("已清除默认项目文件夹", "ok");
  };

  // 账户表单
  const [curPass, setCurPass] = useState("");
  const [newUser, setNewUser] = useState("");
  const [newPass, setNewPass] = useState("");
  const [email, setEmail] = useState("");
  const [accErr, setAccErr] = useState("");
  const [accBusy, setAccBusy] = useState(false);

  // v2.2 邮件发送设置 + 验证码
  const [mailInfo, setMailInfo] = useState<api.MailConfigInfo | null>(null);
  const [smtpHost, setSmtpHost] = useState("");
  const [smtpPort, setSmtpPort] = useState(465);
  const [useTls, setUseTls] = useState(true);
  const [smtpAuth, setSmtpAuth] = useState("");
  const [mailMsg, setMailMsg] = useState("");
  const [emailCode, setEmailCode] = useState("");
  const [codeSent, setCodeSent] = useState<null | { sent: boolean; message: string }>(null);
  const [countdown, setCountdown] = useState(0);
  const [codeBusy, setCodeBusy] = useState(false);

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
  }, [settings?.ffmpegPath]);

  if (!settings) return <div className="page hint">加载中…</div>;

  const saveFfmpeg = async () => {
    try {
      await patchSettings({ ffmpegPath: ffmpegPath.trim() || undefined });
      await loadFfmpeg();
      toast("设置已保存", "ok");
    } catch (e) {
      if (!errMsg(e).includes("已取消")) toast(`保存失败：${errMsg(e)}`, "err");
    }
  };

  const saveAppearance = async (patch: Partial<api.AppSettings>) => {
    await patchSettings(patch);
    toast("外观已更新", "ok");
  };

  const submitAccount = async () => {
    setAccErr("");
    setAccBusy(true);
    try {
      const hasAnything = newUser.trim() || newPass || email.trim();
      if (!hasAnything) {
        setAccErr("请至少填写一项要修改的内容");
        return;
      }
      await api.authChangeCredentials({
        currentPassword: curPass,
        newUsername: newUser.trim() || undefined,
        newPassword: newPass || undefined,
        email: email.trim() || undefined,
        emailCode: emailCode.trim() || undefined,
      });
      toast("账户信息已更新", "ok");
      setCurPass("");
      setNewUser("");
      setNewPass("");
      setEmail("");
      setEmailCode("");
      setCodeSent(null);
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
      toast("皮肤已应用", "ok");
    } catch (e) {
      if (!errMsg(e).includes("取消")) toast(`皮肤设置失败：${errMsg(e)}`, "err");
    }
  };

  const clearSkin = async () => {
    await api.themeClearSkin();
    await loadSettings();
    toast("已恢复默认背景", "ok");
  };

  return (
    <div className="page">
      <style>{MEM_CSS}</style>
      <style>{PRIV_CSS}</style>
      <div className="page-header">
        <div>
          <h1>设置</h1>
          <div className="desc">隐私与安全是默认值，不是选项</div>
        </div>
      </div>

      <div className="grid-2">
        {/* 外观设置（v2.1）—— alignSelf:start 避免被右侧更高的卡片拉伸出大片空白 */}
        <div className="card" style={{ alignSelf: "start" }}>
          <h3>🎨 外观设置</h3>
          <div className="field">
            <label>外观模式</label>
            <div style={{ display: "flex", gap: 8 }}>
              <button
                className={`btn ${settings.theme !== "light" ? "primary" : ""}`}
                onClick={() => saveAppearance({ theme: "dark" })}
              >
                🌙 暗色
              </button>
              <button
                className={`btn ${settings.theme === "light" ? "primary" : ""}`}
                onClick={() => saveAppearance({ theme: "light" })}
              >
                ☀️ 浅色
              </button>
            </div>
          </div>

          <div className="field">
            <label>主题皮肤</label>
            <div className="hint" style={{ marginBottom: 8 }}>
              内置两套主题（暗色霓虹 / 浅色晨雾）。上传图片可作全局背景皮肤（类似 Aion UI 的自定义皮肤），
              仅存本机。
            </div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <button
                className={`btn ${!settings.skin ? "blue" : ""}`}
                onClick={clearSkin}
              >
                默认渐变背景
              </button>
              <button className="btn" onClick={uploadSkin}>🖼️ 上传图片皮肤…</button>
              {settings.skin && (
                <button className="btn danger" onClick={clearSkin}>清除皮肤</button>
              )}
            </div>
            {settings.skin && (
              <div className="kv" style={{ marginTop: 8 }}>
                <span className="k">当前皮肤</span>
                <span className="v">{settings.skin}</span>
              </div>
            )}
          </div>

          <div className="field">
            <label>皮肤清晰度：{Math.round(skinOpacityShown * 100)}%（数值越小皮肤越明显）</label>
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
                  title="当前皮肤预览（随清晰度滑杆实时变化，与主界面实际效果一致）"
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
                    <b style={{ fontSize: 13 }}>当前皮肤</b>
                    <span style={{ opacity: .85 }}>{settings.skin}</span>
                    <span style={{ flex: 1 }} />
                    <span style={{ opacity: .85 }}>清晰度 {Math.round(skinOpacityShown * 100)}%</span>
                  </div>
                </div>
                <div className="hint" style={{ marginTop: 8 }}>
                  预览随上方滑杆实时变化，与主界面实际效果一致；拖动「清晰度」可调整皮肤浓淡。
                </div>
              </div>
            )}
          </div>
        </div>

        {/* 账户安全（v2.1） */}
        <div className="card">
          <h3>👤 账户安全</h3>
          {auth ? (
            <>
              <div className="kv"><span className="k">用户名</span><span className="v">{auth.username}</span></div>
              <div className="kv">
                <span className="k">绑定邮箱</span>
                <span className="v">
                  {auth.email ? (
                    auth.email
                  ) : (
                    <span className="tag amber">未绑定（修改用户名/密码前必须绑定）</span>
                  )}
                </span>
              </div>
              {auth.hasDefaultPassword && (
                <div className="kv">
                  <span className="k"></span>
                  <span className="v"><span className="tag red">仍在使用默认密码 12345，请尽快修改（未修改前忘记密码不可用，请按默认方式登录）</span></span>
                </div>
              )}
              <div style={{ borderTop: "1px solid var(--border)", margin: "10px 0" }} />
              <div className="field">
                <label>当前密码（必填）</label>
                <input type="password" value={curPass} onChange={(e) => setCurPass(e.target.value)} />
              </div>
              <div className="grid-2">
                <div className="field">
                  <label>新用户名（可选）</label>
                  <input type="text" placeholder="保持不变则留空" value={newUser} onChange={(e) => setNewUser(e.target.value)} />
                </div>
                <div className="field">
                  <label>新密码（可选，≥5 位）</label>
                  <input type="password" placeholder="保持不变则留空" value={newPass} onChange={(e) => setNewPass(e.target.value)} />
                </div>
              </div>
              <div className="field">
                <label>
                  绑定/更换邮箱{auth.email ? `（当前 ${auth.email}）` : "（必填——未绑定邮箱时修改用户名/密码必须同时填写）"}
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
              {email.trim().includes("@") && (
                <div className="field">
                  <label>邮箱验证码（已配置邮件发送服务时，修改用户名/密码必须验证）</label>
                  <div style={{ display: "flex", gap: 8 }}>
                    <input type="text" inputMode="numeric" placeholder="6 位验证码" value={emailCode} onChange={(e) => setEmailCode(e.target.value)} />
                    <button
                      className="btn"
                      disabled={countdown > 0 || codeBusy || !email.trim() || !curPass}
                      title={!curPass ? "请先填写当前密码" : ""}
                      onClick={async () => {
                        setAccErr("");
                        setCodeBusy(true);
                        try {
                          const r = await api.authSendCode("change", email.trim(), curPass);
                          setCodeSent({ sent: r.sent, message: r.sent ? (r.message ?? "已发送") : (r.reason ?? "无法发送") });
                          if (r.sent) {
                            setCountdown(60);
                            const t = setInterval(() => {
                              setCountdown((c) => {
                                if (c <= 1) { clearInterval(t); return 0; }
                                return c - 1;
                              });
                            }, 1000);
                          }
                        } catch (e) {
                          setAccErr(errMsg(e));
                        } finally {
                          setCodeBusy(false);
                        }
                      }}
                    >
                      {countdown > 0 ? `${countdown}s` : codeBusy ? "发送中…" : "发送验证码"}
                    </button>
                  </div>
                  {codeSent && (
                    <div className={codeSent.sent ? "hint" : "login-err"} style={{ marginTop: 4 }}>
                      {codeSent.sent ? `✉️ ${codeSent.message}` : `⚠️ ${codeSent.message}`}
                    </div>
                  )}
                </div>
              )}
              {email.trim().includes("@") && mailInfo && (
                <div className="field" style={{ background: "var(--panel-2)", borderRadius: 8, padding: 12, border: "1px solid var(--border)" }}>
                  <label>📧 邮件发送设置（验证码由本机软件经此 SMTP 直发到你的邮箱，无须任何服务器；授权码只存本机钥匙串）</label>
                  <div className="grid-2">
                    <div className="field">
                      <label>SMTP 服务器{mailInfo.preset ? "（已按邮箱自动匹配预设）" : ""}</label>
                      <input type="text" value={smtpHost} onChange={(e) => setSmtpHost(e.target.value)} placeholder="smtp.qq.com" />
                    </div>
                    <div className="field">
                      <label>端口（465=TLS / 587=STARTTLS）</label>
                      <input type="number" value={smtpPort} onChange={(e) => { const v = Number(e.target.value); setSmtpPort(v); setUseTls(v === 465); }} />
                    </div>
                  </div>
                  <div className="field">
                    <label>SMTP 授权码（不是邮箱登录密码；QQ/163 邮箱在设置中开启 SMTP 后获取）</label>
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
                          setMailMsg("✅ 已保存");
                        } catch (e) {
                          setMailMsg(`⚠️ ${errMsg(e)}`);
                        }
                      }}
                    >
                      保存发送设置
                    </button>
                    <button
                      className="btn"
                      disabled={!mailInfo?.configured}
                      onClick={async () => {
                        setMailMsg("");
                        try {
                          const r = await api.mailTestSend(email.trim());
                          setMailMsg(r.ok ? `✅ ${r.message}` : `⚠️ ${r.message}`);
                        } catch (e) {
                          setMailMsg(`⚠️ ${errMsg(e)}`);
                        }
                      }}
                    >
                      发送测试邮件
                    </button>
                    {useTls && <span className="tag blue">TLS</span>}
                  </div>
                  {mailMsg && <div className="hint" style={{ marginTop: 6 }}>{mailMsg}</div>}
                  <div className="hint" style={{ marginTop: 6 }}>
                    常见服务商：QQ/foxmail → smtp.qq.com:465 ｜ 163 → smtp.163.com:465 ｜ 126 → smtp.126.com:465 ｜ Gmail → smtp.gmail.com:465
                  </div>
                </div>
              )}
              {accErr && <div className="login-err">⚠️ {accErr}</div>}
              <button className="btn primary" disabled={accBusy} onClick={submitAccount}>
                {accBusy ? "保存中…" : "保存账户修改"}
              </button>
              <div className="hint" style={{ marginTop: 10 }}>
                忘记密码可在登录页凭绑定邮箱重置（本地验证邮箱地址一致即可）。修改密码后需重新登录。
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
                🔒 本 agent 为开源平台，你的密码和账号只会存储到本地，不会上传给任何第三方。
              </div>
              <button
                className="btn danger"
                style={{ marginTop: 12 }}
                onClick={async () => {
                  try {
                    await api.authLogout();
                    useApp.getState().setAuthed(false);
                  } catch (e) {
                    toast(`退出失败：${errMsg(e)}`, "err");
                  }
                }}
              >
                退出账号
              </button>
            </>
          ) : (
            <div className="hint">加载中…</div>
          )}
        </div>

        {/* 隐私（v2.5：普通网格子项，列宽与上下行对齐；height:100% 保证与同行卡片等高） */}
        <div className="card prv-card" style={{ alignSelf: "stretch", height: "100%", display: "flex", flexDirection: "column" }}>
          <h3>🛡️ 隐私</h3>
          <label className="checkbox-row" style={{ marginBottom: 8 }}>
            <input
              type="checkbox"
              checked
              onChange={() =>
                toast("OneTV 采用本地优先设计：代码中不存在任何遥测 SDK，因此该选项始终开启，也不会收集任何数据", "info")
              }
            />
            禁用遥测（默认关闭，代码中不存在任何分析 SDK）（本项始终开启：无遥测可禁用）
          </label>
          <label className="checkbox-row" style={{ marginBottom: 8 }}>
            <input
              type="checkbox"
              checked={settings.offlineMode}
              onChange={(e) => patchSettings({ offlineMode: e.target.checked }).then(() => toast(e.target.checked ? "已开启 Local-only：公网 Provider 请求将被拒绝" : "已关闭 Local-only", "ok"))}
            />
            Local-only 完全离线模式（仅本机 Ollama / ComfyUI / SD WebUI 可用）
          </label>
          <div className="hint">
            开启后：所有云端 Provider 变灰并被策略引擎拒绝；项目管理、剧本、分镜、素材与 FFmpeg 合成不受影响。
          </div>

          {/* 数据看板（v2.4.6，方案A）：四块安全状态瓷贴，随卡片高度自动铺满 */}
          <div className="prv-tiles">
            <div className="prv-tile prv-t1">
              <span className="prv-tic">🚫</span>
              <div><b>遥测 SDK：0 个</b><span className="prv-td">代码中不存在任何分析/上报组件</span></div>
            </div>
            <div className="prv-tile prv-t2">
              <span className="prv-tic">🔐</span>
              <div><b>API Key 只进钥匙串</b><span className="prv-td">macOS Keychain 托管，不落盘明文</span></div>
            </div>
            <div className="prv-tile prv-t3">
              <span className="prv-tic">🏠</span>
              <div><b>项目 100% 本机</b><span className="prv-td">剧本/分镜/素材只存在你的工程文件夹</span></div>
            </div>
            <div className="prv-tile prv-t4">
              <span className="prv-tic">📤</span>
              <div><b>出站先经策略引擎</b><span className="prv-td">调用云端模型前自动审计与拦截</span></div>
            </div>
          </div>
        </div>

        {/* 意识模块（记忆，v2.3.5+；按项目存储） */}
        <MemoryCard />

        {/* FFmpeg */}
        <div className="card">
          <h3>🎞️ FFmpeg / FFprobe</h3>
          {ffmpeg ? (
            <>
              <div className="kv"><span className="k">ffmpeg</span><span className="v">{ffmpeg.ffmpegPath ?? "未找到"}</span></div>
              <div className="kv"><span className="k">ffprobe</span><span className="v">{ffmpeg.ffprobePath ?? "未找到"}</span></div>
              <div className="kv"><span className="k">版本</span><span className="v">{ffmpeg.ffmpegVersion ?? "—"}</span></div>
              <div className="hint" style={{ margin: "6px 0 10px" }}>{ffmpeg.message}</div>
            </>
          ) : (
            <div className="hint">检测中…</div>
          )}
          <div className="field">
            <label>自定义 ffmpeg 路径（仅当自动探测失败时填写完整路径）</label>
            <input type="text" value={ffmpegPath} placeholder="留空 = 自动探测（PATH / /usr/local/bin / /opt/homebrew/bin）" onChange={(e) => setFfmpegPath(e.target.value)} />
          </div>
          <button className="btn" onClick={saveFfmpeg}>保存并重新检测</button>
        </div>

        <div className="card">
          <h3>⚙️ 任务引擎</h3>
          <div className="field">
            <label>最大并发任务数</label>
            <input
              type="number"
              min={1}
              max={8}
              value={settings.maxConcurrentJobs}
              onChange={(e) => patchSettings({ maxConcurrentJobs: Math.max(1, Math.min(8, Number(e.target.value) || 2)) })}
            />
          </div>
          <div className="field">
            <label>自动保存间隔（秒）</label>
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
          <h3>💾 存储位置</h3>
          <div className="kv">
            <span className="k">应用数据目录</span>
            <span className="v">{dataDir || "—"}</span>
          </div>
          <div className="kv">
            <span className="k">默认项目文件夹</span>
            <span className="v">{settings.defaultProjectFolder || "未设置（创建项目时手动选择）"}</span>
          </div>
          <div style={{ display: "flex", gap: 8, margin: "10px 0 8px", flexWrap: "wrap" }}>
            <button className="btn" onClick={pickDefaultFolder}>📁 选择默认项目文件夹…</button>
            {settings.defaultProjectFolder && (
              <button className="btn danger" onClick={clearDefaultFolder}>清除</button>
            )}
          </div>
          <div className="hint">
            设置后，「工作区 → 创建项目」会直接创建到该文件夹，不再每次弹窗选择。
            应用数据（设置、皮肤、日志等）固定存放在应用数据目录，随系统用户隔离。
          </div>
        </div>

        <div className="card">
          <h3>🔐 密钥存储</h3>
          <div className="hint">
            API Key 只写入 macOS 钥匙串（Keychain），不落 SQLite、不落 project.json、不进日志。
            Agent 只能通过 Provider 句柄获得「执行能力」，无法读取原始 Key。
          </div>
        </div>

        {/* 关于 / 版本（v2.3.2） */}
        <div className="card">
          <h3>ℹ️ 关于 OneTV</h3>
          <div className="kv">
            <span className="k">当前版本</span>
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
              <label>🧪 测试时钟（时间边界测试钩子；单位秒，正值=时钟前移，0=恢复真实时钟；仅影响会话过期判断）</label>
              <div style={{ display: "flex", gap: 8, marginTop: 6 }}>
                <input
                  type="number"
                  value={offsetInput}
                  onChange={(e) => setOffsetInput(e.target.value)}
                  placeholder="例如 432001 = 5天+1秒"
                />
                <button className="btn blue" onClick={applyTimeOffset}>应用</button>
                <button className="btn" onClick={() => { setOffsetInput("0"); void applyTimeOffset(); }}>恢复真实时钟</button>
              </div>
              <div className="hint" style={{ marginTop: 6 }}>
                快捷值：4 天 23:59:59 = 431999 ｜ 5 天 = 432000 ｜ 5 天 + 1 秒 = 432001
              </div>
              {hookStatus && <div className="hint" style={{ marginTop: 4 }}>{hookStatus}</div>}
            </div>
          )}
          <div className="kv"><span className="k">软件名称</span><span className="v">OneTV — 本地优先的短剧创作工作台</span></div>
          <div style={{ display: "flex", gap: 8, margin: "10px 0 8px" }}>
            <button className="btn blue" disabled={checking} onClick={checkUpdate}>
              {checking ? "检查中…" : "🔄 检查更新"}
            </button>
          </div>
          {updateMsg && <div className="hint">✅ {updateMsg}</div>}
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
