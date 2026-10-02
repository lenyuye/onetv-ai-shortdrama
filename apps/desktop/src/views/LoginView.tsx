/**
 * 登录界面（v2.1）—— 本地账户门。
 * 默认 admin / 12345；忘记密码凭绑定邮箱重置（本地验证邮箱地址，无验证码下发）。
 */
import { useState } from "react";
import * as api from "../api";
import { useApp } from "../store";

export default function LoginView({ onSuccess }: { onSuccess: () => void }) {
  const { toast } = useApp();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const [resetOpen, setResetOpen] = useState(false);
  const [resetEmail, setResetEmail] = useState("");
  const [resetPass, setResetPass] = useState("");
  const [resetErr, setResetErr] = useState("");
  const [stillDefault, setStillDefault] = useState<boolean | null>(null);
  const [resetCode, setResetCode] = useState("");
  const [codeSent, setCodeSent] = useState<null | { sent: boolean; message: string }>(null);
  const [countdown, setCountdown] = useState(0);
  const [codeBusy, setCodeBusy] = useState(false);

  const openReset = async () => {
    setResetOpen(true);
    setResetErr("");
    try {
      const st = await api.authStatus();
      setStillDefault(st.hasDefaultPassword);
    } catch {
      setStillDefault(false);
    }
  };

  const login = async () => {
    if (!username.trim() || !password) {
      setErr("请输入用户名和密码");
      return;
    }
    setBusy(true);
    setErr("");
    try {
      const r = await api.authLogin(username.trim(), password);
      if (r.ok) {
        onSuccess();
      } else {
        setErr("用户名或密码不正确");
      }
    } catch (e) {
      setErr(String(e));
    } finally {
      setBusy(false);
    }
  };

  const sendCode = async () => {
    setResetErr("");
    setCodeBusy(true);
    try {
      const r = await api.authSendCode("reset", resetEmail.trim());
      setCodeSent({ sent: r.sent, message: r.sent ? (r.message ?? "验证码已发送") : (r.reason ?? "无法发送验证码") });
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
      setResetErr(String(e));
    } finally {
      setCodeBusy(false);
    }
  };

  const doReset = async () => {
    setResetErr("");
    try {
      await api.authResetWithEmail(resetEmail.trim(), resetPass, resetCode.trim() || undefined);
      toast("密码已重置，请用新密码登录", "ok");
      setResetOpen(false);
      setPassword("");
    } catch (e) {
      setResetErr(String(e));
    }
  };

  return (
    <div className="login-wrap">
      <div className="skin-layer" />
      <div className="login-card">
        <div className="login-logo">
          <img src="/logo.png" alt="OneTV" />
          <h1>OneTV</h1>
          <p>本地优先的短剧创作工作台 · v2.2</p>
        </div>

        <div className="field">
          <label>用户名</label>
          <input
            type="text"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            placeholder="admin"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && login()}
            autoFocus
          />
        </div>
        <div className="field">
          <label>密码</label>
          <input
            type="password"
            placeholder="••••••"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && login()}
          />
        </div>
        {err && <div className="login-err">⚠️ {err}</div>}
        <button className="btn primary login-btn" disabled={busy} onClick={login}>
          {busy ? "登录中…" : "登 录"}
        </button>
        <div className="login-foot">
          <span>首次使用：账号 <b>admin</b> / 密码 <b>12345</b>，登录后请在「设置 → 账户安全」修改并绑定邮箱</span>
          <a
            onClick={(e) => {
              e.preventDefault();
              void openReset();
            }}
          >
            忘记密码？
          </a>
        </div>
        <div className="login-privacy">🔐 本地账户 · 凭据加密存储于本机 · 不联网验证</div>
      </div>

      {resetOpen && (
        <div className="modal-overlay" onClick={() => setResetOpen(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <span>🔑 凭绑定邮箱重置密码</span>
              <button className="btn sm ghost" onClick={() => setResetOpen(false)}>✕</button>
            </div>
            <div className="modal-body">
              {stillDefault && (
                <div className="login-err">💡 你还未设置账号和密码，请按默认方式登录（admin / 12345），首次登录后在「设置 → 账户安全」中设置并绑定邮箱。</div>
              )}
              {stillDefault !== true && (
              <>
              <div className="field">
                <label>绑定邮箱</label>
                <input type="text" autoCapitalize="none" autoCorrect="off" spellCheck={false} placeholder="you@example.com" value={resetEmail} onChange={(e) => setResetEmail(e.target.value)} />
              </div>
              <div className="field">
                <label>验证码（若已在本机配置邮件发送服务）</label>
                <div style={{ display: "flex", gap: 8 }}>
                  <input type="text" inputMode="numeric" placeholder="6 位验证码" value={resetCode} onChange={(e) => setResetCode(e.target.value)} />
                  <button className="btn" disabled={countdown > 0 || codeBusy || !resetEmail.trim()} onClick={sendCode}>
                    {countdown > 0 ? `${countdown}s` : codeBusy ? "发送中…" : "发送验证码"}
                  </button>
                </div>
                {codeSent && (
                  <div className={codeSent.sent ? "hint" : "login-err"} style={{ marginTop: 4 }}>
                    {codeSent.sent ? `✉️ ${codeSent.message}` : `⚠️ ${codeSent.message}（未配置时：验证邮箱地址一致即可重置）`}
                  </div>
                )}
              </div>
              <div className="field">
                <label>新密码（至少 5 位）</label>
                <input type="password" value={resetPass} onChange={(e) => setResetPass(e.target.value)} />
              </div>
              <div className="hint">
                验证码由本机软件直接经你配置的 SMTP 邮箱服务发出（无须任何服务器）；未配置邮件服务时，验证邮箱地址一致即可重置。
              </div>
              {resetErr && <div className="login-err">⚠️ {resetErr}</div>}
              </>
              )}
            </div>
            <div className="modal-foot">
              <button className="btn" onClick={() => setResetOpen(false)}>关闭</button>
              {stillDefault !== true && (
                <button className="btn primary" onClick={doReset}>重置密码</button>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
