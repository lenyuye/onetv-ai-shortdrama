/**
 * 💾 存储位置 / 🔐 密钥存储卡片 —— v2.24「路径卡」版(用户拍板方案 A):
 * 两块大路径条(应用数据=固定 / 默认项目文件夹=可配置) + 绿色"数据只存本机"横幅。
 * 选择/清除逻辑不变,仅重排视觉。
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
    <div className="card st-card">
      <style>{ST_CSS}</style>
      <h3>{t("💾 存储位置")}</h3>

      {/* 路径条 1:应用数据目录(固定) */}
      <div className="st-pathbox">
        <div className="st-icon st-icon-blue">🗄️</div>
        <div className="st-main">
          <div className="st-name">{t("应用数据目录")}</div>
          <div className="st-path">{dataDir || "—"}</div>
          <div className="st-sub">{t("设置 · 皮肤 · 日志等，随系统用户隔离，不可更改")}</div>
        </div>
        <span className="st-chip">{t("固定")}</span>
      </div>

      {/* 路径条 2:默认项目文件夹(可配置) */}
      <div className="st-pathbox">
        <div className="st-icon st-icon-pink">📁</div>
        <div className="st-main">
          <div className="st-name">{t("默认项目文件夹")}</div>
          <div className="st-path st-path-ok">
            {settings.defaultProjectFolder || t("未设置（创建项目时手动选择）")}
          </div>
          <div className="st-sub">{t("设置后「工作区 → 创建项目」直接落到该文件夹，不再弹窗")}</div>
        </div>
        <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
          {settings.defaultProjectFolder && (
            <button className="btn st-btn-danger" onClick={clearDefaultFolder}>{t("清除")}</button>
          )}
          <button className="btn" style={{ whiteSpace: "nowrap" }} onClick={pickDefaultFolder}>
            {t("📂 选择…")}
          </button>
        </div>
      </div>

      {/* 隐私横幅 */}
      <div className="st-privacy">
        <span className="st-privacy-icon">🛡️</span>
        <span>{t("所有数据只存本机 —— 整个工程文件夹可直接拷贝迁移，删除即清除。")}</span>
      </div>
    </div>
  );
}

const ST_CSS = `
.st-card { display: flex; flex-direction: column; }
.st-pathbox { display: flex; align-items: center; gap: 12px; background: var(--panel-2);
  border: 1px solid var(--border); border-radius: 12px; padding: 12px 14px; }
.st-pathbox + .st-pathbox { margin-top: 10px; }
.st-icon { width: 40px; height: 40px; border-radius: 10px; flex-shrink: 0;
  display: flex; align-items: center; justify-content: center; font-size: 19px; }
.st-icon-blue { background: rgba(77, 124, 254, 0.15); border: 1px solid rgba(77, 124, 254, 0.35); }
.st-icon-pink { background: rgba(208, 74, 216, 0.15); border: 1px solid rgba(208, 74, 216, 0.35); }
.st-main { flex: 1; min-width: 0; }
.st-name { font-size: 12.5px; font-weight: 600; }
.st-path { font-family: "SF Mono", Menlo, monospace; font-size: 11.5px; color: var(--muted);
  word-break: break-all; margin-top: 3px; }
.st-path-ok { color: var(--text); }
.st-sub { font-size: 11.5px; color: var(--muted); margin-top: 3px; }
.st-chip { font-size: 11px; color: var(--muted); border: 1px solid var(--border-strong);
  padding: 3px 9px; border-radius: 999px; flex-shrink: 0; white-space: nowrap; }
.st-btn-danger { white-space: nowrap; }
.st-privacy { display: flex; align-items: center; gap: 8px; padding: 10px 14px; margin-top: 12px;
  border-radius: 10px; font-size: 12px;
  background: rgba(58, 208, 122, 0.08); border: 1px solid rgba(58, 208, 122, 0.3); }
.st-privacy-icon { font-size: 16px; }
`;

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
