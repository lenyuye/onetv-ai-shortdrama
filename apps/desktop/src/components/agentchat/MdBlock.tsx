/**
 * 助手消息 Markdown 渲染（GFM 表格/删除线等；代码块带复制按钮；链接新窗打开）。
 * 自 views/AgentChatView.tsx 原样迁出；主视图仍 re-export 该组件以保持可导入性。
 */
import { memo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useT } from "../../i18n";

export const MdBlock = memo(function MdBlock({ text }: { text: string }) {
  const t = useT();
  return (
    <div className="agent-md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          // pre 由 code 的块级分支自渲染（否则会出现嵌套 pre）
          pre: ({ children }) => <>{children}</>,
          code({ className, children }) {
            const raw = String(children ?? "").replace(/\n$/, "");
            const isBlock = /language-/.test(className ?? "") || raw.includes("\n");
            if (!isBlock) {
              return <code className={className}>{children}</code>;
            }
            return (
              <span className="agent-md-code-wrap">
                <button
                  className="agent-md-copy"
                  onClick={() => void navigator.clipboard.writeText(raw)}
                >
                  {t("复制")}
                </button>
                <pre>
                  <code className={className}>{raw}</code>
                </pre>
              </span>
            );
          },
          a({ children, ...rest }) {
            return (
              <a {...rest} target="_blank" rel="noreferrer">
                {children}
              </a>
            );
          },
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
});
