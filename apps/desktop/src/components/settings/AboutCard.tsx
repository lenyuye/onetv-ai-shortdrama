/**
 * ℹ️ 关于卡片 —— 从 SettingsView 原样迁出（版本号连点 5 次唤出测试时钟钩子 / 软件信息）。
 * 检查更新为 v2.11.0 起的占位实现（无发布源），代码保留待接入 tauri-plugin-updater。
 */
import { useApp } from "../../store";
import { useT } from "../../i18n";
import { useTimeHook } from "../../hooks/useTimeHook";

export function AboutCard() {
  const { appVersion } = useApp();
  const t = useT();
  const { timeHookOpen, offsetInput, setOffsetInput, hookStatus, onVersionClick, applyTimeOffset } = useTimeHook();

  return (
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
  );
}
