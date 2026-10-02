/**
 * 设置视图 —— 隐私 / FFmpeg / 并发 / 离线模式（Provider 管理在「模型」页）。
 */
import { useState } from "react";
import { useApp } from "../store";

export default function SettingsView() {
  const { settings, patchSettings, ffmpeg, loadFfmpeg, toast } = useApp();
  const [ffmpegPath, setFfmpegPath] = useState(settings?.ffmpegPath ?? "");

  if (!settings) return <div className="page hint">加载中…</div>;

  const save = async () => {
    await patchSettings({ ffmpegPath: ffmpegPath.trim() || undefined });
    await loadFfmpeg();
    toast("设置已保存", "ok");
  };

  return (
    <div className="page">
      <div className="page-header">
        <div>
          <h1>设置</h1>
          <div className="desc">隐私与安全是默认值，不是选项</div>
        </div>
      </div>

      <div className="grid-2">
        <div className="card">
          <h3>🛡️ 隐私</h3>
          <label className="checkbox-row" style={{ marginBottom: 8 }}>
            <input type="checkbox" checked disabled />
            禁用遥测（默认关闭，代码中不存在任何分析 SDK）
          </label>
          <label className="checkbox-row" style={{ marginBottom: 8 }}>
            <input
              type="checkbox"
              checked={settings.offlineMode}
              onChange={(e) => patchSettings({ offlineMode: e.target.checked }).then(() => toast(e.target.checked ? "已开启 Local-only：公网 Provider 请求将被拒绝" : "已关闭 Local-only", "ok"))}
            />
            Local-only 完全离线模式（仅本机 Ollama/ComfyUI 可用）
          </label>
          <div className="hint">
            开启后：所有云端 Provider 变灰并被策略引擎拒绝；项目管理、剧本、分镜、素材与 FFmpeg 合成不受影响。
          </div>
        </div>

        <div className="card">
          <h3>🎞️ FFmpeg / FFprobe</h3>
          {ffmpeg ? (
            <>
              <div className="kv"><span className="k">ffmpeg</span><span className="v">{ffmpeg.ffmpegPath ?? "未找到"}</span></div>
              <div className="kv"><span className="k">ffprobe</span><span className="v">{ffmpeg.ffprobePath ?? "未找到"}</span></div>
              <div className="kv"><span className="k">版本</span><span className="v">{ffmpeg.ffmpegVersion ?? "—"}</span></div>
              <div className="hint" style={{ margin: "6px 0 10px" }}>{ffmpeg.message}</div>
            </>
          ) : (
            <div className="hint">检测中…</div>
          )}
          <div className="field">
            <label>自定义 ffmpeg 路径（留空自动探测 PATH / /usr/local/bin / /opt/homebrew/bin）</label>
            <input type="text" value={ffmpegPath} placeholder="/usr/local/bin/ffmpeg" onChange={(e) => setFfmpegPath(e.target.value)} />
          </div>
          <button className="btn" onClick={save}>保存并重新检测</button>
        </div>

        <div className="card">
          <h3>⚙️ 任务引擎</h3>
          <div className="field">
            <label>最大并发任务数</label>
            <input
              type="number"
              min={1}
              max={8}
              value={settings.maxConcurrentJobs}
              onChange={(e) => patchSettings({ maxConcurrentJobs: Math.max(1, Math.min(8, Number(e.target.value) || 2)) })}
            />
          </div>
          <div className="field">
            <label>自动保存间隔（秒）</label>
            <input
              type="number"
              min={5}
              max={300}
              value={settings.autoSaveIntervalSec}
              onChange={(e) => patchSettings({ autoSaveIntervalSec: Math.max(5, Math.min(300, Number(e.target.value) || 30)) })}
            />
          </div>
        </div>

        <div className="card">
          <h3>🔐 密钥存储</h3>
          <div className="hint">
            API Key 只写入 macOS 钥匙串（Keychain），不落 SQLite、不落 project.json、不进日志。
            Agent 只能通过 Provider 句柄获得“执行能力”，无法读取原始 Key。
          </div>
        </div>
      </div>
    </div>
  );
}
