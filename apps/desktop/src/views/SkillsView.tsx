/**
 * Skill Hub 视图 —— Skill 卡片网格 / 安装本地 Skill / 卸载 / 安全说明（规格 §10）。
 *
 * - Skill 清单来自 Rust 侧 skill_list（内置 + 用户安装）；
 * - 每卡展示 name / version / trustLevel（skill-sdk 的 SKILL_TRUST_LABELS）/
 *   description / permissions（network + filesystem tag）；
 * - 「安装本地 Skill…」：弹文件夹选择（Rust 侧校验 manifest），成功刷新 + toast，
 *   失败展示校验错误；「卸载」confirm 后调 skill_uninstall；
 * - 底部固定权限沙箱安全说明。
 *
 * 复用 global.css 设计系统，布局细节用本组件内 scoped <style> 补充（无法修改 global.css）。
 */
import { useCallback, useEffect, useState } from "react";
import { SKILL_TRUST_LABELS } from "@onetv/skill-sdk";
import { skill_list, skill_install, skill_uninstall, type SkillInfo } from "../api-extras";
import { useApp } from "../store";

/* ---------------- 常量 ---------------- */

/** 信任级别 → tag 颜色（L0 最宽松直接允许，L3 最危险默认禁止） */
const TRUST_CLS: Record<number, string> = { 0: "green", 1: "blue", 2: "amber", 3: "red" };

/** 安装来源 → 展示名（未识别的来源原样展示） */
const SOURCE_LABELS: Record<string, string> = {
  builtin: "内置",
  user: "本地安装",
  local: "本地安装",
};

/* ---------------- Skill 卡片 ---------------- */

function SkillCard({
  s,
  uninstalling,
  onUninstall,
}: {
  s: SkillInfo;
  uninstalling: boolean;
  onUninstall: () => void;
}) {
  const trust = typeof s.trustLevel === "number" ? s.trustLevel : undefined;
  const trustLabel = trust != null ? (SKILL_TRUST_LABELS[trust] ?? `L${trust}`) : "未声明信任级别";
  const trustCls = trust != null ? (TRUST_CLS[trust] ?? "") : "";
  const srcLabel = SOURCE_LABELS[s.source] ?? s.source;

  return (
    <div className="card skill-card" title={`id: ${s.id}`}>
      <div className="skill-head">
        <span className="skill-name">{s.name}</span>
        <span className="tag mono">v{s.version}</span>
        <span className="tag">{srcLabel}</span>
      </div>
      <div className="skill-trust">
        <span className={`tag ${trustCls}`} title="信任级别：L0 仅提示/Schema → L3 Shell/任意文件（默认禁止）">
          🛡️ {trustLabel}
        </span>
      </div>
      <div className="skill-desc">{s.description || "（无描述）"}</div>
      <div className="skill-perms">
        {s.permissions.network.map((n) => (
          <span key={`net-${n}`} className="tag blue" title="声明的 network 权限">
            🌐 network · {n}
          </span>
        ))}
        {s.permissions.filesystem.map((f) => (
          <span key={`fs-${f}`} className="tag" title="声明的 filesystem 权限">
            📁 filesystem · {f}
          </span>
        ))}
        {s.permissions.network.length === 0 && s.permissions.filesystem.length === 0 && (
          <span className="hint">未声明权限</span>
        )}
      </div>
      <div className="skill-actions">
        <span className="skill-id">{s.id}</span>
        <span style={{ flex: 1 }} />
        <button className="btn sm danger" disabled={uninstalling} onClick={onUninstall}>
          {uninstalling ? "卸载中…" : "卸载"}
        </button>
      </div>
    </div>
  );
}

/* ---------------- 主视图 ---------------- */

export default function SkillsView() {
  const { toast } = useApp();
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [installing, setInstalling] = useState(false);
  const [installError, setInstallError] = useState<string | null>(null);
  const [uninstallingId, setUninstallingId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const list = await skill_list();
      setSkills(list);
    } catch (e) {
      console.error("skill_list", e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  /* 安装本地 Skill：Rust 侧弹文件夹选择并校验 manifest */
  const doInstall = async () => {
    setInstalling(true);
    setInstallError(null);
    try {
      const r = await skill_install();
      if (r.ok) {
        await refresh();
        toast(
          r.skill ? `已安装 Skill：${r.skill.name} v${r.skill.version}` : r.message || "Skill 已安装",
          "ok",
        );
      } else {
        // manifest 校验失败：错误列表在 message 中（逐行展示）
        setInstallError(r.message || "manifest 校验未通过");
        toast(`安装失败：${r.message ?? "manifest 校验未通过"}`, "err");
      }
    } catch (e) {
      setInstallError(String(e));
      toast(`安装失败：${String(e)}`, "err");
    } finally {
      setInstalling(false);
    }
  };

  const doUninstall = async (s: SkillInfo) => {
    if (!window.confirm(`卸载 Skill「${s.name}」（${s.id}）？\n其声明的工作流将不可再用，此操作不可恢复。`)) return;
    setUninstallingId(s.id);
    try {
      await skill_uninstall(s.id);
      await refresh();
      toast(`已卸载：${s.name}`, "ok");
    } catch (e) {
      toast(`卸载失败：${String(e)}`, "err");
    } finally {
      setUninstallingId(null);
    }
  };

  return (
    <div className="page">
      <style>{SKILLS_CSS}</style>

      <div className="page-header">
        <div>
          <h1>🧩 Skill Hub</h1>
          <div className="desc">
            共 {skills.length} 个 Skill · Skill 只能声明能力与工作流 · 权限沙箱强制生效
          </div>
        </div>
        <button className="btn primary" disabled={installing} onClick={() => void doInstall()}>
          {installing ? "安装中…" : "📥 安装本地 Skill…"}
        </button>
      </div>

      {/* 安装失败（manifest 校验错误）内联展示 */}
      {installError && (
        <div className="skill-install-err">
          <strong>❌ 上次安装失败（manifest 校验）：</strong>
          <pre>{installError}</pre>
        </div>
      )}

      {loading ? (
        <div className="page hint">加载中…</div>
      ) : skills.length === 0 ? (
        <div className="empty-state" style={{ padding: "80px 20px" }}>
          <div className="big">🧩</div>
          <h2>还没有已安装的 Skill</h2>
          <p>点击右上角「安装本地 Skill…」，选择包含 skill manifest 的文件夹</p>
        </div>
      ) : (
        <div className="skills-grid">
          {skills.map((s) => (
            <SkillCard
              key={s.id}
              s={s}
              uninstalling={uninstallingId === s.id}
              onUninstall={() => void doUninstall(s)}
            />
          ))}
        </div>
      )}

      {/* 底部安全说明 */}
      <div className="card skills-security">
        <h3>🔐 安全说明</h3>
        <div className="hint">
          Skill 声明权限沙箱：filesystem 仅限 project、network 仅限 provider/none；L3 Shell 权限默认禁止
        </div>
      </div>
    </div>
  );
}

/* ---------------- 视图局部样式（补充 global.css，深色一致） ---------------- */

const SKILLS_CSS = `
.skills-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 12px; margin-bottom: 14px; }
.skill-card { display: flex; flex-direction: column; gap: 8px; }
.skill-card:hover { border-color: var(--blue); box-shadow: var(--glow-blue); }
.skill-head { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; min-width: 0; }
.skill-name { font-weight: 600; font-size: 13px; color: var(--text); }
.tag.mono { font-family: var(--mono); font-size: 10.5px; }
.skill-desc { font-size: 12px; color: var(--text-dim); min-height: 18px; }
.skill-perms { display: flex; flex-wrap: wrap; gap: 6px; }
.skill-actions { display: flex; align-items: center; gap: 6px; margin-top: auto; padding-top: 4px; }
.skill-id { font-family: var(--mono); font-size: 10.5px; color: var(--muted); }
.skill-install-err {
  border: 1px solid rgba(255, 84, 112, 0.4); background: rgba(255, 84, 112, 0.08);
  color: var(--red); border-radius: var(--radius-sm); padding: 9px 12px;
  font-size: 12px; margin-bottom: 12px;
}
.skill-install-err pre {
  margin: 4px 0 0; font-family: var(--mono); font-size: 11.5px; color: var(--red);
  white-space: pre-wrap; word-break: break-all; user-select: text;
}
.skills-security { margin-bottom: 14px; }
`;
