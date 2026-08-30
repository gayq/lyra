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
    return `anime: ${title}${episodeLabel}`;
  } catch {
    return null;
  }
}
