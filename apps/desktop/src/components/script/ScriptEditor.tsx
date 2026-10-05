/**
 * 剧本正文：剧名/Logline 卡 + 场景卡片列表（场景梗概 / 对白角色与台词 / 旁白 synopsis）+ 新增场景 + 页脚提示。
 * 自 views/ScriptView.tsx 原样迁出；编辑回调（纯前端 patch / 落盘操作）由 ScriptView 注入。
 */
import type { ScriptDocument } from "@onetv/shared-types";
import { useT } from "../../i18n";
import type { ScriptDocWithVersions } from "../../hooks/useScriptVersions";

interface ScriptEditorProps {
  doc: ScriptDocWithVersions | null;
  editing: boolean;
  onPatchDoc: (patch: Partial<ScriptDocument>) => void;
  onPatchScene: (si: number, patch: Partial<ScriptDocument["scenes"][number]>) => void;
  onPatchDialogue: (
    si: number,
    di: number,
    patch: Partial<ScriptDocument["scenes"][number]["dialogues"][number]>
  ) => void;
  onAddDialogue: (si: number) => void;
  onRemoveDialogue: (si: number, di: number) => void;
  onAddScene: () => void;
  onRemoveScene: (si: number) => void;
}

export function ScriptEditor({
  doc,
  editing,
  onPatchDoc,
  onPatchScene,
  onPatchDialogue,
  onAddDialogue,
  onRemoveDialogue,
  onAddScene,
  onRemoveScene,
}: ScriptEditorProps) {
  const t = useT();
  return (
    <div className="script-body">
      <div className="card script-head-card">
        {editing ? (
          <>
            <div className="field">
              <label>{t("剧名")}</label>
              <input type="text" value={doc?.title ?? ""} onChange={(e) => onPatchDoc({ title: e.target.value })} />
            </div>
            <div className="field" style={{ marginBottom: 0 }}>
              <label>{t("一句话简介（Logline）")}</label>
              <textarea
                value={doc?.logline ?? ""}
                rows={2}
                placeholder={t("一句话概括这一集的故事")}
                onChange={(e) => onPatchDoc({ logline: e.target.value })}
              />
            </div>
          </>
        ) : (
          <>
            <h2 className="script-title">{doc?.title || t("未命名剧本")}</h2>
            {doc?.logline && <p className="script-logline">{doc.logline}</p>}
          </>
        )}
      </div>

      {(doc?.scenes ?? []).map((scene, si) => (
        <div className="card scene-card" key={scene.id || si}>
          <div className="scene-head">
            {editing ? (
              <input
                type="text"
                className="scene-heading-input"
                value={scene.heading}
                onChange={(e) => onPatchScene(si, { heading: e.target.value })}
              />
            ) : (
              <h3 className="scene-heading">{scene.heading}</h3>
            )}
            <span className="tag">{t("{n} 句台词", { n: scene.dialogues.length })}</span>
            {editing && (
              <button className="btn sm danger" onClick={() => onRemoveScene(si)}>{t("🗑 删除场景")}</button>
            )}
          </div>

          {editing ? (
            <div className="field">
              <label>{t("场景梗概")}</label>
              <textarea
                value={scene.synopsis}
                rows={2}
                onChange={(e) => onPatchScene(si, { synopsis: e.target.value })}
              />
            </div>
          ) : (
            scene.synopsis && <p className="scene-synopsis">{scene.synopsis}</p>
          )}

          {scene.dialogues.length > 0 && (
            <div className="dialogue-list">
              {scene.dialogues.map((dl, di) => (
                <div className="dialogue-row" key={di}>
                  {editing ? (
                    <>
                      <input
                        type="text"
                        className="dlg-char-input"
                        value={dl.characterName}
                        placeholder={t("角色名")}
                        onChange={(e) => onPatchDialogue(si, di, { characterName: e.target.value })}
                      />
                      <input
                        type="text"
                        className="dlg-paren-input"
                        value={dl.parenthetical ?? ""}
                        placeholder={t("语气提示（可选）")}
                        onChange={(e) => onPatchDialogue(si, di, { parenthetical: e.target.value || undefined })}
                      />
                      <textarea
                        className="dlg-line-input"
                        value={dl.line}
                        rows={2}
                        placeholder={t("台词内容")}
                        onChange={(e) => onPatchDialogue(si, di, { line: e.target.value })}
                      />
                      <button className="btn sm danger" onClick={() => onRemoveDialogue(si, di)}>{t("删除")}</button>
                    </>
                  ) : (
                    <>
                      <span className="tag pink dlg-char">{dl.characterName}</span>
                      <div className="dlg-body">
                        {dl.parenthetical && <span className="dlg-paren">({dl.parenthetical})</span>}
                        <span className="dlg-line">{dl.line}</span>
                      </div>
                    </>
                  )}
                </div>
              ))}
            </div>
          )}

          {editing && (
            <button className="btn sm" onClick={() => onAddDialogue(si)}>{t("+ 添加台词")}</button>
          )}
        </div>
      ))}

      {editing && (
        <button className="btn scene-add" onClick={onAddScene}>{t("+ 新增场景")}</button>
      )}

      <div className="script-foot">
        <span>🔒</span>
        <span>{t("剧本保存在项目 episodes/ 内 · 编辑后记得「保存剧本」")}</span>
      </div>
    </div>
  );
}
