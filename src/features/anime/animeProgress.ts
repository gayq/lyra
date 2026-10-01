import {
  buildAnimePlaybackUrl,
  type AnimeEntry,
  type AnimePlaybackUrlOptions,
} from "./anime.ts";
import {
  hasMegaPlayIdentifier,
  normalizeAnimeIds,
  type AnimeIds,
} from "./animeIdentity.ts";

export const ANIME_PROGRESS_KEY = "lyra-anime-progress";
export const ANIME_PROGRESS_EVENT = "anime-progress-changed";

export interface AnimeProgress extends AnimePlaybackUrlOptions {
  currentTime: number;
  duration: number;
  updatedAt: number;
  completed: boolean;
}

function sameAnime(
  left: AnimeIds | undefined,
  right: AnimeIds | undefined,
): boolean {
  const providers = ["anilist", "mal", "kitsu", "anidb", "anikoto"] as const;
  return (
    providers.some(
      (provider) => left?.[provider] && left[provider] === right?.[provider],
    ) ||
    (!providers.some((provider) => left?.[provider] || right?.[provider]) &&
      !!left?.anikotoEpisode && left.anikotoEpisode === right?.anikotoEpisode)
  );
}

export function readAnimeProgress(): AnimeProgress[] {
  try {
    const records: unknown = JSON.parse(
      localStorage.getItem(ANIME_PROGRESS_KEY) || "[]",
    );
    if (!Array.isArray(records)) return [];
    return records.filter((record): record is AnimeProgress => {
      if (!record || typeof record !== "object") return false;
      const progress = record as AnimeProgress;
      return (
        typeof progress.title === "string" &&
        typeof progress.posterUrl === "string" &&
        hasMegaPlayIdentifier(progress.ids) &&
        Number.isInteger(progress.episode) && progress.episode > 0 &&
        (progress.language === "sub" || progress.language === "dub") &&
        Number.isFinite(progress.currentTime) && progress.currentTime > 0 &&
        Number.isFinite(progress.duration) && progress.duration >= 0 &&
        Number.isFinite(progress.updatedAt) && progress.updatedAt > 0 &&
        typeof progress.completed === "boolean" &&
        (progress.format === undefined || typeof progress.format === "string") &&
        [progress.sourceEpisode, progress.season, progress.episodeCount, progress.year].every(
          (value) => value === undefined || (Number.isInteger(value) && (value || 0) > 0),
        ) &&
        (progress.parts === undefined || (Array.isArray(progress.parts) && progress.parts.every(
          (part) => part && typeof part.title === "string" && hasMegaPlayIdentifier(part.ids) &&
            Number.isInteger(part.episodeCount) && (part.episodeCount || 0) > 0,
        )))
      );
    }).sort((left, right) => right.updatedAt - left.updatedAt);
  } catch {
    return [];
  }
}

export function saveAnimeProgress(
  progress: AnimeProgress,
  resumeKey: string,
): void {
  if (
    !Number.isFinite(progress.currentTime) || progress.currentTime <= 0 ||
    !hasMegaPlayIdentifier(progress.ids)
  ) return;
  try {
    localStorage.setItem(resumeKey, JSON.stringify({
      currentTime: progress.currentTime,
      timestamp: progress.updatedAt,
    }));
    const records = readAnimeProgress();
    const previous = records.find((record) => sameAnime(record.ids, progress.ids));
    if (
      previous && previous.episode === progress.episode &&
      previous.language === progress.language &&
      previous.currentTime === progress.currentTime &&
      previous.completed === progress.completed
    ) return;
    localStorage.setItem(ANIME_PROGRESS_KEY, JSON.stringify([
      progress,
      ...records.filter((record) => !sameAnime(record.ids, progress.ids)),
    ]));
    window.dispatchEvent(new Event(ANIME_PROGRESS_EVENT));
  } catch {}
}

export function findAnimeProgress(
  records: readonly AnimeProgress[],
  anime: Pick<AnimeEntry, "ids" | "anilistId" | "malId" | "seasons">,
): AnimeProgress | undefined {
  const ids = normalizeAnimeIds({
    ...anime.ids,
    anilistId: anime.anilistId,
    malId: anime.malId,
  });
  return records.find(
    (record) => !record.completed && (
      sameAnime(record.ids, ids) ||
      record.parts?.some((part) => sameAnime(part.ids, ids)) ||
      anime.seasons?.some((season) => sameAnime(record.ids, season.ids))
    ),
  );
}

export function animeProgressLabel(
  progress: AnimeProgress,
  label: "resume" | "watching" = "resume",
): string {
  const seconds = Math.floor(progress.currentTime);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const clockMinutes = hours
    ? `${hours}:${String(minutes).padStart(2, "0")}`
    : String(minutes);
  const clock = `${clockMinutes}:${String(seconds % 60).padStart(2, "0")}`;
  return `${label} episode ${progress.episode} · ${clock}`;
}

export function animeResumeUrl(progress: AnimeProgress): string {
  return `${buildAnimePlaybackUrl(progress)}&resume=${progress.currentTime}`;
}
