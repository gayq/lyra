export type AnimeProvider =
  | "anilist"
  | "mal"
  | "anidb"
  | "kitsu"
  | "tmdb"
  | "tmdbSeason"
  | "imdb"
  | "tvdb"
  | "tvdbSeason"
  | "animePlanet"
  | "liveChart"
  | "animeNewsNetwork"
  | "aniSearch"
  | "simkl"
  | "animeCountdown"
  | "anikoto"
  | "anikotoEpisode";







export type AnimeIds = Partial<Record<AnimeProvider, string>>;

export interface AnimeIdentity {
  ids: AnimeIds;
  titles: string[];
  year?: number;
  season?: string;
  format?: string;
  episodes?: number;
  mappingConfidence?: "direct" | "mapped" | "title";
  mappingSources?: string[];
  mappingWarnings?: string[];
}

export interface AnimeIdentityHints {
  ids?: AnimeIds | undefined;
  anilistId?: number | undefined;
  malId?: number | undefined;
  title?: string | undefined;
  year?: number | undefined;
  season?: string | undefined;
  format?: string | undefined;
}

function cleanId(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) {
    return String(value);
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (/^-/.test(trimmed) || /^0+$/.test(trimmed)) return undefined;
    return trimmed || undefined;
  }
  return undefined;
}

export function normalizeAnimeIds(
  value?: Partial<Record<AnimeProvider, unknown>> & {
    anilistId?: number | string | undefined;
    malId?: number | string | undefined;
  },
): AnimeIds {
  if (!value) return {};
  const normalized: AnimeIds = {};
  for (const provider of [
    "anilist",
    "mal",
    "anidb",
    "kitsu",
    "tmdb",
    "tmdbSeason",
    "imdb",
    "tvdb",
    "tvdbSeason",
    "animePlanet",
    "liveChart",
    "animeNewsNetwork",
    "aniSearch",
    "simkl",
    "animeCountdown",
    "anikoto",
    "anikotoEpisode",
  ] as const) {
    const id = cleanId(value[provider]);
    if (id) normalized[provider] = id;
  }
  const anilist = cleanId(value.anilistId);
  const mal = cleanId(value.malId);
  if (anilist && !normalized.anilist) normalized.anilist = anilist;
  if (mal && !normalized.mal) normalized.mal = mal;
  return normalized;
}

export function mergeAnimeIds(...values: Array<AnimeIds | undefined>): AnimeIds {
  const merged: AnimeIds = {};
  for (const value of values) {
    Object.assign(merged, normalizeAnimeIds(value));
  }
  return merged;
}

export function hasAnimeIdentity(ids: AnimeIds | undefined): boolean {
  return Object.keys(normalizeAnimeIds(ids)).length > 0;
}

export function hasMegaPlayIdentifier(ids: AnimeIds | undefined): boolean {
  const normalized = normalizeAnimeIds(ids);
  return Boolean(normalized.anilist || normalized.mal || normalized.anikotoEpisode);
}

 
export function appendMegaPlayParams(
  params: URLSearchParams,
  ids: AnimeIds | undefined,
): URLSearchParams {
  const normalized = normalizeAnimeIds(ids);
  if (normalized.anilist) params.set("anilist_id", normalized.anilist);
  if (normalized.mal) params.set("mal_id", normalized.mal);
  if (normalized.anikotoEpisode) {
    params.set("anikoto_episode_id", normalized.anikotoEpisode);
  }
  return params;
}

export function animeIdentityCacheKey(hints: AnimeIdentityHints): string {
  const ids = normalizeAnimeIds(hints.ids);
  if (hints.anilistId) ids.anilist ||= String(hints.anilistId);
  if (hints.malId) ids.mal ||= String(hints.malId);
  return JSON.stringify({
    ids: Object.entries(ids).sort(([a], [b]) => a.localeCompare(b)),
    title: hints.title?.trim().toLocaleLowerCase() || "",
    year: hints.year || 0,
    season: hints.season || "",
    format: hints.format || "",
  });
}

const identityPromises = new Map<string, Promise<AnimeIdentity | null>>();
const identityCache = new Map<
  string,
  { expiresAt: number; identity: AnimeIdentity }
>();
const IDENTITY_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

export function resetAnimeIdentityCache(): void {
  identityPromises.clear();
  identityCache.clear();
}

export async function resolveAnimeIdentity(
  hints: AnimeIdentityHints,
  signal?: AbortSignal,
): Promise<AnimeIdentity | null> {
  const key = animeIdentityCacheKey(hints);
  const cached = identityCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.identity;
  if (cached) identityCache.delete(key);

  const existing = identityPromises.get(key);
  if (existing) return existing;

  const requestInit: RequestInit = {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      ids: normalizeAnimeIds(hints.ids),
      anilist_id: cleanId(hints.anilistId),
      mal_id: cleanId(hints.malId),
      title: hints.title,
      year: hints.year,
      season: hints.season,
      format: hints.format,
    }),
  };
  if (signal) requestInit.signal = signal;

  const promise = fetch("/api/anime/identity/resolve", requestInit)
    .then(async (response) => {
      if (!response.ok) return null;
      const identity = (await response.json()) as AnimeIdentity;
      if (!identity || typeof identity !== "object") return null;
      const normalized: AnimeIdentity = {
        ...identity,
        ids: normalizeAnimeIds(identity.ids),
        titles: Array.isArray(identity.titles) ? identity.titles : [],
      };
      identityCache.set(key, {
        expiresAt: Date.now() + IDENTITY_CACHE_TTL_MS,
        identity: normalized,
      });
      return normalized;
    })
    .catch((error) => {
      if (error instanceof DOMException && error.name === "AbortError") {
        throw error;
      }
      return null;
    })
    .finally(() => identityPromises.delete(key));

  identityPromises.set(key, promise);
  return promise;
}
