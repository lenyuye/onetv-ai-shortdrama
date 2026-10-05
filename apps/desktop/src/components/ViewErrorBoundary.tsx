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
}

export class ViewErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("视图渲染崩溃:", error, info.componentStack);
  }

  private reset = () => this.setState({ error: null });

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
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
