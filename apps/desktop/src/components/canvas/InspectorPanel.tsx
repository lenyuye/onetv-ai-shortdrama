/**
 * 右侧参数检查器 —— 选中节点后显示：常用字段表单（按 NODE_TYPE_DEFS[type].params
 * 动态生成 string/number/enum 输入）+ 原始 config JSON 文本域。
 *
 * 编辑约定：onFocus 时 onEditStart（记录撤销快照），onBlur 时 onEditEnd
 * （若有实际变化则入撤销栈并安排自动保存）。
 */
import { useEffect, useState } from "react";
import { NODE_TYPE_DEFS } from "@onetv/node-sdk";
import type { CanvasNode } from "@onetv/shared-types";
import { NODE_ICONS, type NodeParamDef } from "./canvas-model";

interface InspectorPanelProps {
  node: CanvasNode | null;
  onConfigChange: (patch: Record<string, unknown>) => void;
  onConfigReplace: (config: Record<string, unknown>) => void;
  onTitleChange: (title: string) => void;
  onEditStart: () => void;
  onEditEnd: () => void;
  onDelete: () => void;
}

function placeholderFor(key: string): string {
  if (key === "model") return "模型引用，如 openai/gpt-4o";
  if (key === "prompt" || key === "text") return "输入提示词 / 文本内容…";
  if (key === "expression") return "如 out.shots.length > 0";
  if (key === "voice") return "音色名称";
  if (key === "preset") return "预设名称";
  return "";
}

export default function InspectorPanel(props: InspectorPanelProps) {
  const { node, onConfigChange, onConfigReplace, onTitleChange, onEditStart, onEditEnd, onDelete } =
    props;
  const [draft, setDraft] = useState("");
  const [draftErr, setDraftErr] = useState<string | null>(null);

  // 选中节点变化（或 config 从外部变化，如应用 JSON / 表单编辑）时同步 JSON 草稿
  useEffect(() => {
    setDraft(JSON.stringify(node?.config ?? {}, null, 2));
    setDraftErr(null);
  }, [node]);

  if (!node) {
    return (
      <aside className="cv-inspector">
        <div className="cv-inspector-title">参数</div>
        <div className="hint">未选中节点。点击画布中的节点后，可在此编辑标题与参数。</div>
      </aside>
    );
  }

  const def = NODE_TYPE_DEFS[node.type];
  const paramEntries: [string, NodeParamDef][] = def
    ? (Object.entries(def.params ?? {}) as [string, NodeParamDef][])
    : [];

  const applyDraft = () => {
    try {
      const parsed = JSON.parse(draft) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        setDraftErr("JSON 必须是一个对象（{...}）");
        return;
      }
      onConfigReplace(parsed as Record<string, unknown>);
      setDraftErr(null);
    } catch (e) {
      setDraftErr(`JSON 解析失败：${String(e)}`);
    }
  };

  return (
    <aside className="cv-inspector">
      <div className="cv-inspector-title">参数</div>
      <div className="cv-inspector-head">
        <span className="icon">{NODE_ICONS[node.type] ?? "⬜"}</span>
        <span className="name">{def?.title ?? node.title}</span>
        <span className="tag">{node.type}</span>
      </div>
      <div className="cv-node-id">{node.id}</div>

      <div className="field">
        <label>节点标题</label>
        <input
          type="text"
          value={node.title}
          onFocus={onEditStart}
          onBlur={onEditEnd}
          onChange={(e) => onTitleChange(e.target.value)}
        />
      </div>

      {paramEntries.map(([key, p]) => {
        const raw = node.config?.[key];
        const rawStr = String(raw ?? "");
        const isNum = p.type === "number";
        const enumValues = p.type === "enum" && Array.isArray(p.values) ? p.values : [];
        const multiline = key === "prompt" || key === "text" || key === "note" || key === "expression" || key === "style";
        return (
          <div className="field" key={key}>
            <label>
              {key}
              {p.required ? " *" : ""}
              {p.type ? ` · ${p.type}` : ""}
            </label>
            {enumValues.length > 0 ? (
              <select
                value={rawStr}
                onFocus={onEditStart}
                onBlur={onEditEnd}
                onChange={(e) => onConfigChange({ [key]: e.target.value })}
              >
                {enumValues.map((v) => (
                  <option key={v} value={v}>
                    {v}
                  </option>
                ))}
                {raw !== undefined && !enumValues.includes(rawStr) && (
                  <option value={rawStr}>{rawStr}</option>
                )}
              </select>
            ) : multiline ? (
              <textarea
                rows={3}
                value={rawStr}
                placeholder={placeholderFor(key)}
                onFocus={onEditStart}
                onBlur={onEditEnd}
                onChange={(e) => onConfigChange({ [key]: e.target.value })}
              />
            ) : (
              <input
                type={isNum ? "number" : "text"}
                value={rawStr}
                min={p.min}
                max={p.max}
                placeholder={placeholderFor(key)}
                onFocus={onEditStart}
                onBlur={onEditEnd}
                onChange={(e) =>
                  onConfigChange({
                    [key]: isNum ? (e.target.value === "" ? "" : Number(e.target.value)) : e.target.value,
                  })
                }
              />
            )}
          </div>
        );
      })}

      <div className="field">
        <label>config JSON</label>
        <textarea
          className="cv-json-textarea"
          value={draft}
          spellCheck={false}
          onFocus={onEditStart}
          onBlur={onEditEnd}
          onChange={(e) => setDraft(e.target.value)}
        />
        {draftErr && <div className="cv-json-err">{draftErr}</div>}
        <button className="btn sm" onClick={applyDraft}>
          应用 JSON
        </button>
      </div>

      <div style={{ flex: 1 }} />
      <button className="btn danger sm" onClick={onDelete}>
        🗑 删除该节点
      </button>
      <div className="hint" style={{ marginTop: 6 }}>
        也可以选中节点后按 Delete 键删除
      </div>
    </aside>
  );
}
