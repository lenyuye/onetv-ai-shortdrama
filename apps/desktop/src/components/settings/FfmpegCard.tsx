/**
 * 🎞️ FFmpeg / FFprobe 卡片 —— 从 SettingsView 原样迁出（探测状态 / 自定义路径与重新检测）。
 */
import { useEffect, useState } from "react";
import * as api from "../../api";
import { useApp } from "../../store";
import { useT } from "../../i18n";

export function FfmpegCard({ settings }: { settings: api.AppSettings }) {
  const { ffmpeg, patchSettings, loadFfmpeg, toast } = useApp();
  const t = useT();
  const [ffmpegPath, setFfmpegPath] = useState(settings?.ffmpegPath ?? "");

  useEffect(() => {
    setFfmpegPath(settings?.ffmpegPath ?? "");
  }, [settings?.ffmpegPath]);

  const saveFfmpeg = async () => {
    try {
      await patchSettings({ ffmpegPath: ffmpegPath.trim() || undefined });
      await loadFfmpeg();
      toast(t("设置已保存"), "ok");
    } catch (e) {
      if (!api.errMsg(e).includes("已取消")) toast(t("保存失败：{msg}", { msg: api.errMsg(e) }), "err");
    }
  };

  return (
    <div className="card">
      <h3>{t("🎞️ FFmpeg / FFprobe")}</h3>
      {ffmpeg ? (
        <>
          <div className="kv"><span className="k">ffmpeg</span><span className="v">{ffmpeg.ffmpegPath ?? t("未找到")}</span></div>
          <div className="kv"><span className="k">ffprobe</span><span className="v">{ffmpeg.ffprobePath ?? t("未找到")}</span></div>
          <div className="kv"><span className="k">{t("版本")}</span><span className="v">{ffmpeg.ffmpegVersion ?? "—"}</span></div>
          <div className="hint" style={{ margin: "6px 0 10px" }}>{ffmpeg.message}</div>
        </>
      ) : (
        <div className="hint">{t("检测中…")}</div>
      )}
      <div className="field">
        <label>{t("自定义 ffmpeg 路径（仅当自动探测失败时填写完整路径）")}</label>
        <input type="text" value={ffmpegPath} placeholder={t("留空 = 自动探测（PATH / /usr/local/bin / /opt/homebrew/bin）")} onChange={(e) => setFfmpegPath(e.target.value)} />
      </div>
      <button className="btn" onClick={saveFfmpeg}>{t("保存并重新检测")}</button>
    </div>
  );
}
