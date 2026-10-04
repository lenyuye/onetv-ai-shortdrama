/**
 * OneTV 应用外壳 —— 顶栏 / 左侧导航 / 主区 / 底部任务栏（规格 §2.1）。
 */
import { useEffect, useState } from "react";
import { useApp, type ViewKey } from "./store";
import * as api from "./api";
import { jobList, type JobDto } from "./api-providers";
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
import HermesView from "./views/HermesView";
import LoginView from "./views/LoginView";
import AgentChatView from "./views/AgentChatView";
import { Toaster } from "./components/Toaster";
import { ViewErrorBoundary } from "./components/ViewErrorBoundary";
import { initAgentChatBridge } from "./agentChatStore";

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
  { key: "hermes", icon: "🛰️", label: "Hermes 连接", section: "管理" },
  { key: "jobs", icon: "⏳", label: "任务", section: "管理" },
  { key: "settings", icon: "⚙️", label: "设置", section: "系统" },
];

const PLACEHOLDER_VIEWS: Record<string, string> = {};

export default function App() {
  const { view, setView, settings, loadSettings, ffmpeg, loadFfmpeg, project, loadProject, authed, setAuthed, appVersion, loadAppVersion } =
    useApp();
  // 顶栏/底栏实时任务计数（此前硬编码"任务 0"，批准执行后徽标不动）
  const [jobs, setJobs] = useState<JobDto[]>([]);

  const refreshJobs = () => {
    jobList(200)
      .then((list) => setJobs(list))
      .catch(() => {});
  };

  useEffect(() => {
    initAgentChatBridge(); // agent.message 全局桥：按 jobId 归档到项目对话（切视图不丢回复）
    loadSettings();
    loadFfmpeg();
    loadProject();
    loadAppVersion();
    api.authStatus().then((st) => setAuthed(!!st.loggedIn)).catch(() => setAuthed(false));
    refreshJobs();

    // 任务事件驱动 + 兜底轮询，保证徽标实时反映队列
    const events = ["job.created", "job.progress", "job.succeeded", "job.failed"];
    const unlistens: Promise<unknown>[] = events.map((e) => api.onAppEvent(e, refreshJobs));
    const timer = window.setInterval(refreshJobs, 5000);

    // 原生菜单入口（macOS 菜单栏 → 对应页面）
    unlistens.push(
      api.onAppEvent("menu:settings", () => useApp.getState().setView("settings")),
      api.onAppEvent("menu:new-project", () => useApp.getState().setView("home")),
      api.onAppEvent("menu:open-project", () => useApp.getState().setView("home")),
      api.onAppEvent("menu:export-pkg", () => useApp.getState().setView("projects")),
    );
    return () => {
      unlistens.forEach((u) => u.then((f) => (f as () => void)()).catch(() => {}));
      window.clearInterval(timer);
    };
  }, []);

  const activeJobs = jobs.filter((j) => !["SUCCEEDED", "FAILED", "CANCELED"].includes(j.state));
  const runningCount = jobs.filter((j) => j.state === "RUNNING").length;
  const avgProgress = activeJobs.length
    ? Math.round((activeJobs.reduce((s, j) => s + (j.progress ?? 0), 0) / activeJobs.length) * 100)
    : 0;

  // 全局右键菜单兜底拦截：阻止 WKWebView 弹出英文默认菜单（含 Reload）。
  // 输入类元素放行，保留系统的中文编辑菜单（拷贝/粘贴…）；
  // 各视图自定义右键菜单在自己的 onContextMenu 里 preventDefault，不受此层影响。
  useEffect(() => {
    const onCtx = (e: MouseEvent) => {
      const t = e.target as HTMLElement | null;
      // 输入类元素保留系统编辑菜单（系统菜单为中文：拷贝/粘贴…）
      if (t && t.closest('input, textarea, [contenteditable="true"]')) return;
      e.preventDefault();
    };
    document.addEventListener("contextmenu", onCtx);
    return () => document.removeEventListener("contextmenu", onCtx);
  }, []);

  // 主题/皮肤应用（v2.1 外观设置；依赖 authed：登录切换会重建 .skin-layer 节点，需重新应用）
  useEffect(() => {
    if (!settings) return;
    document.documentElement.dataset.theme = settings.theme === "light" ? "light" : "dark";
    // 有自定义皮肤时主界面表面转半透明，让皮肤透出（global.css「皮肤透出」段）
    document.body.classList.toggle("has-skin", !!settings.skin);
    const layer = document.querySelector<HTMLDivElement>(".skin-layer");
    if (layer) {
      if (settings.skin) {
        const img = `url(onetv-app://localhost/${encodeURIComponent(settings.skin)})`;
        // 浓度 = 主题色遮罩不透明度：0% 完全露出皮肤，100% 几乎纯主题色（文字始终锐利）
        const veil = Math.min(0.92, Math.max(0, 1 - (settings.skinOpacity ?? 0.18) * 2));
        const rgb = settings.theme === "light" ? "242, 244, 250" : "10, 13, 24";
        layer.style.backgroundImage = `linear-gradient(rgba(${rgb}, ${veil.toFixed(2)}), rgba(${rgb}, ${veil.toFixed(2)})), ${img}`;
        layer.style.backgroundSize = "cover";
        layer.style.backgroundPosition = "center";
      } else {
        layer.style.backgroundImage = "none";
      }
    }
  }, [settings?.theme, settings?.skin, settings?.skinOpacity, authed]);

  if (!authed) {
    return (
      <>
        <div className="skin-layer" />
        <LoginView onSuccess={() => setAuthed(true)} />
      </>
    );
  }

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
    case "hermes":
      main = <HermesView />;
      break;
    case "agent":
      main = <AgentChatView />;
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
      <div className="skin-layer" />
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
        <span className={`pill ${activeJobs.length ? "ok" : ""}`} title="进行中的任务数">任务 {activeJobs.length}</span>
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
        <main className="app-main">
          <ViewErrorBoundary>{main}</ViewErrorBoundary>
        </main>
      </div>

      {/* 底部任务栏 */}
      <footer className="bottombar">
        <span>并发 {runningCount}/{settings?.maxConcurrentJobs ?? 2}</span>
        <span className="sep">|</span>
        <span>队列 {activeJobs.length}</span>
        <span className="sep">|</span>
        <div className="progress-mini"><div style={{ width: `${avgProgress}%` }} /></div>
        <span className="sep">|</span>
        <span>{offline ? "网络：Local-only（已禁止公网出站）" : "网络：仅允许已配置的 Provider"}</span>
        <span style={{ flex: 1 }} />
        <span>OneTV v{appVersion ?? "…"} · Local-first · No telemetry</span>
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
