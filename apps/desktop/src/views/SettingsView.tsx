/**
 * 设置视图 —— 隐私 / FFmpeg / 并发 / 外观与主题（v2.1）/ 账户安全（v2.1）。
 */
import { useEffect, useState } from "react";
import * as api from "../api";
import { useApp } from "../store";

export default function SettingsView() {
  const { settings, patchSettings, ffmpeg, loadFfmpeg, toast, loadSettings } = useApp();
  const [ffmpegPath, setFfmpegPath] = useState(settings?.ffmpegPath ?? "");
  const [auth, setAuth] = useState<api.AuthStatus | null>(null);

  // 账户表单
  const [curPass, setCurPass] = useState("");
  const [newUser, setNewUser] = useState("");
  const [newPass, setNewPass] = useState("");
  const [email, setEmail] = useState("");
  const [accErr, setAccErr] = useState("");
  const [accBusy, setAccBusy] = useState(false);

  const refreshAuth = () => api.authStatus().then(setAuth).catch(() => {});
  useEffect(() => {
    refreshAuth();
  }, []);

  useEffect(() => {
    setFfmpegPath(settings?.ffmpegPath ?? "");
  }, [settings?.ffmpegPath]);

  if (!settings) return <div className="page hint">加载中…</div>;

  const saveFfmpeg = async () => {
    await patchSettings({ ffmpegPath: ffmpegPath.trim() || undefined });
    await loadFfmpeg();
    toast("设置已保存", "ok");
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
      });
      toast("账户信息已更新", "ok");
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
      setAccErr(String(e));
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
      if (!String(e).includes("取消")) toast(`皮肤设置失败：${String(e)}`, "err");
    }
  };

  const clearSkin = async () => {
    await api.themeClearSkin();
    await loadSettings();
    toast("已恢复默认背景", "ok");
  };

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1>设置</h1>
          <div className="desc">隐私与安全是默认值，不是选项</div>
        </div>
      </div>

      <div className="grid-2">
        {/* 外观设置（v2.1） */}
        <div className="card">
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
                onClick={() => saveAppearance({ skin: undefined })}
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
            <label>皮肤不透明度：{Math.round((settings.skinOpacity ?? 0.18) * 100)}%</label>
            <input
              type="range"
              min={0}
              max={100}
              value={Math.round((settings.skinOpacity ?? 0.18) * 100)}
              onChange={(e) => saveAppearance({ skinOpacity: Number(e.target.value) / 100 })}
            />
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
                <input type="text" placeholder="you@example.com" value={email} onChange={(e) => setEmail(e.target.value)} />
              </div>
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
                  await api.authLogout();
                  useApp.getState().setAuthed(false);
                }}
              >
                退出账号
              </button>
            </>
          ) : (
            <div className="hint">加载中…</div>
          )}
        </div>

        {/* 隐私 */}
        <div className="card">
          <h3>🛡️ 隐私</h3>
          <label className="checkbox-row" style={{ marginBottom: 8 }}>
            <input type="checkbox" checked disabled />
            禁用遥测（默认关闭，代码中不存在任何分析 SDK）
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
        </div>

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
            <label>自定义 ffmpeg 路径（留空自动探测 PATH / /usr/local/bin / /opt/homebrew/bin）</label>
            <input type="text" value={ffmpegPath} placeholder="/usr/local/bin/ffmpeg" onChange={(e) => setFfmpegPath(e.target.value)} />
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

        <div className="card">
          <h3>🔐 密钥存储</h3>
          <div className="hint">
            API Key 只写入 macOS 钥匙串（Keychain），不落 SQLite、不落 project.json、不进日志。
            Agent 只能通过 Provider 句柄获得「执行能力」，无法读取原始 Key。
          </div>
        </div>
      </div>
    </div>
  );
}
