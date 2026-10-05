/**
 * useCanvasEpisodes —— 画布视图的分集状态 hook：
 * - 分集列表跟随项目 / 集数变化刷新；
 * - 自动选中第一个分集；当前分集被移除时回退；
 * - createEpisode：新建分集后刷新列表并选中新分集。
 */
import { useEffect, useState } from "react";
import * as api from "../api";
import type { EpisodeInfo } from "@onetv/shared-types";
import { useT } from "../i18n";
import { useApp } from "../store";
import { errMsg } from "../components/canvas/canvas-model";

export function useCanvasEpisodes() {
  const t = useT();
  const { project, setView, loadProject, toast } = useApp();
  const [episodes, setEpisodes] = useState<EpisodeInfo[]>([]);
  const [episodesLoaded, setEpisodesLoaded] = useState(false);
  const [episodeId, setEpisodeId] = useState("");
  const [creating, setCreating] = useState(false);

  // 分集列表：跟随项目 / 集数变化刷新
  useEffect(() => {
    if (!project) return;
    setEpisodesLoaded(false);
    api
      .episodeList()
      .then(setEpisodes)
      .catch(() => {})
      .finally(() => setEpisodesLoaded(true));
  }, [project?.episodes.length]);

  // 自动选中第一个分集；当前分集被移除时回退
  useEffect(() => {
    if (episodes.length === 0) {
      if (episodeId) setEpisodeId("");
      return;
    }
    if (!episodeId || !episodes.some((ep) => ep.id === episodeId)) {
      setEpisodeId(episodes[0].id);
    }
  }, [episodeId, episodes]);

  const createEpisode = async () => {
    setCreating(true);
    try {
      const ep = await api.episodeCreate();
      await loadProject();
      const list = await api.episodeList().catch(() => [] as EpisodeInfo[]);
      if (list.length) setEpisodes(list);
      setEpisodeId(ep.id);
      toast(t("已新增一集"), "ok");
    } catch (e) {
      toast(t("新增失败：{msg}", { msg: errMsg(e) }), "err");
    } finally {
      setCreating(false);
    }
  };

  return { project, setView, episodes, episodesLoaded, episodeId, setEpisodeId, creating, createEpisode };
}
