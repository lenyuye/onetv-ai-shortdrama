/**
 * 💰 预算守卫卡片 —— 从 SettingsView 原样迁出（开关 / 次数上限 / 用量看板瓷贴）。
 * 表单状态与用量拉取仍留在 SettingsView（保持挂载时机不变），本组件只收 props 展示与回调。
 */
import * as api from "../../api";
import { useT } from "../../i18n";

export function CostGuardCard({
  settings,
  cgEnabled,
  cgDaily,
  cgTotal,
  setCgEnabled,
  setCgDaily,
  setCgTotal,
  saveCostGuard,
  costs,
  projectTitle,
}: {
  settings: api.AppSettings;
  cgEnabled: boolean;
  cgDaily: number;
  cgTotal: number;
  setCgEnabled: (v: boolean) => void;
  setCgDaily: (v: number) => void;
  setCgTotal: (v: number) => void;
  saveCostGuard: (patch: { enabled?: boolean; dailyRemoteLimit?: number; projectTotalLimit?: number }) => void;
  costs: { today: number; total: number; todayCost: number; totalCost: number } | null;
  projectTitle: string | null;
}) {
  const t = useT();
  return (
    <div className="card" style={{ alignSelf: "stretch", height: "100%", display: "flex", flexDirection: "column" }}>
      <h3 style={{ flexShrink: 0 }}>{t("💰 预算守卫")}</h3>
      <div className="hint" style={{ flexShrink: 0 }}>
        {t("限制远程生成（生图 / 生视频 / 配音）的调用次数，防止意外烧钱。本地 Mock / ComfyUI / Ollama 不计数。")}
      </div>
      <label style={{ display: "flex", gap: 8, alignItems: "center", marginTop: 10, cursor: "pointer", flexShrink: 0 }}>
        <input
          type="checkbox"
          checked={cgEnabled}
          onChange={(e) => { setCgEnabled(e.target.checked); saveCostGuard({ enabled: e.target.checked }); }}
        />
        <span style={{ fontSize: 12.5 }}>{t("启用预算守卫（达到上限后新任务会被拦截并提示）")}</span>
      </label>
      <div className="grid-2" style={{ marginTop: 10 }}>
        <div className="field">
          <label>{t("每日上限（次 / 项目）")}</label>
          <input
            type="number" min={1}
            value={cgDaily}
            disabled={!cgEnabled}
            onChange={(e) => setCgDaily(Number(e.target.value) || 0)}
            onBlur={() => saveCostGuard({ dailyRemoteLimit: cgDaily })}
          />
        </div>
        <div className="field">
          <label>{t("项目累计上限（次）")}</label>
          <input
            type="number" min={1}
            value={cgTotal}
            disabled={!cgEnabled}
            onChange={(e) => setCgTotal(Number(e.target.value) || 0)}
            onBlur={() => saveCostGuard({ projectTotalLimit: cgTotal })}
          />
        </div>
      </div>
      <div className="hint" style={{ flexShrink: 0, marginBottom: 4 }}>{t("计数在任务成功后写入项目 costs.json（不出本机）。")}{projectTitle ? t("当前项目：{name}", { name: projectTitle }) : t("未打开项目——打开项目后显示真实用量")}</div>

      {/* 用量看板（v2.11.1）：与隐私卡同款瓷贴，随卡片高度自动铺满 */}
      <div className="prv-tiles">
        <div className="prv-tile prv-t2">
          <span className="prv-tic">📊</span>
          <div><b>{t("今日已用 {n}", { n: costs ? t("{n} 次", { n: costs.today }) : "—" })}</b><span className="prv-td">{t("每日上限 {n} 次（{status}）", { n: settings?.costGuard?.dailyRemoteLimit ?? 100, status: cgEnabled ? t("守卫中") : t("守卫未启用") })}</span></div>
        </div>
        <div className="prv-tile prv-t1">
          <span className="prv-tic">💰</span>
          <div><b>{t("项目累计 {n}", { n: costs ? t("{n} 次", { n: costs.total }) : "—" })}</b><span className="prv-td">{t("累计上限 {n} 次", { n: settings?.costGuard?.projectTotalLimit ?? 1000 })}</span></div>
        </div>
        <div className="prv-tile prv-t3">
          <span className="prv-tic">🛡️</span>
          <div><b>{t("超限自动拦截")}</b><span className="prv-td">{t("达到上限后新任务不提交、不扣费，给出可读提示")}</span></div>
        </div>
        <div className="prv-tile prv-t4">
          <span className="prv-tic">🏠</span>
          <div><b>{t("本地任务不计数")}</b><span className="prv-td">{t("Mock / ComfyUI / Ollama 本地创作随便跑")}</span></div>
        </div>
      </div>
    </div>
  );
}
