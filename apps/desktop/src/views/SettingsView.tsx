/**
 * 设置视图 —— 隐私 / 意识模块（记忆）/ FFmpeg / 并发 / 外观与主题（v2.1）/ 账户安全（v2.1）。
 *
 * 结构重构说明：本文件是组合根 —— settings 状态、用量/账户拉取与保存回调留在这里；
 * 各卡片拆分至 components/settings/*（行为与字符串零变化，仅移动）。
 */
import { useEffect, useState } from "react";
import * as api from "../api";
import { costsGet } from "../api-extras";
import { useApp } from "../store";
import { useT } from "../i18n";
import { AppearanceCard } from "../components/settings/AppearanceCard";
import { CostGuardCard } from "../components/settings/CostGuardCard";
import { AccountCard } from "../components/settings/AccountCard";
import { PrivacyCard, PRIV_CSS } from "../components/settings/PrivacyCard";
import { MemoryCard, MEM_CSS } from "../components/settings/MemoryCard";
import { FfmpegCard } from "../components/settings/FfmpegCard";
import { TaskEngineCard } from "../components/settings/TaskEngineCard";
import { StorageCard, KeyStorageCard } from "../components/settings/StorageCard";
import { AboutCard } from "../components/settings/AboutCard";

export default function SettingsView() {
  const { settings, patchSettings, toast } = useApp();
  const t = useT();

  // 账户状态（账户卡片展示 + 提交后刷新；挂载即拉取，保持原时序）
  const [auth, setAuth] = useState<api.AuthStatus | null>(null);
  const refreshAuth = () => api.authStatus().then(setAuth).catch(() => {});
  useEffect(() => {
    refreshAuth();
  }, []);

  // 应用数据目录（存储位置卡片展示）
  const [dataDir, setDataDir] = useState<string>("");
  useEffect(() => {
    api.appInfo().then((info) => setDataDir(info.dataDir)).catch(() => {});
  }, []);

  // v2.10 预算守卫（表单状态留在组合根，保存回调依赖它兜底未保存的相邻字段）
  const [cgEnabled, setCgEnabled] = useState(false);
  const [cgDaily, setCgDaily] = useState(100);
  const [cgTotal, setCgTotal] = useState(1000);

  // v2.11.1 当前项目远程生成用量（预算守卫看板数据）
  const [costs, setCosts] = useState<{ today: number; total: number; todayCost: number; totalCost: number } | null>(null);
  const projectTitle = useApp((s) => s.project?.project?.title ?? null);
  useEffect(() => {
    costsGet()
      .then((c) => setCosts({ today: c.today, total: c.total, todayCost: c.todayCost, totalCost: c.totalCost }))
      .catch(() => setCosts(null));
  }, [projectTitle]);

  // settings 到本地表单状态的同步（预算守卫部分；ffmpegPath 的同步在 FfmpegCard 内）
  useEffect(() => {
    setCgEnabled(settings?.costGuard?.enabled ?? false);
    setCgDaily(settings?.costGuard?.dailyRemoteLimit ?? 100);
    setCgTotal(settings?.costGuard?.projectTotalLimit ?? 1000);
  }, [settings?.costGuard]);

  if (!settings) return <div className="page hint">{t("加载中…")}</div>;

  const saveAppearance = async (patch: Partial<api.AppSettings>) => {
    await patchSettings(patch);
    toast(t("外观已更新"), "ok");
  };

  const saveCostGuard = (patch: { enabled?: boolean; dailyRemoteLimit?: number; projectTotalLimit?: number }) => {
    const next = {
      enabled: patch.enabled ?? cgEnabled,
      dailyRemoteLimit: Math.max(1, Math.round(patch.dailyRemoteLimit ?? cgDaily)),
      projectTotalLimit: Math.max(1, Math.round(patch.projectTotalLimit ?? cgTotal)),
    };
    void patchSettings({ costGuard: next })
      .then(() => toast(t("预算守卫已更新"), "ok"))
      .catch((e) => toast(t("保存失败：{msg}", { msg: api.errMsg(e) }), "err"));
  };

  return (
    <div className="page">
      <style>{MEM_CSS}</style>
      <style>{PRIV_CSS}</style>
      <div className="page-header">
        <div>
          <h1>{t("设置")}</h1>
          <div className="desc">{t("隐私与安全是默认值，不是选项")}</div>
        </div>
      </div>

      <div className="grid-2">
        {/* 外观设置（v2.1）—— 卡片内保持 alignSelf:start 避免被右侧更高的卡片拉伸出大片空白 */}
        <AppearanceCard settings={settings} saveAppearance={saveAppearance} />

        {/* 预算守卫（v2.10）—— 卡片保持显式 alignSelf/height 等高对齐属性 */}
        <CostGuardCard
          settings={settings}
          cgEnabled={cgEnabled}
          cgDaily={cgDaily}
          cgTotal={cgTotal}
          setCgEnabled={setCgEnabled}
          setCgDaily={setCgDaily}
          setCgTotal={setCgTotal}
          saveCostGuard={saveCostGuard}
          costs={costs}
          projectTitle={projectTitle}
        />

        {/* 账户安全（v2.1） */}
        <AccountCard auth={auth} refreshAuth={refreshAuth} />

        {/* 隐私（v2.5：普通网格子项，列宽与上下行对齐；height:100% 保证与同行卡片等高） */}
        <PrivacyCard settings={settings} patchSettings={patchSettings} />

        {/* 意识模块（记忆，v2.3.5+；按项目存储） */}
        <MemoryCard />

        {/* FFmpeg */}
        <FfmpegCard settings={settings} />

        {/* 任务引擎 */}
        <TaskEngineCard settings={settings} />

        {/* 存储位置（v2.3.2）+ 密钥存储 */}
        <StorageCard settings={settings} dataDir={dataDir} />
        <KeyStorageCard />

        {/* 关于 / 版本（v2.3.2）—— 连点版本号 5 次唤出测试时钟钩子 */}
        <AboutCard />
      </div>
    </div>
  );
}
