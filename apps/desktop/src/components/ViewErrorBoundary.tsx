/**
 * 视图层错误边界：任何视图渲染崩溃时显示可读错误卡（含重试按钮），
 * 而不是整个窗口白屏。重试 = 重置边界并重新渲染当前视图。
 */
import { Component, type ErrorInfo, type ReactNode } from "react";
import { t } from "../i18n";

interface Props {
  children: ReactNode;
}

interface State {
  error: Error | null;
  /** 崩溃组件栈（componentDidCatch 捕获；复制错误详情用） */
  stack: string | null;
}

export class ViewErrorBoundary extends Component<Props, State> {
  state: State = { error: null, stack: null };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("视图渲染崩溃:", error, info.componentStack);
    // v2.26.31：持久化崩溃详情，供「复制错误详情」与事后排查
    this.setState({ stack: info.componentStack ?? null });
    try {
      localStorage.setItem(
        "onetv-last-crash",
        JSON.stringify({ at: new Date().toISOString(), message: error.message, stack: info.componentStack ?? "" }, null, 2),
      );
    } catch { /* 存储失败不影响错误展示 */ }
  }

  private reset = () => this.setState({ error: null, stack: null });

  private copyDetails = () => {
    const { error, stack } = this.state;
    const text = [
      `time: ${new Date().toISOString()}`,
      `error: ${error?.message ?? "(unknown)"}`,
      "componentStack:",
      stack ?? "(none)",
    ].join("\n");
    void navigator.clipboard.writeText(text).catch(() => {});
    try { localStorage.setItem("onetv-last-crash", JSON.stringify({ at: new Date().toISOString(), message: error?.message, stack }, null, 2)); } catch { /* ignore */ }
  };

  render() {
    if (this.state.error) {
      return (
        <div className="empty-state" style={{ height: "100%" }}>
          <div className="big">⚠️</div>
          <h2>{t("页面渲染出错了")}</h2>
          <p style={{ maxWidth: 560, fontFamily: "var(--mono)", fontSize: 11.5, wordBreak: "break-all" }}>
            {this.state.error.message}
          </p>
          <div style={{ display: "flex", gap: 8 }}>
            <button className="btn primary" onClick={this.reset}>{t("重试")}</button>
            <button className="btn" onClick={() => location.reload()}>{t("重新加载应用")}</button>
            <button className="btn" title={t("复制错误信息与组件栈，用于排查定位")} onClick={this.copyDetails}>
              {t("📋 复制错误详情")}
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
