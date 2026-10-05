/**
 * ⚙️ 任务引擎卡片 —— 从 SettingsView 原样迁出（最大并发任务数 / 自动保存间隔）。
 */
import type * as api from "../../api";
import { useApp } from "../../store";
import { useT } from "../../i18n";

export function TaskEngineCard({ settings }: { settings: api.AppSettings }) {
  const { patchSettings } = useApp();
  const t = useT();
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
    </div>
  );
}
