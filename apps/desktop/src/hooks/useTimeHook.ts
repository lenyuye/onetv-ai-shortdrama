/**
 * 测试时钟钩子（v2.3.5）—— 连点版本号 5 次唤出的时间边界测试入口（普通用户无感）。
 * 从 SettingsView 原样迁出：状态与请求时序不变，仅移动位置。
 */
import { useState } from "react";
import * as api from "../api";
import { useT } from "../i18n";

export interface TimeHook {
  timeHookOpen: boolean;
  offsetInput: string;
  setOffsetInput: (v: string) => void;
  hookStatus: string;
  onVersionClick: () => void;
  applyTimeOffset: () => Promise<void>;
}

export function useTimeHook(): TimeHook {
  const t = useT();
  const [verClicks, setVerClicks] = useState(0);
  const [timeHookOpen, setTimeHookOpen] = useState(false);
  const [offsetInput, setOffsetInput] = useState("0");
  const [hookStatus, setHookStatus] = useState("");

  const onVersionClick = () => {
    setVerClicks((c) => {
      if (c + 1 >= 5) {
        setTimeHookOpen(true);
        setVerClicks(0);
        return 0;
      }
      // 3 秒内连点才累计
      window.setTimeout(() => setVerClicks(0), 3000);
      return c + 1;
    });
  };

  const applyTimeOffset = async () => {
    const secs = Number(offsetInput);
    if (!Number.isFinite(secs)) { setHookStatus(t("偏移量必须是整数秒（可为负）")); return; }
    try {
      await api.debugSetTimeOffset(Math.trunc(secs));
      const st = await api.debugSessionStatus();
      const remain = st.remainingSecs === null ? t("无会话") : t("{d}天{h}时{m}分", { d: Math.floor(st.remainingSecs / 86400), h: Math.floor((st.remainingSecs % 86400) / 3600), m: Math.floor((st.remainingSecs % 3600) / 60) });
      setHookStatus(t("已设置偏移 {secs}s（正值=时钟前移）。会话剩余：{remain}。设为 0 恢复真实时钟。", { secs: st.offsetSecs, remain }));
    } catch (e) {
      setHookStatus(t("设置失败：{msg}", { msg: api.errMsg(e) }));
    }
  };

  return { timeHookOpen, offsetInput, setOffsetInput, hookStatus, onVersionClick, applyTimeOffset };
}
