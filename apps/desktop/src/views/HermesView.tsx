/**
 * Hermes 连接视图 —— OneTV ↔ Hermes agent 双向桥接。
 *
 * - 连接设置：Hermes 地址（仅本机/局域网，后端校验）+ 本机反向控制监听端口 +
 *   Token（钥匙串存储，留空保持不变，可显式清除）+ 启用监听开关
 * - 发送指令：出向 hermes_send（POST {url}/message），回复气泡展示
 * - 通信历史：hermes_log_recent + hermes.inbound 事件实时追加（Hermes 回调 OneTV 时）
 * - 与项目无关：未打开项目也可正常使用
 *
 * 复用 global.css 设计系统（卡片风格参照 ModelsView），布局细节用本组件内 scoped <style> 补充。
 */
import { useCallback, useEffect, useState } from "react";
import * as api from "../api";
import { useTauriEvent } from "../hooks/useTauriEvent";
import { useApp } from "../store";
import { useT } from "../i18n";

/** Tauri 命令 Err 时前端拿到 {message} 对象，统一提取可读文案 */
const errMsg = (e: unknown): string => {
  if (typeof e === "string") return e;
  if (e && typeof e === "object" && "message" in e) return String((e as { message: unknown }).message);
  try { return JSON.stringify(e); } catch { return String(e); }
};

const KIND_LABEL: Record<api.HermesLogEntry["kind"], string> = {
  outbound: "发往 Hermes",
  inbound: "Hermes 来信",
  outbound_error: "发送失败",
};

const truncate = (s: string, n: number) => (s.length > n ? s.slice(0, n) + "…" : s);

/** 历史条目摘要：按 kind 提取关键字段 */
function logSummary(entry: api.HermesLogEntry): string {
  const p = entry.payload ?? {};
  if (entry.kind === "outbound") {
    return `「${truncate(String(p.text ?? ""), 120)}」→「${truncate(String(p.reply ?? ""), 200)}」`;
  }
  if (entry.kind === "outbound_error") {
    return `「${truncate(String(p.text ?? ""), 120)}」→ ❌ ${truncate(String(p.error ?? ""), 200)}`;
  }
  // inbound：{ method, url, status, response }
  return `${p.method ?? "?"} ${p.url ?? ""} → ${p.status ?? "?"} · ${truncate(String(p.response ?? ""), 200)}`;
}

function fmtTime(rfc3339: string): string {
  const d = new Date(rfc3339);
  if (Number.isNaN(d.getTime())) return rfc3339;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

export default function HermesView() {
  const { toast } = useApp();
  const t = useT();

  /* ---------- 连接设置 ---------- */
  const [cfg, setCfg] = useState<api.HermesConfig | null>(null);
  const [url, setUrl] = useState("");
  const [listenPort, setListenPort] = useState(8766);
  const [token, setToken] = useState("");
  const [enabled, setEnabled] = useState(false);
  const [saving, setSaving] = useState(false);

  /* ---------- 测试连接 ---------- */
  const [testBusy, setTestBusy] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; text: string } | null>(null);

  /* ---------- 发送指令 ---------- */
  const [sendText, setSendText] = useState("");
  const [sendBusy, setSendBusy] = useState(false);
  const [sendResult, setSendResult] = useState<{ ok: boolean; text: string } | null>(null);

  /* ---------- 通信历史 ---------- */
  const [logs, setLogs] = useState<api.HermesLogEntry[]>([]);

  const refreshLogs = useCallback(async () => {
    try {
      const list = await api.hermesLogRecent(100);
      setLogs(list);
    } catch {
      /* 日志读取失败不打扰用户（如首次尚无日志文件） */
    }
  }, []);

  useEffect(() => {
    api.hermesConfigGet().then((c) => {
      setCfg(c);
      setUrl(c.url ?? "");
      setListenPort(c.listenPort || 8766);
      setEnabled(c.enabled);
    }).catch(() => {});
    void refreshLogs();
  }, [refreshLogs]);

  // Hermes 回调 OneTV（反向控制调用）时实时追加到历史
  //（useTauriEvent 内部处理「卸载早于 listen promise resolve」竞态，handler 走 ref 镜像）
  useTauriEvent<api.HermesLogEntry["payload"]>("hermes:inbound", (payload) => {
    setLogs((prev) => [
      { time: new Date().toISOString(), kind: "inbound", payload: payload ?? {} },
      ...prev,
    ]);
  });

  const saveConfig = async () => {
    setSaving(true);
    try {
      const saved = await api.hermesConfigSave({
        url: url.trim(),
        listenPort: Math.max(1024, Math.min(65535, Number(listenPort) || 8766)),
        enabled,
        // 留空 = 保持不变；显式清除用「清除 Token」按钮（token 传 ""）
        token: token || undefined,
      });
      setCfg(saved);
      setUrl(saved.url ?? "");
      setToken("");
      toast(t("Hermes 配置已保存"), "ok");
    } catch (e) {
      toast(t("保存失败：{msg}", { msg: errMsg(e) }), "err");
    } finally {
      setSaving(false);
    }
  };

  const clearToken = async () => {
    setSaving(true);
    try {
      const saved = await api.hermesConfigSave({
        url: url.trim(),
        listenPort: Math.max(1024, Math.min(65535, Number(listenPort) || 8766)),
        enabled,
        token: "",
      });
      setCfg(saved);
      setToken("");
      toast(t("Token 已清除"), "ok");
    } catch (e) {
      toast(t("清除失败：{msg}", { msg: errMsg(e) }), "err");
    } finally {
      setSaving(false);
    }
  };

  const doTest = async () => {
    setTestBusy(true);
    setTestResult(null);
    try {
      const r = await api.hermesTest();
      if (r.ok) {
        const body = r.body ? t(" · 返回：{text}", { text: truncate(r.body, 160) }) : "";
        setTestResult({ ok: true, text: t("连接成功 · {ms} ms", { ms: r.latencyMs ?? "?" }) + body });
      } else {
        setTestResult({ ok: false, text: r.message ?? t("连接失败") });
      }
    } catch (e) {
      setTestResult({ ok: false, text: errMsg(e) });
    } finally {
      setTestBusy(false);
    }
  };

  const doSend = async () => {
    const text = sendText.trim();
    if (!text) return;
    setSendBusy(true);
    setSendResult(null);
    try {
      const r = await api.hermesSend(text);
      if (r.ok) {
        setSendResult({ ok: true, text: r.reply ?? t("(空回复)") });
        setSendText("");
      } else {
        setSendResult({ ok: false, text: r.message ?? t("发送失败") });
      }
      void refreshLogs();
    } catch (e) {
      setSendResult({ ok: false, text: errMsg(e) });
    } finally {
      setSendBusy(false);
    }
  };

  return (
    <div className="page">
      <style>{HERMES_CSS}</style>

      <div className="page-header">
        <div>
          <h1>🛰️ {t("Hermes 连接")}</h1>
          <div className="desc">{t("OneTV 与 Hermes agent 的双向桥接：出向发送指令，入向接收回调与反向控制")}</div>
        </div>
      </div>

      {/* 顶部说明：双向能力 + 安全说明 + 反向控制协议 */}
      <div className="card hm-help">
        <h3>📡 {t("工作方式")}</h3>
        <ul>
          <li><b>{t("出向")}</b>：{t("在下方「发送指令」发送文本到 Hermes（POST")} <code>{"{url}"}</code>{t("/message）；")}</li>
          <li><b>{t("入向")}</b>：{t("启用「反向控制监听」后，Hermes 可回调 OneTV 触发动作，来信实时出现在「通信历史」；")}</li>
          <li><b>{t("安全")}</b>：{t("地址仅允许本机/局域网；监听只绑定本机回环（127.0.0.1），默认关闭；建议设置 Token 鉴权（存系统钥匙串）；")}</li>
          <li><b>{t("反向控制协议")}</b>：{t("Hermes 可 POST")} <code>http://127.0.0.1:{"{listenPort}"}</code>{t("/invoke，body")} <code>{"{ action, params }"}</code>{t("，动作白名单：")}
            <code>status</code>{t("、")}<code>job_list</code>{t("、")}<code>job_status</code>{t("、")}<code>create_image{"{prompt}"}</code>{t("、")}<code>agent_chat{"{text}"}</code>{t("、")}<code>agent_approve{"{planId}"}</code>{t("；")}
            {t("探活用 GET")} <code>/health</code>{t("；Token 不匹配返回 401。")}</li>
        </ul>
      </div>

      <div className="grid-2">
        {/* a. 连接设置 */}
        <div className="card">
          <h3>🔌 {t("连接设置")}</h3>
          <div className="field">
            <label>{t("Hermes 地址（仅允许本机 / 局域网地址）")}</label>
            <input
              type="text"
              value={url}
              placeholder="http://127.0.0.1:8765"
              spellCheck={false}
              autoCapitalize="none"
              autoCorrect="off"
              onChange={(e) => setUrl(e.target.value)}
            />
          </div>
          <div className="field">
            <label>{t("本机监听端口（反向控制回调端口，≥1024）")}</label>
            <input
              type="number"
              min={1024}
              max={65535}
              value={listenPort}
              onChange={(e) => setListenPort(Number(e.target.value) || 0)}
            />
          </div>
          <div className="field">
            <label>Token {cfg?.hasToken ? t("（已设置）") : t("（未设置，建议配置）")}</label>
            <input
              type="password"
              value={token}
              placeholder={cfg?.hasToken ? t("已设置（留空保持不变）") : t("用于 Hermes 调用 OneTV 时的鉴权")}
              autoComplete="new-password"
              onChange={(e) => setToken(e.target.value)}
            />
            <span className="sub">{t("🔒 Token 只存系统钥匙串；留空保存 = 保持不变；点击「清除 Token」删除。Hermes 回调时 Token 不匹配将返回 401。")}</span>
          </div>
          <label className="checkbox-row" style={{ marginBottom: 10 }}>
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e) => setEnabled(e.target.checked)}
            />
            {t("启用反向控制监听（Hermes 可回调 OneTV 执行白名单动作；默认关闭）")}
          </label>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button className="btn primary" disabled={saving} onClick={() => void saveConfig()}>
              {saving ? t("保存中…") : t("保存配置")}
            </button>
            <button className="btn blue" disabled={testBusy} onClick={() => void doTest()}>
              {testBusy ? t("测试中…") : t("测试连接")}
            </button>
            {cfg?.hasToken && (
              <button className="btn danger" disabled={saving} onClick={() => void clearToken()}>
                {t("清除 Token")}
              </button>
            )}
          </div>
          {testResult && (
            <div className={`hm-test ${testResult.ok ? "ok" : "err"}`}>
              {testResult.ok ? "✅" : "❌"} {testResult.text}
            </div>
          )}
        </div>

        {/* b. 发送指令 */}
        <div className="card">
          <h3>💬 {t("发送指令")}</h3>
          <div className="hint" style={{ marginBottom: 8 }}>
            {t("文本将发送到已配置的 Hermes 地址（POST {url}/message）；发送与回复都会记录到「通信历史」。", { url: "{url}" })}
          </div>
          <textarea
            className="hm-input"
            value={sendText}
            placeholder={t("输入要发送给 Hermes 的指令，例如：帮我生成一张赛博朋克城市夜景")}
            onChange={(e) => setSendText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void doSend();
            }}
          />
          <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
            <button className="btn primary" disabled={sendBusy || !sendText.trim()} onClick={() => void doSend()}>
              {sendBusy ? t("发送中…") : t("发送")}
            </button>
            <span className="sub" style={{ alignSelf: "center" }}>{t("⌘/Ctrl + Enter 快捷发送")}</span>
          </div>
          {sendResult && (
            <div className={`hm-bubble ${sendResult.ok ? "ok" : "err"}`}>
              <div className="hm-bubble-head">{sendResult.ok ? t("Hermes 回复") : t("发送失败")}</div>
              <div className="hm-bubble-body">{sendResult.text}</div>
            </div>
          )}
        </div>
      </div>

      {/* c. 通信历史 */}
      <div className="card hm-log-card">
        <div className="hm-log-head">
          <h3>📜 {t("通信历史（最近 {n} 条）", { n: logs.length })}</h3>
          <button className="btn sm" onClick={() => setLogs([])} title={t("仅清空当前显示，不影响本机日志文件")}>
            {t("清空显示")}
          </button>
        </div>
        {logs.length === 0 ? (
          <div className="hint">{t("暂无通信记录。发送指令或等待 Hermes 来信后，这里会显示最近 100 条。")}</div>
        ) : (
          <div className="hm-log-list">
            {logs.map((entry, i) => (
              <div className="hm-log-row" key={`${entry.time}-${i}`}>
                <span className="hm-log-time">{fmtTime(entry.time)}</span>
                <span className={`tag ${entry.kind === "inbound" ? "blue" : entry.kind === "outbound_error" ? "red" : "green"}`}>
                  {t(KIND_LABEL[entry.kind] ?? entry.kind)}
                </span>
                <span className="hm-log-text">{logSummary(entry)}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

/* ---------------- 视图局部样式（补充 global.css，深色一致） ---------------- */

const HERMES_CSS = `
.hm-help { margin-bottom: 14px; }
.hm-help ul { margin-left: 18px; display: flex; flex-direction: column; gap: 5px; color: var(--text-dim); font-size: 12px; }
.hm-help code {
  font-family: var(--mono); font-size: 11px; color: var(--cyan);
  background: var(--bg-deep); border: 1px solid var(--border);
  border-radius: 4px; padding: 1px 5px; word-break: break-all;
}
.hm-help b { color: var(--text); }
.hm-input { width: 100%; min-height: 180px; resize: vertical; }
.hm-test {
  margin-top: 10px; font-size: 12px; padding: 7px 10px;
  border-radius: var(--radius-sm); word-break: break-all;
}
.hm-test.ok { color: var(--green); background: rgba(53, 208, 127, 0.08); }
.hm-test.err { color: var(--red); background: rgba(255, 84, 112, 0.08); }
.hm-bubble {
  margin-top: 12px; border-radius: var(--radius-sm);
  padding: 9px 12px; border: 1px solid var(--border-strong);
  max-height: 260px; overflow: auto;
}
.hm-bubble.ok { background: rgba(53, 208, 127, 0.08); border-color: rgba(53, 208, 127, 0.4); }
.hm-bubble.err { background: rgba(255, 84, 112, 0.08); border-color: rgba(255, 84, 112, 0.4); }
.hm-bubble-head { font-size: 11px; margin-bottom: 4px; }
.hm-bubble.ok .hm-bubble-head { color: var(--green); }
.hm-bubble.err .hm-bubble-head { color: var(--red); }
.hm-bubble-body { font-size: 12.5px; color: var(--text); white-space: pre-wrap; word-break: break-word; user-select: text; }
.hm-log-card { margin-bottom: 14px; }
.hm-log-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.hm-log-list { display: flex; flex-direction: column; gap: 4px; margin-top: 10px; max-height: 420px; overflow: auto; }
.hm-log-row {
  display: flex; align-items: flex-start; gap: 8px;
  padding: 6px 8px; border-radius: var(--radius-sm);
  background: var(--bg-deep); border: 1px solid var(--border);
}
.hm-log-time { font-family: var(--mono); font-size: 11px; color: var(--muted); flex-shrink: 0; padding-top: 1px; }
.hm-log-row .tag { flex-shrink: 0; font-size: 10.5px; }
.hm-log-text { font-size: 11.5px; color: var(--text-dim); word-break: break-all; user-select: text; min-width: 0; }
`;
