/**
 * Story Bible 编辑器（v2.8.0）—— 剧集设定与世界观的结构化编辑：
 * 故事信息 + 角色（可绑参考资产）+ 场景 + 道具 + 连续性规则。
 * 支持「AI 生成」：一句话需求 → LLM 产出完整圣经 → 回填表单可改后保存。
 * 保存后供剧本/分镜/角色绑定链路读取（bible/story.json）。
 */
import { useEffect, useState } from "react";
import {
  bibleGet,
  bibleGenerate,
  bibleSave,
  normalizeBible,
  type BibleDoc,
  type BibleCharacter,
  type BibleNamedItem,
} from "../api-extras";
import { errMsg } from "../api-story";
import { useT } from "../i18n";

const CSS = `
.bible-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
.bible-grid .field { margin: 0; }
.bible-section { border: 1px solid var(--border); border-radius: 10px; padding: 12px; margin-top: 12px; }
.bible-section > h4 { margin: 0 0 8px; font-size: 12.5px; color: var(--muted); }
.bible-row { display: grid; grid-template-columns: 130px 1fr 34px; gap: 6px; margin-bottom: 6px; }
.bible-row input { width: 100%; }
.bible-continuity-row { display: grid; grid-template-columns: 1fr 34px; gap: 6px; margin-bottom: 6px; }
`;

export default function BibleEditor({ onClose }: { onClose: () => void }) {
  const [doc, setDoc] = useState<BibleDoc | null>(null);
  const [busy, setBusy] = useState(false);
  const [genBusy, setGenBusy] = useState(false);
  const [brief, setBrief] = useState("");
  const [err, setErr] = useState("");
  const t = useT();

  useEffect(() => {
    bibleGet()
      .then((raw) => setDoc(normalizeBible(raw)))
      .catch((e) => setErr(errMsg(e)));
  }, []);

  if (!doc) {
    return (
      <div className="modal-overlay" onClick={onClose}>
        <div className="modal" style={{ width: "min(760px, 94vw)" }} onClick={(e) => e.stopPropagation()}>
          <div className="modal-head"><span>📖 Story Bible</span>
            <button className="btn sm ghost" onClick={onClose}>✕</button></div>
          <div className="modal-body hint">{err || t("加载中…")}</div>
        </div>
      </div>
    );
  }

  const patch = (patchObj: Partial<BibleDoc>) => setDoc({ ...doc, ...patchObj });
  const patchStory = (patchObj: Partial<BibleDoc["story"]>) => setDoc({ ...doc, story: { ...doc.story, ...patchObj } });

  const save = async () => {
    setBusy(true);
    setErr("");
    try {
      await bibleSave(doc);
      onClose();
    } catch (e) {
      setErr(errMsg(e));
    } finally {
      setBusy(false);
    }
  };

  const generate = async () => {
    setGenBusy(true);
    setErr("");
    try {
      const raw = await bibleGenerate(brief.trim());
      // 保留用户已设置的画幅/时长/平台（AI 不产出这些）
      const next = normalizeBible(raw);
      next.story.aspectRatio = doc.story.aspectRatio;
      next.story.targetDurationSec = doc.story.targetDurationSec;
      next.story.targetPlatform = doc.story.targetPlatform;
      setDoc(next);
    } catch (e) {
      setErr(errMsg(e));
    } finally {
      setGenBusy(false);
    }
  };

  // 三个数组都是 {name, ...} 形状：统一按 Record 处理，避免泛型推断塌缩
  const updateItem = (key: "characters" | "locations" | "props", i: number, patchObj: Record<string, unknown>) => {
    const list = [...doc[key]].map((it) => ({ ...it }));
    list[i] = { ...list[i], ...patchObj };
    patch({ [key]: list } as unknown as Partial<BibleDoc>);
  };
  const removeAt = (key: "characters" | "locations" | "props" | "continuity", i: number) => {
    const list = doc[key].filter((_, idx) => idx !== i);
    patch({ [key]: list } as unknown as Partial<BibleDoc>);
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" style={{ width: "min(860px, 95vw)" }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <span>📖 Story Bible · {doc.story.title || t("剧集设定")}</span>
          <button className="btn sm ghost" onClick={onClose}>✕</button>
        </div>
        <div className="modal-body">
          {/* AI 生成条 */}
          <div className="field" style={{ background: "var(--panel-2)", borderRadius: 8, padding: 12, border: "1px dashed var(--border-strong)" }}>
            <label>{t("⚡ AI 生成（填一句话需求，产出后可在下方任意修改再保存）")}</label>
            <div style={{ display: "flex", gap: 8 }}>
              <input
                type="text"
                placeholder={t("例如：都市甜宠，双女主合租互换人生，轻松搞笑带反转")}
                value={brief}
                onChange={(e) => setBrief(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && brief.trim() && void generate()}
              />
              <button className="btn blue" disabled={genBusy || !brief.trim()} onClick={() => void generate()}>
                {genBusy ? t("生成中…") : t("✨ 生成")}
              </button>
            </div>
          </div>

          <style>{CSS}</style>

          {/* 故事信息 */}
          <div className="bible-section">
            <h4>{t("🎬 故事信息")}</h4>
            <div className="bible-grid">
              <div className="field"><label>{t("剧名")}</label>
                <input type="text" value={doc.story.title ?? ""} onChange={(e) => patchStory({ title: e.target.value })} /></div>
              <div className="field"><label>{t("题材（如 都市甜宠 / 古装逆袭）")}</label>
                <input type="text" value={doc.story.genre ?? ""} onChange={(e) => patchStory({ genre: e.target.value })} /></div>
              <div className="field"><label>{t("时代背景")}</label>
                <input type="text" value={doc.story.era ?? ""} onChange={(e) => patchStory({ era: e.target.value })} /></div>
              <div className="field"><label>{t("主要地域")}</label>
                <input type="text" value={doc.story.location ?? ""} onChange={(e) => patchStory({ location: e.target.value })} /></div>
              <div className="field"><label>{t("主题")}</label>
                <input type="text" value={doc.story.theme ?? ""} onChange={(e) => patchStory({ theme: e.target.value })} /></div>
              <div className="field"><label>{t("目标平台")}</label>
                <input type="text" value={doc.story.targetPlatform ?? ""} onChange={(e) => patchStory({ targetPlatform: e.target.value })} /></div>
            </div>
            <div className="field" style={{ marginTop: 10 }}>
              <label>{t("视觉风格（给文生图用，建议英文风格描述）")}</label>
              <textarea
                value={doc.story.visualStyle ?? ""}
                style={{ minHeight: 64 }}
                placeholder="例：cinematic, neon cyberpunk city at night, teal and magenta contrast, shallow depth of field, 35mm film grain"
                onChange={(e) => patchStory({ visualStyle: e.target.value })}
              />
            </div>
          </div>

          {/* 角色 */}
          <div className="bible-section">
            <h4>{t("👤 角色（appearance 是生成参考图用的人物外形描述）")}</h4>
            {doc.characters.map((c: BibleCharacter, i) => (
              <div className="bible-row" key={i} style={{ gridTemplateColumns: "110px 1fr 1fr 34px" }}>
                <input type="text" placeholder={t("姓名")} value={c.name ?? ""} onChange={(e) => updateItem("characters", i, { name: e.target.value })} />
                <input type="text" placeholder={t("人设（性格/身份）")} value={c.desc ?? ""} onChange={(e) => updateItem("characters", i, { desc: e.target.value })} />
                <input type="text" placeholder={t("外形 appearance")} value={c.appearance ?? ""} onChange={(e) => updateItem("characters", i, { appearance: e.target.value })} />
                <button className="btn sm danger" title={t("删除")} onClick={() => removeAt("characters", i)}>×</button>
              </div>
            ))}
            <button className="btn sm" onClick={() => patch({ characters: [...doc.characters, { name: "", desc: "", appearance: "" }] })}>
              {t("＋ 添加角色")}
            </button>
          </div>

          {/* 场景 + 道具 */}
          <div className="bible-grid" style={{ marginTop: 12 }}>
            {(["locations", "props"] as const).map((key) => (
              <div className="bible-section" key={key} style={{ marginTop: 0 }}>
                <h4>{key === "locations" ? t("🏙️ 主要场景") : t("🎯 关键道具")}</h4>
                {doc[key].map((it: BibleNamedItem, i) => (
                  <div className="bible-row" key={i}>
                    <input type="text" placeholder={t("名称")} value={it.name ?? ""} onChange={(e) => updateItem(key, i, { name: e.target.value })} />
                    <input type="text" placeholder={t("描述")} value={it.desc ?? ""} onChange={(e) => updateItem(key, i, { desc: e.target.value })} />
                    <button className="btn sm danger" title={t("删除")} onClick={() => removeAt(key, i)}>×</button>
                  </div>
                ))}
                <button className="btn sm" onClick={() => patch({ [key]: [...doc[key], { name: "", desc: "" }] } as unknown as Partial<BibleDoc>)}>
                  {t("＋ 添加")}
                </button>
              </div>
            ))}
          </div>

          {/* 连续性规则 */}
          <div className="bible-section">
            <h4>{t("🔗 连续性规则（生成时保持一致的约束，如服装/发型/时间线）")}</h4>
            {doc.continuity.map((line: string, i) => (
              <div className="bible-continuity-row" key={i}>
                <input
                  type="text"
                  value={line}
                  onChange={(e) => {
                    const list = [...doc.continuity];
                    list[i] = e.target.value;
                    patch({ continuity: list });
                  }}
                />
                <button className="btn sm danger" title={t("删除")} onClick={() => removeAt("continuity", i)}>×</button>
              </div>
            ))}
            <button className="btn sm" onClick={() => patch({ continuity: [...doc.continuity, ""] })}>
              {t("＋ 添加规则")}
            </button>
          </div>

          {err && <div className="login-err" style={{ marginTop: 10 }}>⚠️ {err}</div>}
        </div>
        <div className="modal-foot">
          <button className="btn" onClick={onClose}>{t("取消")}</button>
          <button className="btn primary" disabled={busy} onClick={() => void save()}>
            {busy ? t("保存中…") : t("💾 保存圣经")}
          </button>
        </div>
      </div>
    </div>
  );
}
