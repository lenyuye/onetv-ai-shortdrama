/**
 * 登录界面（v2.1）—— 本地账户门。
 * 默认 admin / 12345；忘记密码凭绑定邮箱重置（本地验证邮箱地址，无验证码下发）。
 */
import { useEffect, useState } from "react";
import * as api from "../api";
import { useApp } from "../store";

/** Tauri 命令 Err 时前端拿到 {message} 对象，统一提取可读文案 */
const errMsg = (e: unknown): string => {
  if (typeof e === "string") return e;
  if (e && typeof e === "object" && "message" in e) return String((e as { message: unknown }).message);
  try { return JSON.stringify(e); } catch { return String(e); }
};

export default function LoginView({ onSuccess }: { onSuccess: () => void }) {
  const { toast, appVersion } = useApp();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const [resetOpen, setResetOpen] = useState(false);
  const [resetEmail, setResetEmail] = useState("");
  const [resetPass, setResetPass] = useState("");
  const [resetErr, setResetErr] = useState("");
  const [stillDefault, setStillDefault] = useState<boolean | null>(null);
  // 底部默认账号提示：null=检测中（保持显示原文），true=仍是默认密码，false=用户已自定义
  const [footDefault, setFootDefault] = useState<boolean | null>(null);

  useEffect(() => {
    api.authStatus()
      .then((st) => setFootDefault(st.hasDefaultPassword))
      .catch(() => setFootDefault(null));
  }, []);

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
      setErr(errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  const doReset = async () => {
    setResetErr("");
    const email = resetEmail.trim();
    if (!email || !email.includes("@") || resetPass.length < 5) {
      setResetErr("请输入绑定邮箱和新密码（至少 5 位）");
      return;
    }
    try {
      await api.authResetWithEmail(email, resetPass);
      toast("密码已重置，请用新密码登录", "ok");
      setResetOpen(false);
      setPassword("");
    } catch (e) {
      setResetErr(errMsg(e));
    }
  };

  return (
    <div className="login-wrap">
      <div className="skin-layer" />
      <div className="login-card">
        <div className="login-logo">
          <img src="/logo.png" alt="OneTV" />
          <h1>OneTV</h1>
          <p>本地优先的短剧创作工作台 · v{appVersion ?? "…"}</p>
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
            placeholder="请输入密码"
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
          <span>
            {footDefault === null
              ? "首次使用：账号 admin / 密码 12345，登录后请在「设置 → 账户安全」修改并绑定邮箱"
              : footDefault
                ? "首次使用：账号 admin / 密码 12345，登录后请在「设置 → 账户安全」修改并绑定邮箱"
                : "账号为你本人设置（忘记密码可凭绑定邮箱重置）"}
          </span>
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
                <label>新密码（至少 5 位）</label>
                <input type="password" value={resetPass} onChange={(e) => setResetPass(e.target.value)} />
              </div>
              <div className="hint">
                本地应用仅验证邮箱地址与绑定邮箱一致即可重置（验证码验证暂未启用）。
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
