/**
 * 🎨 外观设置卡片 —— 从 SettingsView 原样迁出（外观模式 / 界面语言 / 主题皮肤 / 清晰度滑杆与通栏预览）。
 */
import { useState } from "react";
import * as api from "../../api";
import { useApp } from "../../store";
import { getLang, setLang, useT } from "../../i18n";

export function AppearanceCard({
  settings,
  saveAppearance,
}: {
  settings: api.AppSettings;
  saveAppearance: (patch: Partial<api.AppSettings>) => Promise<void>;
}) {
  const { patchSettings, loadSettings, toast } = useApp();
  const t = useT();

  // 皮肤不透明度：拖动只改本地（避免每个 tick 写盘+受控回跳），松手才提交
  const [skinOpacityLocal, setSkinOpacityLocal] = useState<number | null>(null);
  const skinOpacityShown = skinOpacityLocal ?? (settings?.skinOpacity ?? 0.18);

  const uploadSkin = async () => {
    try {
      await api.themeSetSkin();
      await loadSettings();
      toast(t("皮肤已应用"), "ok");
    } catch (e) {
      if (!api.errMsg(e).includes("取消")) toast(t("皮肤设置失败：{msg}", { msg: api.errMsg(e) }), "err");
    }
  };

  const clearSkin = async () => {
    await api.themeClearSkin();
    await loadSettings();
    toast(t("已恢复默认背景"), "ok");
  };

  return (
    <div className="card" style={{ alignSelf: "start" }}>
      <h3>{t("🎨 外观设置")}</h3>
      <div className="field">
        <label>{t("外观模式")}</label>
        <div style={{ display: "flex", gap: 8 }}>
          <button
            className={`btn ${settings.theme !== "light" ? "primary" : ""}`}
            onClick={() => saveAppearance({ theme: "dark" })}
          >
            {t("🌙 暗色")}
          </button>
          <button
            className={`btn ${settings.theme === "light" ? "primary" : ""}`}
            onClick={() => saveAppearance({ theme: "light" })}
          >
            {t("☀️ 浅色")}
          </button>
        </div>
      </div>

      <div className="field">
        <label>{t("界面语言")}</label>
        <div style={{ display: "flex", gap: 8 }}>
          <button
            className={`btn ${getLang() !== "en" ? "primary" : ""}`}
            onClick={() => setLang("zh")}
          >
            中文
          </button>
          <button
            className={`btn ${getLang() === "en" ? "primary" : ""}`}
            onClick={() => setLang("en")}
          >
            English
          </button>
        </div>
      </div>

      <div className="field">
        <label>{t("主题皮肤")}</label>
        <div className="hint" style={{ marginBottom: 8 }}>
          {t("内置两套主题（暗色霓虹 / 浅色晨雾）。上传图片可作全局背景皮肤（类似 Aion UI 的自定义皮肤）， 仅存本机。")}
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button
            className={`btn ${!settings.skin ? "blue" : ""}`}
            onClick={clearSkin}
          >
            {t("默认渐变背景")}
          </button>
          <button className="btn" onClick={uploadSkin}>{t("🖼️ 上传图片皮肤…")}</button>
          {settings.skin && (
            <button className="btn danger" onClick={clearSkin}>{t("清除皮肤")}</button>
          )}
        </div>
        {settings.skin && (
          <div className="kv" style={{ marginTop: 8 }}>
            <span className="k">{t("当前皮肤")}</span>
            <span className="v">{settings.skin}</span>
          </div>
        )}
      </div>

      <div className="field">
        <label>{t("皮肤清晰度：{n}%（数值越小皮肤越明显）", { n: Math.round(skinOpacityShown * 100) })}</label>
        <input
          type="range"
          min={0}
          max={50}
          value={Math.round(skinOpacityShown * 100)}
          onChange={(e) => {
            const v = Number(e.target.value) / 100;
            setSkinOpacityLocal(v);
            // 实时预览：只改前端变量，不写盘
            const layer = document.querySelector<HTMLDivElement>(".skin-layer");
            if (layer && settings.skin) {
              const img = `url(onetv-app://localhost/${encodeURIComponent(settings.skin)})`;
              const veil = Math.min(0.92, Math.max(0, 1 - v * 2));
              const rgb = settings.theme === "light" ? "242, 244, 250" : "10, 13, 24";
              layer.style.backgroundImage = `linear-gradient(rgba(${rgb}, ${veil.toFixed(2)}), rgba(${rgb}, ${veil.toFixed(2)})), ${img}`;
            }
          }}
          onPointerUp={() => {
            if (skinOpacityLocal !== null) {
              void patchSettings({ skinOpacity: skinOpacityLocal });
              setSkinOpacityLocal(null);
            }
          }}
          onKeyUp={() => {
            if (skinOpacityLocal !== null) {
              void patchSettings({ skinOpacity: skinOpacityLocal });
              setSkinOpacityLocal(null);
            }
          }}
          onBlur={() => {
            // 拖动中失焦（如切窗口/点其他控件）时兜底提交，避免丢值
            if (skinOpacityLocal !== null) {
              void patchSettings({ skinOpacity: skinOpacityLocal });
              setSkinOpacityLocal(null);
            }
          }}
        />
        {settings.skin && (
          <div style={{ marginTop: 14 }}>
            {/* 通栏大图预览：占满卡片宽度，清晰度遮罩与滑杆实时联动，效果即主界面所见 */}
            <div
              style={{
                width: "100%",
                height: 300,
                borderRadius: 12,
                position: "relative",
                overflow: "hidden",
                border: "1px solid var(--border-strong)",
                boxShadow: "0 4px 18px rgba(0,0,0,.22)",
                backgroundImage: `linear-gradient(rgba(${
                  settings.theme === "light" ? "242,244,250" : "10,13,24"
                }, ${Math.min(0.92, Math.max(0, 1 - skinOpacityShown * 2)).toFixed(2)}), rgba(${
                  settings.theme === "light" ? "242,244,250" : "10,13,24"
                }, ${Math.min(0.92, Math.max(0, 1 - skinOpacityShown * 2)).toFixed(2)})), url(onetv-app://localhost/${encodeURIComponent(settings.skin)})`,
                backgroundSize: "cover",
                backgroundPosition: "center",
              }}
              title={t("当前皮肤预览（随清晰度滑杆实时变化，与主界面实际效果一致）")}
            >
              <div
                style={{
                  position: "absolute", left: 0, right: 0, bottom: 0,
                  padding: "26px 14px 10px",
                  background: "linear-gradient(transparent, rgba(0,0,0,.55))",
                  color: "#fff", fontSize: 12.5,
                  display: "flex", alignItems: "baseline", gap: 10,
                }}
              >
                <b style={{ fontSize: 13 }}>{t("当前皮肤")}</b>
                <span style={{ opacity: .85 }}>{settings.skin}</span>
                <span style={{ flex: 1 }} />
                <span style={{ opacity: .85 }}>{t("清晰度 {n}%", { n: Math.round(skinOpacityShown * 100) })}</span>
              </div>
            </div>
            <div className="hint" style={{ marginTop: 8 }}>
              {t("预览随上方滑杆实时变化，与主界面实际效果一致；拖动「清晰度」可调整皮肤浓淡。")}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
