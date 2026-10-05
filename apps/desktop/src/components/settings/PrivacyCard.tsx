/**
 * 🛡️ 隐私卡片 —— 从 SettingsView 原样迁出（遥测开关 / Local-only 模式 / 数据看板瓷贴）+ 局部样式 PRIV_CSS。
 */
import type * as api from "../../api";
import { useApp } from "../../store";
import { useT } from "../../i18n";

export function PrivacyCard({
  settings,
  patchSettings,
}: {
  settings: api.AppSettings;
  patchSettings: (patch: Partial<api.AppSettings>) => Promise<void>;
}) {
  const { toast } = useApp();
  const t = useT();
  return (
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
  );
}

/* ---------------- 隐私卡片局部样式（瓷贴，预算守卫看板复用同类） ---------------- */

export const PRIV_CSS = `
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
`;
