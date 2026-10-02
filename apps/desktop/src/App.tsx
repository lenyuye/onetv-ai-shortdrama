/**
 * OneTV 应用外壳 —— 顶栏 / 左侧导航 / 主区 / 底部任务栏（规格 §2.1）。
 */
import { useEffect } from "react";
import { useApp, type ViewKey } from "./store";
import HomeView from "./views/HomeView";
import ProjectsView from "./views/ProjectsView";
import SettingsView from "./views/SettingsView";
import ModelsView from "./views/ModelsView";
import AssetsView from "./views/AssetsView";
import CanvasView from "./views/CanvasView";
import ScriptView from "./views/ScriptView";
import StoryboardView from "./views/StoryboardView";
import JobsView from "./views/JobsView";
import SkillsView from "./views/SkillsView";
import { Toaster } from "./components/Toaster";

const NAV: { key: ViewKey; icon: string; label: string; section: string }[] = [
  { key: "home", icon: "🏠", label: "工作区", section: "工作区" },
  { key: "projects", icon: "🎬", label: "项目", section: "工作区" },
  { key: "agent", icon: "🤖", label: "Agent 对话", section: "创作" },
  { key: "script", icon: "📝", label: "剧本", section: "创作" },
  { key: "storyboard", icon: "🖼️", label: "分镜", section: "创作" },
  { key: "canvas", icon: "🕸️", label: "画布", section: "创作" },
  { key: "assets", icon: "🗂️", label: "资产", section: "管理" },
  { key: "models", icon: "🧠", label: "模型", section: "管理" },
  { key: "skills", icon: "🧩", label: "Skills", section: "管理" },
  { key: "jobs", icon: "⏳", label: "任务", section: "管理" },
  { key: "settings", icon: "⚙️", label: "设置", section: "系统" },
];

const PLACEHOLDER_VIEWS: Record<string, string> = {};

export default function App() {
  const { view, setView, settings, loadSettings, ffmpeg, loadFfmpeg, project, loadProject } =
    useApp();

  useEffect(() => {
    loadSettings();
    loadFfmpeg();
    loadProject();
  }, []);

  const offline = settings?.offlineMode ?? false;

  let main: React.ReactNode;
  switch (view) {
    case "home":
      main = <HomeView />;
      break;
    case "projects":
      main = <ProjectsView />;
      break;
    case "settings":
      main = <SettingsView />;
      break;
    case "models":
      main = <ModelsView />;
      break;
    case "assets":
      main = <AssetsView />;
      break;
    case "canvas":
      main = <CanvasView />;
      break;
    case "script":
      main = <ScriptView />;
      break;
    case "storyboard":
      main = <StoryboardView />;
      break;
    case "jobs":
      main = <JobsView />;
      break;
    case "skills":
      main = <SkillsView />;
      break;
    default:
      main = (
        <PlaceholderView
          view={view}
          hasProject={!!project}
          text={PLACEHOLDER_VIEWS[view] ?? "该模块将在后续阶段实现"}
        />
      );
  }

  return (
    <div className="app-shell">
      {/* 顶栏 */}
      <header className="topbar">
        <div className="logo">
          <img src="/logo.png" alt="OneTV" />
          <span>OneTV</span>
        </div>
        <div className="divider" />
        <span className="save-state">{project ? `项目：${project.project.title}` : "未打开项目"}</span>
        <div className="spacer" />
        {offline && <span className="pill offline">🛡️ Local-only 离线模式</span>}
        <span className={`pill ${ffmpeg?.ok ? "ok" : "warn"}`} title={ffmpeg?.message}>
          {ffmpeg?.ok ? `FFmpeg ${ffmpeg.ffmpegVersion ?? ""}` : "FFmpeg 未就绪"}
        </span>
        <span className="pill" title="任务队列">任务 0</span>
        <button className="btn sm ghost" onClick={() => setView("settings")}>设置</button>
      </header>

      <div className="app-body">
        {/* 左侧导航 */}
        <nav className="leftnav">
          {["工作区", "创作", "管理", "系统"].map((section) => (
            <div key={section}>
              <div className="nav-section">{section}</div>
              {NAV.filter((n) => n.section === section).map((n) => (
                <div
                  key={n.key}
                  className={`nav-item ${view === n.key ? "active" : ""}`}
                  onClick={() => setView(n.key)}
                >
                  <span className="icon">{n.icon}</span>
                  {n.label}
                </div>
              ))}
            </div>
          ))}
        </nav>

        {/* 主区 */}
        <main className="app-main">{main}</main>
      </div>

      {/* 底部任务栏 */}
      <footer className="bottombar">
        <span>并发 0/{settings?.maxConcurrentJobs ?? 2}</span>
        <span className="sep">|</span>
        <span>队列 0</span>
        <span className="sep">|</span>
        <div className="progress-mini"><div style={{ width: "0%" }} /></div>
        <span className="sep">|</span>
        <span>{offline ? "网络：Local-only（已禁止公网出站）" : "网络：仅允许已配置的 Provider"}</span>
        <span style={{ flex: 1 }} />
        <span>OneTV v0.1.0 · Local-first · No telemetry</span>
      </footer>

      <Toaster />
    </div>
  );
}

function PlaceholderView({ view, hasProject, text }: { view: string; hasProject: boolean; text: string }) {
  const labels: Record<string, string> = {
    agent: "Agent 对话",
    script: "剧本",
    storyboard: "分镜",
    canvas: "画布",
    assets: "资产库",
    skills: "Skill Hub",
    jobs: "任务队列",
  };
  return (
    <div className="empty-state" style={{ height: "100%" }}>
      <div className="big">{hasProject ? "🚧" : "🎬"}</div>
      <h2>{labels[view] ?? "模块建设中"}</h2>
      <p>{hasProject ? text : "请先在「工作区」创建或打开一个项目"}</p>
      {!hasProject && (
        <button className="btn primary" onClick={() => useApp.getState().setView("home")}>
          前往工作区
        </button>
      )}
    </div>
  );
}
