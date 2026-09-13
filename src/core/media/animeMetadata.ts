const ANIME_PLAYBACK_PATH = "/stream/anime";

export function getAnimeDisplayLabel(realUrl: string): string | null {
  try {
    const url = new URL(realUrl, "http://lyra.local");
    if (url.pathname !== ANIME_PLAYBACK_PATH) return null;

    const title = url.searchParams
      .get("title")
      ?.replace(/\s+/g, " ")
      .trim()
      .toLowerCase();
    if (!title) return null;

    const episode = url.searchParams.get("episode")?.trim();
    const episodeLabel = episode && /^\d+$/.test(episode)
      ? ` / episode: ${episode}`
      : "";
    const season = url.searchParams.get("season")?.trim();
    const seasonLabel = season && /^[1-9]\d*$/.test(season)
      ? ` / season: ${season}`
      : "";
    return `anime: ${title}${seasonLabel}${episodeLabel}`;
  } catch {
    return null;
  }
}
