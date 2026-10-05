/**
 * 👤 账户安全卡片 —— 从 SettingsView 原样迁出（改用户名 / 密码 / 绑定邮箱 + SMTP 邮件发送设置 + 退出）。
 * auth 状态与 refreshAuth 仍留在 SettingsView（保持挂载时机不变），本组件收 props 并持有表单状态。
 */
import { useState } from "react";
import * as api from "../../api";
import { useApp } from "../../store";
import { useT } from "../../i18n";

export function AccountCard({
  auth,
  refreshAuth,
}: {
  auth: api.AuthStatus | null;
  refreshAuth: () => void;
}) {
  const { toast } = useApp();
  const t = useT();

  // 账户表单
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
      setAccErr(api.errMsg(e));
    } finally {
      setAccBusy(false);
    }
  };

  return (
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
                      setMailMsg(t("⚠️ {msg}", { msg: api.errMsg(e) }));
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
                      setMailMsg(t("⚠️ {msg}", { msg: api.errMsg(e) }));
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
                toast(t("退出失败：{msg}", { msg: api.errMsg(e) }), "err");
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
  );
}
