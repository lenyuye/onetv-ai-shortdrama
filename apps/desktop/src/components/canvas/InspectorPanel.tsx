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
import { t, useT } from "../../i18n";
import { NODE_ICONS, type NodeParamDef } from "./canvas-model";
import { agentAttach, errMsg } from "../../api";
import { assetUrl } from "../../api-assets";
import { useApp } from "../../store";

/** 素材节点 config.files 元数据（v2.26.26） */
interface AssetFileMeta {
  id: string;
  name: string;
  path: string;
  kind: string;
}

interface InspectorPanelProps {
  node: CanvasNode | null;
  onConfigChange: (patch: Record<string, unknown>) => void;
  onConfigReplace: (config: Record<string, unknown>) => void;
  onTitleChange: (title: string) => void;
  onEditStart: () => void;
  onEditEnd: () => void;
  onDelete: () => void;
  /** review 节点暂停时批准并恢复批次（v2.14） */
  onBatchResume?: () => void;
}

function placeholderFor(key: string): string {
  if (key === "model") return t("模型引用，如 openai/gpt-4o");
  if (key === "prompt" || key === "text") return t("输入提示词 / 文本内容…");
  if (key === "expression") return t("如 out.shots.length > 0");
  if (key === "voice") return t("音色名称");
  if (key === "preset") return t("预设名称");
  return "";
}

export default function InspectorPanel(props: InspectorPanelProps) {
  const t = useT();
  const { node, onConfigChange, onConfigReplace, onTitleChange, onEditStart, onEditEnd, onDelete, onBatchResume } =
    props;
  const locked = node?.config?.locked === true;
  const disabled = node?.config?.disabled === true;
  const isReviewAwaiting = node?.type === "review" && node?.config?.status === "awaiting_review";
  const isAsset = node?.type === "asset";
  // v2.26.28 生成节点（图片/视频/片段合成/配音）也支持选中后直接上传参考
  const isGenNode = ["image", "video", "video-clip", "audio"].includes(node?.type ?? "");
  const nodeFiles: AssetFileMeta[] = (isAsset || isGenNode) && Array.isArray(node?.config?.files)
    ? ((node?.config?.files as unknown) as AssetFileMeta[])
    : [];
  const [uploading, setUploading] = useState(false);
  const [draft, setDraft] = useState("");
  const [draftErr, setDraftErr] = useState<string | null>(null);

  /** 上传本地素材/参考（v2.26.26/28）：agentAttach 落盘入资产库，id/path 记入节点 config */
  const uploadNodeFile = async () => {
    if (!node) return;
    setUploading(true);
    try {
      const att = await agentAttach();
      onEditStart();
      onConfigChange({
        files: [...nodeFiles, { id: att.assetId, name: att.name, path: att.path, kind: att.kind }],
        referenceAssetIds: [
          ...((node.config?.referenceAssetIds as string[]) ?? []),
          att.assetId,
        ],
        status: "ready",
      });
      onEditEnd();
      useApp.getState().toast(t("已上传 {name}，将作为该节点的参考项", { name: att.name }), "ok");
    } catch (e) {
      const msg = errMsg(e);
      if (!msg.includes("已取消") && !msg.includes("取消")) {
        useApp.getState().toast(t("上传失败：{msg}", { msg }), "err");
      }
    } finally {
      setUploading(false);
    }
  };

  const removeNodeFile = (id: string) => {
    if (!node) return;
    onEditStart();
    onConfigChange({
      files: nodeFiles.filter((f) => f.id !== id),
      referenceAssetIds: ((node.config?.referenceAssetIds as string[]) ?? []).filter((x) => x !== id),
    });
    onEditEnd();
  };

  // 选中节点变化（或 config 从外部变化，如应用 JSON / 表单编辑）时同步 JSON 草稿
  useEffect(() => {
    setDraft(JSON.stringify(node?.config ?? {}, null, 2));
    setDraftErr(null);
  }, [node]);

  if (!node) {
    return (
      <aside className="cv-inspector">
        <div className="cv-inspector-title">{t("参数")}</div>
        <div className="hint">{t("未选中节点。点击画布中的节点后，可在此编辑标题与参数。")}</div>
      </aside>
    );
  }

  const def = NODE_TYPE_DEFS[node.type];
  const paramEntries: [string, NodeParamDef][] = def
    ? (Object.entries(def.params ?? {}) as [string, NodeParamDef][])
        // v2.26.28 文本节点：text 字段由下方专用文案编辑区承担，避免重复表单
        .filter(([k]) => !(node?.type === "text" && k === "text"))
    : [];

  const applyDraft = () => {
    try {
      const parsed = JSON.parse(draft) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        setDraftErr(t("JSON 必须是一个对象（{...}）"));
        return;
      }
      onConfigReplace(parsed as Record<string, unknown>);
      setDraftErr(null);
    } catch (e) {
      setDraftErr(t("JSON 解析失败：{error}", { error: String(e) }));
    }
  };

  return (
    <aside className="cv-inspector">
      <div className="cv-inspector-title">{t("参数")}</div>
      <div className="cv-inspector-head">
        <span className="icon">{NODE_ICONS[node.type] ?? "⬜"}</span>
        <span className="name">{def?.title ?? node.title}</span>
        <span className="tag">{node.type}</span>
      </div>
      <div className="cv-node-id">{node.id}</div>

      {/* v2.14：禁用/锁定开关（批量运行跳过禁用节点；锁定防误删误改） */}
      <div style={{ display: "flex", gap: 16, alignItems: "center", margin: "8px 0 4px", flexWrap: "wrap" }}>
        <label style={{ display: "flex", gap: 6, alignItems: "center", cursor: "pointer", fontSize: 12 }}>
          <input type="checkbox" checked={disabled} onChange={(e) => { onEditStart(); onConfigChange({ disabled: e.target.checked }); onEditEnd(); }} />
          {t("⏸ 禁用（运行时跳过）")}
        </label>
        <label style={{ display: "flex", gap: 6, alignItems: "center", cursor: "pointer", fontSize: 12 }}>
          <input type="checkbox" checked={locked} onChange={(e) => { onEditStart(); onConfigChange({ locked: e.target.checked }); onEditEnd(); }} />
          {t("🔒 锁定（防删除/修改）")}
        </label>
      </div>

      {/* v2.26.26 素材节点：本地上传图片/视频/音频/文本，作为参考源连线给生成节点 */}
      {isAsset && (
        <div className="field">
          <label>{t("素材文件（本地上传，存入项目资产库）")}</label>
          <button className="btn sm primary" disabled={uploading || locked} style={{ width: "100%" }} onClick={() => void uploadNodeFile()}>
            {uploading ? t("上传中…") : t("📤 上传素材（图片/视频/音频/文本）")}
          </button>
          {nodeFiles.length === 0 ? (
            <div className="hint" style={{ marginTop: 6 }}>
              {t("上传后把本节点的输出连线到 生图/生视频/片段合成 等节点，即可作为参考图/参考视频/文字约束。")}
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 8 }}>
              {nodeFiles.map((f) => (
                <div key={f.id} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  {f.kind === "images" || /\.(png|jpe?g|webp|gif)$/i.test(f.path) ? (
                    <img src={assetUrl(f.path)} alt={f.name} style={{ width: 40, height: 30, objectFit: "cover", borderRadius: 5, border: "1px solid var(--border)", flexShrink: 0 }} />
                  ) : (
                    <span style={{ fontSize: 18, flexShrink: 0, width: 40, textAlign: "center" }}>
                      {f.kind === "videos" ? "🎬" : f.kind === "audio" ? "🎵" : "📄"}
                    </span>
                  )}
                  <span style={{ fontSize: 11.5, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }} title={f.path}>{f.name}</span>
                  <button className="btn sm danger" title={t("移除该素材")} onClick={() => removeNodeFile(f.id)}>✕</button>
                </div>
              ))}
              <div className="hint">{t("把本节点输出连线到生成节点，即自动作为其参考项。")}</div>
            </div>
          )}
        </div>
      )}

      {/* v2.26.28 生成节点（图片/视频/片段合成/配音）：选中后直接上传参考图/视频 */}
      {isGenNode && (
        <div className="field">
          <label>{t("参考素材（生成时作为参考项）")}</label>
          <button className="btn sm primary" disabled={uploading || locked} style={{ width: "100%" }} onClick={() => void uploadNodeFile()}>
            {uploading ? t("上传中…") : t("📤 上传参考（图片/视频/音频）")}
          </button>
          {nodeFiles.length === 0 ? (
            <div className="hint" style={{ marginTop: 6 }}>
              {t("上传后生成时自动携带；也可以连线素材/文本节点，或用节点面板的「＋ 参考」「⚓ 节点参考」。")}
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 6, marginTop: 8 }}>
              {nodeFiles.map((f) => (
                <div key={f.id} style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  {f.kind === "images" || /\.(png|jpe?g|webp|gif)$/i.test(f.path) ? (
                    <img src={assetUrl(f.path)} alt={f.name} style={{ width: 40, height: 30, objectFit: "cover", borderRadius: 5, border: "1px solid var(--border)", flexShrink: 0 }} />
                  ) : (
                    <span style={{ fontSize: 18, flexShrink: 0, width: 40, textAlign: "center" }}>
                      {f.kind === "videos" ? "🎬" : f.kind === "audio" ? "🎵" : "📄"}
                    </span>
                  )}
                  <span style={{ fontSize: 11.5, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", flex: 1 }} title={f.path}>{f.name}</span>
                  <button className="btn sm danger" title={t("移除该参考")} onClick={() => removeNodeFile(f.id)}>✕</button>
                </div>
              ))}
              <div className="hint">{t("参考在节点面板生成与批量运行时都会自动携带。")}</div>
            </div>
          )}
        </div>
      )}

      {isReviewAwaiting && (
        <div style={{ background: "rgba(255,181,71,.12)", border: "1px solid rgba(255,181,71,.4)", borderRadius: 8, padding: 10, margin: "8px 0" }}>
          <div style={{ fontSize: 12, marginBottom: 8 }}>{t("⏸ 该审核节点正在等待批准——批准后批次将从中断处继续。")}</div>
          <button
            className="btn primary sm"
            onClick={() => {
              onEditStart();
              onConfigChange({ status: "approved", batchStatus: "done", batchNote: "人工批准" });
              onEditEnd();
              onBatchResume?.();
            }}
          >
            {t("✓ 批准并继续运行")}
          </button>
        </div>
      )}

      <div className="field">
        <label>{locked ? t("节点标题（已锁定）") : t("节点标题")}</label>
        <input
          type="text"
          value={node.title}
          disabled={locked}
          onFocus={onEditStart}
          onBlur={onEditEnd}
          onChange={(e) => onTitleChange(e.target.value)}
        />
      </div>

      {/* v2.26.28 文本节点专用文案编辑区：选中即可直接输入/编辑文案，作为下游节点的文字约束 */}
      {node.type === "text" && (
        <div className="field">
          <label>{t("📝 文案内容（连线给生成节点即作为文字约束）")}</label>
          <textarea
            rows={7}
            value={String(node.config?.text ?? "")}
            disabled={locked}
            placeholder={t("输入文案内容，例如：雨夜霓虹街头，女主撑伞回眸——收进节点后连线给 生图/生视频 即生效")}
            onFocus={onEditStart}
            onBlur={onEditEnd}
            onChange={(e) => onConfigChange({ text: e.target.value })}
          />
          <div className="hint">{t("编辑实时保存；也可以双击节点在生成面板里编辑或让 AI 续写。")}</div>
        </div>
      )}

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
                disabled={locked}
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
                disabled={locked}
                placeholder={placeholderFor(key)}
                onFocus={onEditStart}
                onBlur={onEditEnd}
                onChange={(e) => onConfigChange({ [key]: e.target.value })}
              />
            ) : (
              <input
                type={isNum ? "number" : "text"}
                value={rawStr}
                disabled={locked}
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
          {t("应用 JSON")}
        </button>
      </div>

      <div style={{ flex: 1 }} />
      <button className="btn danger sm" disabled={locked} title={locked ? t("节点已锁定") : undefined} onClick={onDelete}>
        {t("🗑 删除该节点")}
      </button>
      <div className="hint" style={{ marginTop: 6 }}>
        {t("也可以选中节点后按 Delete 键删除")}
      </div>
    </aside>
  );
}
