/**
 * 大＋功能菜单（Codex 式）：任意格式上传 / 链接 / @画布节点 / 技能 / 工具指令模板。
 * 自 views/AgentChatView.tsx 原样迁出；面板切换、条目添加、数据源加载由主视图回调
 * （外部点击/Esc 关闭监听与 ref 也在主视图的 useAgentPlusMenu 中）。
 */
import { useEffect, useState } from "react";
import { useT } from "../../i18n";
import { type PluginListItem, type PluginManifestInfo } from "../../api-extras";
import { type PendingExtra, type PlusMenuPane, TOOL_PRESETS } from "./constants";

/** 大＋菜单的画布节点条目 */
export interface CanvasNodeOption {
  id: string;
  title: string;
  type: string;
  summary: string;
}

interface PlusMenuProps {
  menu: Exclude<PlusMenuPane, null>;
  onSetMenu: (pane: PlusMenuPane) => void;
  linkInput: string;
  onLinkInputChange: (v: string) => void;
  canvasNodes: CanvasNodeOption[];
  skillNames: string[];
  /** 插件清单（plugin_list 行，坏清单 valid=false 仅供展示） */
  plugins: PluginListItem[];
  /** 当前展开（已加载完整清单）的插件；null=显示插件列表 */
  activePlugin: PluginManifestInfo | null;
  /** 添加条目；返回 false 表示超上限被拒（调用方据此决定是否清空输入/关闭面板） */
  onAddExtra: (it: PendingExtra) => boolean;
  onLoadCanvasNodes: () => void;
  onLoadSkills: () => void;
  onLoadPlugins: () => void;
  /** 点击一个插件：主视图加载完整清单进入提示词子列表 */
  onSelectPlugin: (p: PluginListItem) => void;
  /** 提示词子列表返回插件列表 */
  onPluginBack: () => void;
  /** 渲染插件提示词：主视图负责调用后端并把结果插入输入框（与「调用工具」模板同路径） */
  onRenderPrompt: (pluginId: string, promptId: string, input: string) => void;
  /** 打开应用数据目录 plugins/ 文件夹 */
  onOpenPluginsDir: () => void;
  /** 选择工具模板：主视图负责拼接进输入框（原 setInput 逻辑） */
  onSelectTool: (tpl: string) => void;
  /** 「上传任意格式文件」：走主视图的文件选择导入链路（原 addAttachment） */
  onPickFile: () => void;
}

export function PlusMenu({
  menu,
  onSetMenu,
  linkInput,
  onLinkInputChange,
  canvasNodes,
  skillNames,
  plugins,
  activePlugin,
  onAddExtra,
  onLoadCanvasNodes,
  onLoadSkills,
  onLoadPlugins,
  onSelectPlugin,
  onPluginBack,
  onRenderPrompt,
  onOpenPluginsDir,
  onSelectTool,
  onPickFile,
}: PlusMenuProps) {
  const t = useT();
  /** 插件面板局部态：需要 {{input}} 的提示词 → 先内联输入再渲染 */
  const [inputPrompt, setInputPrompt] = useState<{ pluginId: string; promptId: string } | null>(null);
  const [promptInput, setPromptInput] = useState("");

  // 面板切换时重置插件面板的局部输入态
  useEffect(() => {
    setInputPrompt(null);
    setPromptInput("");
  }, [menu]);

  /** 确认 {{input}} 输入：交给主视图渲染并插入 */
  const confirmPromptInput = () => {
    if (!inputPrompt) return;
    onRenderPrompt(inputPrompt.pluginId, inputPrompt.promptId, promptInput.trim());
    setInputPrompt(null);
    setPromptInput("");
  };

  const displayPluginName = (p: PluginListItem) =>
    p.name || p.id || p.dir.split(/[\\/]/).filter(Boolean).pop() || p.dir;
  return (
    <div className="agent-plus-menu">
      {menu === "root" && (
        <>
          <div className="agent-plus-head">{t("通用上传与调用")}</div>
          <button className="agent-plus-item" onClick={() => { onSetMenu(null); void onPickFile(); }}>
            <span>📁</span>{t("上传文件…（任意格式）")}
          </button>
          <button className="agent-plus-item" onClick={() => onSetMenu("link")}>
            <span>🔗</span>{t("添加链接…")}
          </button>
          <button className="agent-plus-item" onClick={() => { onLoadCanvasNodes(); onSetMenu("node"); }}>
            <span>⚓</span>{t("@绑定画布节点…")}
          </button>
          <button className="agent-plus-item" onClick={() => { onLoadSkills(); onSetMenu("skill"); }}>
            <span>🧩</span>{t("调用技能…")}
          </button>
          <button className="agent-plus-item" onClick={() => onSetMenu("tool")}>
            <span>🛠️</span>{t("调用工具…")}
          </button>
          <button className="agent-plus-item" onClick={() => { onLoadPlugins(); onSetMenu("plugin"); }}>
            <span>📦</span>{t("插件（提示词包）…")}
          </button>
          <div className="agent-plus-sep" />
        </>
      )}
      {menu === "link" && (
        <>
          <div className="agent-plus-head">{t("🔗 添加链接")}</div>
          <input
            className="agent-plus-input"
            autoFocus
            placeholder={t("粘贴 https://… 链接后回车")}
            value={linkInput}
            onChange={(e) => onLinkInputChange(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && linkInput.trim()) {
                if (onAddExtra({ kind: "link", url: linkInput.trim() })) onLinkInputChange("");
                onSetMenu("root");
              }
              if (e.key === "Escape") onSetMenu("root");
            }}
          />
          <div className="agent-plus-actions">
            <button className="btn sm" onClick={() => onSetMenu("root")}>{t("返回")}</button>
            <button
              className="btn sm primary"
              disabled={!linkInput.trim()}
              onClick={() => {
                if (onAddExtra({ kind: "link", url: linkInput.trim() })) onLinkInputChange("");
                onSetMenu("root");
              }}
            >
              {t("添加")}
            </button>
          </div>
        </>
      )}
      {menu === "node" && (
        <>
          <div className="agent-plus-head">{t("⚓ @绑定画布节点")}</div>
          <div className="agent-plus-list">
            {canvasNodes.length === 0 ? (
              <div className="agent-plus-empty">{t("画布中还没有节点——去「画布」页新建后即可绑定")}</div>
            ) : (
              canvasNodes.map((n) => (
                <button
                  key={n.id}
                  className="agent-plus-item"
                  title={n.summary || n.id}
                  onClick={() => {
                    if (onAddExtra({ kind: "node", id: n.id, title: n.title, nodeType: n.type, summary: n.summary }))
                      onSetMenu("root");
                  }}
                >
                  <span>⚓</span>@{n.title || n.id}
                  <em>{n.type}</em>
                </button>
              ))
            )}
          </div>
          <div className="agent-plus-actions">
            <button className="btn sm" onClick={() => onSetMenu("root")}>{t("返回")}</button>
          </div>
        </>
      )}
      {menu === "skill" && (
        <>
          <div className="agent-plus-head">{t("🧩 调用技能")}</div>
          <div className="agent-plus-list">
            {skillNames.length === 0 ? (
              <div className="agent-plus-empty">{t("暂无已安装技能——去「Skills」页安装")}</div>
            ) : (
              skillNames.map((n) => (
                <button
                  key={n}
                  className="agent-plus-item"
                  onClick={() => {
                    if (onAddExtra({ kind: "skill", name: n })) onSetMenu("root");
                  }}
                >
                  <span>🧩</span>{n}
                </button>
              ))
            )}
          </div>
          <div className="agent-plus-actions">
            <button className="btn sm" onClick={() => onSetMenu("root")}>{t("返回")}</button>
          </div>
        </>
      )}
      {menu === "tool" && (
        <>
          <div className="agent-plus-head">{t("🛠️ 调用工具（选择后插入指令模板）")}</div>
          <div className="agent-plus-list">
            {TOOL_PRESETS.map((tp) => (
              <button
                key={tp.name}
                className="agent-plus-item"
                onClick={() => {
                  onSelectTool(tp.tpl);
                  onSetMenu(null);
                }}
              >
                <span>🛠️</span>{t(tp.name)}
              </button>
            ))}
          </div>
          <div className="agent-plus-actions">
            <button className="btn sm" onClick={() => onSetMenu("root")}>{t("返回")}</button>
          </div>
        </>
      )}
      {menu === "plugin" && (
        <>
          <div className="agent-plus-head">{t("📦 插件（提示词包）")}</div>
          {!activePlugin ? (
            <div className="agent-plus-list">
              {plugins.length === 0 ? (
                <div className="agent-plus-empty">
                  {t("插件目录为空，把含 plugin.json 的文件夹放入应用数据目录 plugins/ 下")}
                  <div style={{ marginTop: 8 }}>
                    <button className="btn sm" onClick={() => { onOpenPluginsDir(); onSetMenu(null); }}>
                      {t("打开插件目录")}
                    </button>
                  </div>
                </div>
              ) : (
                plugins.map((p) => (
                  <button
                    key={p.dir}
                    className="agent-plus-item"
                    disabled={!p.valid}
                    title={p.valid ? p.description || p.id : p.error}
                    onClick={() => onSelectPlugin(p)}
                  >
                    <span>📦</span>{displayPluginName(p)}
                    <em>{p.valid ? t("v{version} · {n} 个提示词", { version: p.version, n: p.promptsCount }) : t("清单校验失败")}</em>
                  </button>
                ))
              )}
            </div>
          ) : (
            <div className="agent-plus-list">
              {activePlugin.prompts.map((pr) => (
                <button
                  key={pr.id}
                  className="agent-plus-item"
                  title={pr.description || pr.template}
                  onClick={() => {
                    if (pr.template.includes("{{input}}")) {
                      // 模板需要输入占位符：先内联输入再渲染
                      setInputPrompt({ pluginId: activePlugin.id, promptId: pr.id });
                      setPromptInput("");
                    } else {
                      onRenderPrompt(activePlugin.id, pr.id, "");
                    }
                  }}
                >
                  <span>🧩</span>{pr.name}
                </button>
              ))}
              {inputPrompt && (
                <>
                  <input
                    className="agent-plus-input"
                    autoFocus
                    placeholder={t("输入内容（将替换模板中的输入占位符）")}
                    value={promptInput}
                    onChange={(e) => setPromptInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") confirmPromptInput();
                      if (e.key === "Escape") setInputPrompt(null);
                    }}
                  />
                  <div className="agent-plus-actions">
                    <button className="btn sm" onClick={() => setInputPrompt(null)}>{t("取消")}</button>
                    <button className="btn sm primary" onClick={confirmPromptInput}>{t("插入")}</button>
                  </div>
                </>
              )}
            </div>
          )}
          <div className="agent-plus-actions">
            <button
              className="btn sm"
              onClick={() => {
                if (inputPrompt) setInputPrompt(null);
                else if (activePlugin) onPluginBack();
                else onSetMenu("root");
              }}
            >
              {t("返回")}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
