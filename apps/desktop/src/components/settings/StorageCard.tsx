/**
 * 💾 存储位置 / 🔐 密钥存储卡片 —— 从 SettingsView 原样迁出。
 * dataDir 由 SettingsView 挂载时拉取后传入（保持时序不变）。
 */
import * as api from "../../api";
import { useApp } from "../../store";
import { useT } from "../../i18n";

export function StorageCard({
  settings,
  dataDir,
}: {
  settings: api.AppSettings;
  dataDir: string;
}) {
  const { patchSettings, toast } = useApp();
  const t = useT();

  const pickDefaultFolder = async () => {
    try {
      const dir = await api.projectPickDirectory(t("选择默认项目文件夹（新项目将创建在这里）"));
      if (!dir) return;
      await patchSettings({ defaultProjectFolder: dir });
      toast(t("默认项目文件夹已保存"), "ok");
    } catch (e) {
      toast(t("设置失败：{msg}", { msg: api.errMsg(e) }), "err");
    }
  };

  const clearDefaultFolder = async () => {
    await patchSettings({ defaultProjectFolder: "" });
    toast(t("已清除默认项目文件夹"), "ok");
  };

  return (
    <div className="card">
      <h3>{t("💾 存储位置")}</h3>
      <div className="kv">
        <span className="k">{t("应用数据目录")}</span>
        <span className="v">{dataDir || "—"}</span>
      </div>
      <div className="kv">
        <span className="k">{t("默认项目文件夹")}</span>
        <span className="v">{settings.defaultProjectFolder || t("未设置（创建项目时手动选择）")}</span>
      </div>
      <div style={{ display: "flex", gap: 8, margin: "10px 0 8px", flexWrap: "wrap" }}>
        <button className="btn" onClick={pickDefaultFolder}>{t("📁 选择默认项目文件夹…")}</button>
        {settings.defaultProjectFolder && (
          <button className="btn danger" onClick={clearDefaultFolder}>{t("清除")}</button>
        )}
      </div>
      <div className="hint">
        {t("设置后，「工作区 → 创建项目」会直接创建到该文件夹，不再每次弹窗选择。 应用数据（设置、皮肤、日志等）固定存放在应用数据目录，随系统用户隔离。")}
      </div>
    </div>
  );
}

export function KeyStorageCard() {
  const t = useT();
  return (
    <div className="card">
      <h3>{t("🔐 密钥存储")}</h3>
      <div className="hint">
        {t("API Key 只写入 macOS 钥匙串（Keychain），不落 SQLite、不落 project.json、不进日志。 Agent 只能通过 Provider 句柄获得「执行能力」，无法读取原始 Key。")}
      </div>
    </div>
  );
}
