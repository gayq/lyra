const ANIME_PLAYBACK_PATH = "/stream/anime";

function playbackUrl(realUrl: string): URL | null {
  try {
    const url = new URL(realUrl, "http://lyra.local");
    return url.pathname === ANIME_PLAYBACK_PATH ? url : null;
  } catch {
    return null;
  }
}

export function compactAnimePlaybackPath(realUrl: string): string | null {
  const url = playbackUrl(realUrl);
  if (!url) return null;

  const params = url.searchParams;
  const mal = params.get("mal_id")?.trim();
  const anilist = params.get("anilist_id")?.trim();
  if (!mal && !anilist) return null;

  const compact = new URLSearchParams();
  const title = params.get("title")?.replace(/\s+/g, " ").trim();
  if (title) compact.set("title", title);
  if (anilist) compact.set("anilist_id", anilist);
  if (mal) compact.set("mal_id", mal);

  const sourceEpisode = params.get("source_episode")?.trim();
  const episode =
    sourceEpisode && /^\d+$/.test(sourceEpisode) && Number(sourceEpisode) > 0
      ? sourceEpisode
      : params.get("episode")?.trim() || "";
  if (/^\d+$/.test(episode) && Number(episode) > 0) compact.set("episode", episode);

  const format = params.get("format")?.trim();
  if (format) compact.set("format", format);
  const formatKey = format?.toUpperCase();
  if (formatKey !== "MOVIE" && formatKey !== "MUSIC") {
    const season = params.get("season")?.trim();
    if (season && /^[1-9]\d*$/.test(season)) compact.set("season", season);
  }

  if (params.get("language") === "dub") compact.set("language", "dub");
  return `${ANIME_PLAYBACK_PATH}?${compact.toString()}`;
}

export function getAnimeDisplayLabel(realUrl: string): string | null {
  try {
    const url = playbackUrl(realUrl);
    if (!url) return null;

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
