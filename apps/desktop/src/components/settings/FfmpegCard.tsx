/**
 * 🎞️ FFmpeg / FFprobe 卡片 —— v2.24「状态仪表」版(用户拍板方案 A):
 * 就绪横幅(指示灯+大版本号) + 三格能力瓷贴 + 自定义路径。
 * 探测/保存逻辑不变,仅重排视觉。
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

  const ready = !!(ffmpeg?.ffmpegPath && ffmpeg?.ffprobePath);
  const version = ffmpeg?.ffmpegVersion ?? "—";

  return (
    <div className="card" style={{ display: "flex", flexDirection: "column" }}>
      <style>{FF_CSS}</style>
      <h3 style={{ flexShrink: 0 }}>{t("🎞️ FFmpeg / FFprobe")}</h3>

      {/* 状态横幅:指示灯 + 就绪文案 + 大版本号 */}
      <div className={`ff-banner ${ready ? "ok" : "bad"}`}>
        <div className="ff-dot" />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="ff-banner-title">
            {ready ? t("FFmpeg 就绪 · 本地合成可用") : t("未检测到 FFmpeg —— 请安装或填入下方自定义路径")}
          </div>
          <div className="ff-banner-sub">
            {ready ? t("检测于本机 PATH，无需任何云端服务") : ffmpeg?.message || t("检测中…")}
          </div>
        </div>
        <div style={{ textAlign: "right", flexShrink: 0 }}>
          <div className="ff-version">{version}</div>
          <div className="ff-version-label">{t("版本")}</div>
        </div>
      </div>

      {/* 三格能力瓷贴 */}
      <div className="ff-tiles">
        <div className="ff-tile">
          <div className="ff-tile-icon">🎬</div>
          <div className="ff-tile-name">ffmpeg</div>
          <div className="ff-tile-sub">{t("拼接 · 转码 · 混音")}</div>
        </div>
        <div className="ff-tile">
          <div className="ff-tile-icon">🔍</div>
          <div className="ff-tile-name">ffprobe</div>
          <div className="ff-tile-sub">{t("时长 · 分辨率 · 音轨探测")}</div>
        </div>
        <div className="ff-tile">
          <div className="ff-tile-icon">📝</div>
          <div className="ff-tile-name">{t("字幕滤镜")}</div>
          <div className="ff-tile-sub">{t("缺 libass 时自动降级软字幕")}</div>
        </div>
      </div>

      <div className="field" style={{ marginTop: 13 }}>
        <label>{t("自定义 ffmpeg 路径（仅当自动探测失败时填写完整路径）")}</label>
        <input
          type="text"
          value={ffmpegPath}
          placeholder={t("留空 = 自动探测（PATH / /usr/local/bin / /opt/homebrew/bin）")}
          onChange={(e) => setFfmpegPath(e.target.value)}
        />
      </div>
      <div style={{ marginTop: 10 }}>
        <button className="btn" onClick={saveFfmpeg}>{t("保存并重新检测")}</button>
      </div>
    </div>
  );
}

const FF_CSS = `
.ff-banner { display: flex; align-items: center; gap: 13px; padding: 13px 15px; border-radius: 12px;
  border: 1px solid rgba(58, 208, 122, 0.35); margin-bottom: 13px;
  background: linear-gradient(90deg, rgba(58, 208, 122, 0.14), rgba(58, 208, 122, 0.03)); }
.ff-banner.bad { border-color: rgba(255, 138, 76, 0.4);
  background: linear-gradient(90deg, rgba(255, 138, 76, 0.13), rgba(255, 138, 76, 0.03)); }
.ff-dot { width: 12px; height: 12px; border-radius: 50%; flex-shrink: 0;
  background: var(--green, #3ad07a); box-shadow: 0 0 10px rgba(58, 208, 122, 0.8); }
.ff-banner.bad .ff-dot { background: #ff8a4c; box-shadow: 0 0 10px rgba(255, 138, 76, 0.8); }
.ff-banner-title { font-size: 14px; font-weight: 600; }
.ff-banner-sub { font-size: 12px; color: var(--muted); margin-top: 2px; }
.ff-version { font-size: 22px; font-weight: 700; color: var(--green, #3ad07a); }
.ff-banner.bad .ff-version { color: #ff8a4c; }
.ff-version-label { font-size: 11px; color: var(--muted); }
.ff-tiles { display: flex; gap: 10px; margin-bottom: 4px; }
.ff-tile { flex: 1; background: var(--panel-2); border: 1px solid var(--border);
  border-radius: 10px; padding: 10px 12px; min-width: 0; }
.ff-tile-icon { font-size: 18px; }
.ff-tile-name { font-size: 12.5px; margin-top: 4px; }
.ff-tile-sub { font-size: 11.5px; color: var(--muted); margin-top: 2px; }
`;
