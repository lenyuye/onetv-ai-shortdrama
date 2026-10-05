/**
 * Codex 式输入框 scoped 样式：整体容器 + 附件 chip 行 + 工具行 + 预览弹窗内元素
 * （自 views/AgentChatView.tsx 原样迁出，仍在输入区以 <style> 注入，注入位置不变）。
 */
export const AGENT_CSS = `
.agent-input-shell {
  display: flex; flex-direction: column; gap: 8px;
  background: var(--panel-2); border: 1px solid var(--border-strong);
  border-radius: 12px; padding: 10px 12px;
  transition: border-color .15s ease, box-shadow .15s ease, background .15s ease;
}
.agent-input-shell:focus-within {
  border-color: var(--blue); box-shadow: 0 0 0 2px rgba(77, 124, 254, 0.18);
}
.agent-input-shell.drag {
  border-color: var(--blue); box-shadow: 0 0 0 2px rgba(77, 124, 254, 0.35);
  background: var(--blue-soft);
}
.agent-chip-row { display: flex; flex-wrap: wrap; gap: 6px; }
.agent-chip {
  display: inline-flex; align-items: center; gap: 6px;
  max-width: 320px; padding: 3px 6px 3px 9px;
  background: rgba(255, 255, 255, 0.06); border: 1px solid var(--border);
  border-radius: 999px; font-size: 11.5px; color: var(--text);
}
.agent-chip-icon { flex-shrink: 0; font-size: 12px; line-height: 1; }
.agent-chip-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.agent-chip-actions { display: inline-flex; align-items: center; gap: 1px; flex-shrink: 0; }
.agent-chip-actions button {
  background: none; border: none; cursor: pointer;
  color: var(--muted); font-size: 11px; line-height: 1.4;
  padding: 1px 5px; border-radius: 4px; font-family: var(--font);
}
.agent-chip-actions button:hover { color: var(--text); background: rgba(255, 255, 255, 0.1); }
.agent-chip-actions button.agent-chip-remove:hover { color: var(--red); background: rgba(255, 84, 112, 0.12); }
.agent-input-shell textarea {
  width: 100%; min-height: 52px; padding: 2px 2px 0;
  background: transparent; border: none; outline: none;
  color: var(--text); font-size: 12.5px; resize: none;
}
.agent-input-shell textarea:focus { border: none; box-shadow: none; }
.agent-input-toolbar { display: flex; align-items: center; gap: 8px; }
.agent-attach-count { font-size: 11px; color: var(--muted); }
.agent-toolbar-sep { width: 1px; height: 20px; background: var(--border-strong); margin: 0 4px; flex-shrink: 0; }
.agent-attach-hint { font-size: 11px; color: var(--muted); }
.agent-link-ic {
  background: none; border: none; cursor: pointer;
  font-size: 15px; line-height: 1; padding: 3px 4px; border-radius: 6px;
  color: var(--blue);
}
.agent-link-ic:hover { color: var(--text); background: rgba(120, 140, 255, 0.12); }
.agent-link-ic:disabled { opacity: 0.4; cursor: default; }
.agent-plus-plain {
  background: none; border: none; cursor: pointer;
  font-size: 17px; line-height: 1; padding: 2px 6px; border-radius: 6px;
  color: var(--muted);
}
.agent-plus-plain:hover { color: var(--blue); background: rgba(120, 140, 255, 0.1); }
.agent-plus-plain.active { color: var(--blue); background: rgba(120, 140, 255, 0.14); }
.agent-plus-plain:disabled { opacity: 0.4; cursor: default; }
.agent-plus-btn.active { border-color: var(--blue); color: var(--blue); }
.agent-plus-menu {
  position: absolute; right: 0; bottom: calc(100% + 10px);
  width: 300px; max-height: 380px; overflow: auto;
  background: var(--panel-2); border: 1px solid var(--border-strong);
  border-radius: 12px; box-shadow: 0 10px 34px rgba(0, 0, 0, 0.4);
  padding: 8px; z-index: 60;
  display: flex; flex-direction: column; gap: 2px;
}
.agent-plus-head { font-size: 11.5px; color: var(--muted); padding: 4px 8px 6px; }
.agent-plus-item {
  display: flex; align-items: center; gap: 9px;
  background: none; border: none; cursor: pointer; text-align: left;
  color: var(--text); font-size: 12.5px; font-family: var(--font);
  padding: 8px 10px; border-radius: 8px; width: 100%;
}
.agent-plus-item:hover { background: rgba(120, 140, 255, 0.12); }
.agent-plus-item.disabled { opacity: 0.45; cursor: default; }
.agent-plus-item.disabled:hover { background: none; }
.agent-plus-item em { margin-left: auto; font-style: normal; font-size: 10.5px; color: var(--muted); }
.agent-plus-sep { height: 1px; background: var(--border); margin: 4px 6px; }
.agent-plus-input {
  width: 100%; margin: 2px 0 6px;
  background: var(--bg-deep); border: 1px solid var(--border-strong);
  border-radius: 8px; padding: 8px 10px; color: var(--text); font-size: 12.5px;
}
.agent-plus-input:focus { outline: none; border-color: var(--blue); }
.agent-plus-actions { display: flex; justify-content: flex-end; gap: 8px; padding: 4px 6px 2px; }
.agent-plus-list { display: flex; flex-direction: column; gap: 2px; max-height: 240px; overflow: auto; }
.agent-plus-empty { font-size: 12px; color: var(--muted); padding: 14px 10px; text-align: center; }
.agent-preview-text {
  margin: 0; max-height: 52vh; overflow-y: auto;
  font-family: var(--mono); font-size: 12px; line-height: 1.5;
  white-space: pre-wrap; word-break: break-all;
  background: var(--bg-deep); border: 1px solid var(--border);
  border-radius: var(--radius-sm); padding: 10px 12px;
}
.agent-preview-img {
  display: block; max-width: 100%; max-height: 56vh;
  margin: 0 auto; border-radius: var(--radius-sm);
}
.agent-preview-meta { display: flex; flex-direction: column; gap: 8px; font-size: 12.5px; }
.agent-preview-meta > div { display: flex; gap: 10px; align-items: flex-start; }
.agent-preview-meta > div > span:first-child {
  color: var(--muted); flex-shrink: 0; width: 42px; text-align: right;
}
.agent-preview-meta > div > span:last-child { word-break: break-all; user-select: text; }
.agent-msg-copy {
  background: none; border: none; cursor: pointer;
  color: var(--muted); font-size: 10px; font-family: var(--font);
  padding: 0 4px; border-radius: 4px; opacity: 0; transition: opacity .12s ease;
}
.agent-msg-copy:hover { color: var(--blue); background: rgba(120, 140, 255, 0.12); }
.agent-msg-bubble:hover .agent-msg-copy { opacity: 1; }
.agent-md { font-size: 12.5px; line-height: 1.6; word-break: break-word; }
.agent-md p { margin: 0 0 6px; }
.agent-md > :last-child { margin-bottom: 0; }
.agent-md ul, .agent-md ol { margin: 4px 0 6px; padding-left: 20px; }
.agent-md h1, .agent-md h2, .agent-md h3, .agent-md h4 { font-size: 13px; margin: 8px 0 4px; }
.agent-md blockquote { margin: 4px 0; padding: 2px 10px; border-left: 3px solid var(--border-strong); color: var(--muted); }
.agent-md code { font-family: var(--mono); font-size: 11.5px; background: rgba(127, 140, 170, 0.16); border-radius: 4px; padding: 1px 4px; }
.agent-md hr { border: none; border-top: 1px solid var(--border); margin: 8px 0; }
.agent-md table { border-collapse: collapse; margin: 6px 0; }
.agent-md th, .agent-md td { border: 1px solid var(--border); padding: 3px 8px; font-size: 11.5px; }
.agent-md a { color: var(--blue); }
.agent-md-code-wrap { display: block; position: relative; margin: 6px 0; }
.agent-md-code-wrap pre { margin: 0; }
.agent-md-code-wrap pre code {
  display: block; overflow-x: auto; white-space: pre;
  background: var(--bg-deep); border: 1px solid var(--border);
  border-radius: 8px; padding: 9px 12px;
}
.agent-md-copy {
  position: absolute; top: 6px; right: 6px; z-index: 2;
  background: var(--panel-2); border: 1px solid var(--border);
  cursor: pointer; color: var(--muted); font-size: 10px; font-family: var(--font);
  padding: 2px 7px; border-radius: 5px;
}
.agent-md-copy:hover { color: var(--text); border-color: var(--border-strong); }
.agent-stream-cursor {
  display: inline-block; margin-left: 1px; color: var(--blue);
  animation: onetv-blink 1s steps(2, start) infinite;
}
@keyframes onetv-blink { to { visibility: hidden; } }
.sess-sidebar {
  width: 208px; flex-shrink: 0; display: flex; flex-direction: column; gap: 8px;
  border-right: 1px solid var(--border); background: var(--panel);
  padding: 12px 10px 10px;
}
.sess-head { font-size: 11px; color: var(--muted); padding: 0 4px; letter-spacing: 0.5px; }
.sess-new { width: 100%; }
.sess-list { flex: 1; overflow-y: auto; display: flex; flex-direction: column; gap: 2px; min-height: 0; }
.sess-item {
  position: relative; display: flex; align-items: center; gap: 6px;
  padding: 7px 24px 7px 10px; border-radius: 8px; cursor: pointer;
  font-size: 12px; color: var(--text-dim);
}
.sess-item:hover { background: rgba(120, 140, 255, 0.1); color: var(--text); }
.sess-item.active { background: var(--blue-soft, rgba(77, 124, 254, 0.14)); color: var(--text); }
.sess-title { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sess-del {
  position: absolute; right: 6px; top: 50%; transform: translateY(-50%);
  background: none; border: none; cursor: pointer; color: var(--muted);
  font-size: 13px; line-height: 1; padding: 1px 4px; border-radius: 4px; opacity: 0;
  transition: opacity .12s ease;
}
.sess-item:hover .sess-del { opacity: 1; }
.sess-del:hover { color: var(--red); background: rgba(255, 84, 112, 0.12); }
.sess-rename {
  width: 100%; background: var(--bg-deep); border: 1px solid var(--blue);
  border-radius: 6px; color: var(--text); font-size: 12px; padding: 3px 6px;
  font-family: var(--font);
}
.sess-rename:focus { outline: none; }
.sess-foot { font-size: 10.5px; color: var(--muted); padding: 2px 4px 0; }
`;
