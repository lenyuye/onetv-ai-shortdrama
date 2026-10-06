/**
 * Agent 对话「大＋」菜单逻辑 hook：菜单面板状态、链接输入、
 * 画布节点 / 已安装技能两个数据源加载、点击外部与 Esc 关闭。
 * 自 views/AgentChatView.tsx 原样迁出；plusRef 挂在输入工具行容器上（定位锚点不变）。
 */
import { useEffect, useRef, useState } from "react";
import * as api from "../api";
import { canvasGet } from "../api-canvas";
import { type PluginListItem, type PluginManifestInfo, pluginGet, pluginRenderPrompt, plugin_list, skill_list } from "../api-extras";
import { errMsg } from "../api-story";
import { useT } from "../i18n";
import type { PlusMenuPane } from "../components/agentchat/constants";

interface UseAgentPlusMenuParams {
  toast: (text: string, kind?: "ok" | "err") => void;
}

export function useAgentPlusMenu({ toast }: UseAgentPlusMenuParams) {
  const t = useT();
  /** 大＋功能菜单：null=关闭，root/link/node/skill/tool=对应面板 */
  const [plusMenu, setPlusMenu] = useState<PlusMenuPane>(null);
  const [linkInput, setLinkInput] = useState("");
  const [canvasNodes, setCanvasNodes] = useState<{ id: string; title: string; type: string; summary: string }[]>([]);
  const [skillNames, setSkillNames] = useState<string[]>([]);
  /** 插件面板：清单列表 + 当前展开（含 prompts）的插件 */
  const [plugins, setPlugins] = useState<PluginListItem[]>([]);
  const [activePlugin, setActivePlugin] = useState<PluginManifestInfo | null>(null);
  /** 输入工具行容器 ref：大＋菜单的定位与外部点击判定锚点 */
  const plusRef = useRef<HTMLDivElement | null>(null);

  // 大＋菜单数据源：画布节点（全部分集）与已安装技能
  const loadCanvasNodes = async () => {
    try {
      const eps = await api.episodeList();
      const out: { id: string; title: string; type: string; summary: string }[] = [];
      for (const ep of eps) {
        try {
          const doc = await canvasGet(ep.id);
          for (const n of (doc as { nodes?: { id: string; title: string; type: string; config?: Record<string, unknown> }[] }).nodes ?? []) {
            // 显式提取节点产物与参考资产 id：绑定后 Agent 可直接调用节点中的参考图/视频
            const cfg = n.config ?? {};
            const outId = typeof cfg.outputAssetId === "string" ? cfg.outputAssetId : "";
            const refIds = Array.isArray(cfg.referenceAssetIds)
              ? cfg.referenceAssetIds.filter((x): x is string => typeof x === "string" && x !== "")
              : [];
            const assetNote = [
              outId ? `产物资产=${outId}` : "",
              refIds.length > 0 ? `参考资产=${refIds.join(",")}` : "",
            ]
              .filter(Boolean)
              .join("；");
            const cfgSummary = Object.entries(cfg)
              .filter(([k]) => k !== "outputAssetId" && k !== "referenceAssetIds")
              .filter(([, v]) => (typeof v === "string" ? v : JSON.stringify(v ?? "")) !== "")
              .slice(0, 2)
              .map(([k, v]) => `${k}=${typeof v === "string" ? v.slice(0, 12) : JSON.stringify(v)?.slice(0, 12)}`)
              .join(" · ");
            out.push({
              id: n.id,
              title: n.title || n.id,
              type: n.type,
              summary: [assetNote, cfgSummary].filter(Boolean).join("；"),
            });
          }
        } catch { /* 单集失败继续 */ }
      }
      setCanvasNodes(out);
    } catch (e) {
      toast(t("读取画布节点失败：{msg}", { msg: errMsg(e) }), "err");
    }
  };

  const loadSkills = async () => {
    try {
      const list = await skill_list();
      setSkillNames(list.map((x) => x.name));
    } catch (e) {
      toast(t("读取技能失败：{msg}", { msg: errMsg(e) }), "err");
    }
  };

  /* ---------- 插件面板（prompt-pack 提示词包） ---------- */
  const loadPlugins = async () => {
    try {
      setActivePlugin(null); // 重新打开面板时回到插件列表（清掉上一次展开的插件）
      setPlugins(await plugin_list());
    } catch (e) {
      toast(t("读取插件失败：{msg}", { msg: errMsg(e) }), "err");
    }
  };

  /** 点开一个插件：加载完整清单（含 prompts）进入提示词子列表 */
  const selectPlugin = async (p: PluginListItem) => {
    if (!p.valid) return;
    try {
      setActivePlugin(await pluginGet(p.id));
    } catch (e) {
      toast(t("获取插件详情失败：{msg}", { msg: errMsg(e) }), "err");
    }
  };

  const backToPluginList = () => setActivePlugin(null);

  /** 渲染插件提示词 → 返回文本（失败 toast 并返回 null，由调用方决定插入与关闭） */
  const renderPluginPrompt = async (pluginId: string, promptId: string, input: string): Promise<string | null> => {
    try {
      const r = await pluginRenderPrompt(pluginId, promptId, input);
      return r.text;
    } catch (e) {
      toast(t("插件提示词渲染失败：{msg}", { msg: errMsg(e) }), "err");
      return null;
    }
  };

  // 大＋菜单：点击外部 / Esc 关闭（与小＋完全独立，互不触发）
  useEffect(() => {
    if (!plusMenu) return;
    const onDown = (e: MouseEvent) => {
      if (plusRef.current && !plusRef.current.contains(e.target as Node)) setPlusMenu(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setPlusMenu(null);
    };
    window.addEventListener("mousedown", onDown, true);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown, true);
      window.removeEventListener("keydown", onKey);
    };
  }, [plusMenu]);

  return {
    plusMenu,
    setPlusMenu,
    linkInput,
    setLinkInput,
    canvasNodes,
    skillNames,
    loadCanvasNodes,
    loadSkills,
    plugins,
    activePlugin,
    loadPlugins,
    selectPlugin,
    backToPluginList,
    renderPluginPrompt,
    plusRef,
  };
}
