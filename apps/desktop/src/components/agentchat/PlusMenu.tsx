/**
 * 大＋功能菜单（Codex 式）：任意格式上传 / 链接 / @画布节点 / 技能 / 工具指令模板。
 * 自 views/AgentChatView.tsx 原样迁出；面板切换、条目添加、数据源加载由主视图回调
 * （外部点击/Esc 关闭监听与 ref 也在主视图的 useAgentPlusMenu 中）。
 */
import { useT } from "../../i18n";
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
  /** 添加条目；返回 false 表示超上限被拒（调用方据此决定是否清空输入/关闭面板） */
  onAddExtra: (it: PendingExtra) => boolean;
  onLoadCanvasNodes: () => void;
  onLoadSkills: () => void;
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
  onAddExtra,
  onLoadCanvasNodes,
  onLoadSkills,
  onSelectTool,
  onPickFile,
}: PlusMenuProps) {
  const t = useT();
  return (
    <div className="agent-plus-menu">
      {menu === "root" && (
        <>
          <div className="agent-plus-head">{t("通用上传与调用")}</div>
          <button className="agent-plus-item" onClick={() => { onSetMenu(null); void onPickFile(); }}>
            <span>📎</span>{t("上传文件…（任意格式）")}
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
    </div>
  );
}
