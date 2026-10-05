/**
 * useTauriEvent —— Tauri 事件订阅的统一 React hook。
 *
 * 解决手写订阅的两个常见问题：
 * 1. 竞态：组件卸载早于 listen promise resolve 时，promise 回调里拿到的 unlisten
 *    会被错过、监听器泄漏 —— 用 cancelled 标志在 resolve 后立即补调 unlisten；
 * 2. handler 每次渲染都是新引用 —— 用 ref 镜像（组件内首帧存入、后续渲染仅更新引用），
 *    effect 不依赖 handler，避免反复「退订 + 重订阅」。
 */
import { useEffect, useRef } from "react";
import { onAppEvent } from "../api";

export function useTauriEvent<T>(name: string, handler: (payload: T) => void): void {
  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  useEffect(() => {
    let cancelled = false;
    let unlisten: (() => void) | null = null;
    onAppEvent<T>(name, (payload) => handlerRef.current(payload)).then((f) => {
      if (cancelled) {
        f(); // 卸载发生在 listen resolve 之前：立即退订，防止泄漏
        return;
      }
      unlisten = f;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [name]);
}
