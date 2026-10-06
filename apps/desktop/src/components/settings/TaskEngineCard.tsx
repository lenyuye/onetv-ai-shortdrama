/**
 * ⚙️ 任务引擎卡片 —— 从 SettingsView 原样迁出（最大并发任务数 / 自动保存间隔）。
 * v2.22 追加：🔗 出站 Webhook 回调（任务终态 POST 到用户配置 URL）。
 */
import { useState } from "react";
import type * as api from "../../api";
import { useApp } from "../../store";
import { useT } from "../../i18n";

export function TaskEngineCard({ settings }: { settings: api.AppSettings }) {
  const { patchSettings } = useApp();
  const t = useT();
  const wo = settings.webhookOut ?? { enabled: false, url: "", secret: "" };
  const [url, setUrl] = useState(wo.url);
  const [secret, setSecret] = useState(wo.secret);

  const saveOut = (patch: Partial<typeof wo>) => {
    const next = { ...wo, ...patch };
    patchSettings({ webhookOut: { enabled: next.enabled, url: next.url.trim(), secret: next.secret } });
  };

  return (
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

      <div className="field">
        <label>{t("🔗 出站 Webhook 回调")}</label>
        <label style={{ display: "flex", alignItems: "center", gap: 8, fontWeight: "normal" }}>
          <input
            type="checkbox"
            checked={wo.enabled}
            onChange={(e) => saveOut({ enabled: e.target.checked })}
          />
          {t("任务完成/失败时回调通知（POST JSON 到你的 URL）")}
        </label>
        <input
          type="text"
          placeholder={t("回调 URL（如 http://127.0.0.1:9000/hook）")}
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onBlur={() => {
            if (url.trim() !== wo.url) saveOut({ url });
          }}
        />
        <input
          type="password"
          placeholder={t("签名密钥（HMAC-SHA256，可选）")}
          value={secret}
          onChange={(e) => setSecret(e.target.value)}
          onBlur={() => {
            if (secret !== wo.secret) saveOut({ secret });
          }}
        />
        <div className="hint">{t("启用后主机自动加入允许域名；请求带 X-OneTV-Event 与 X-OneTV-Signature 头，失败自动重试 2 次。")}</div>
      </div>
    </div>
  );
}
