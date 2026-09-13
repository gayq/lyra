import { encodeMochiUrl } from "../../core/runtime/utils.ts";
import { cacheKey } from "../../core/runtime/cacheNamespace.ts";
import { catalogMatchRank, normalizeCatalogText } from "../games/catalogSearch.ts";
import { RequestError } from "../../core/runtime/messages.ts";
import {
  appendMegaPlayParams,
  mergeAnimeIds,
  normalizeAnimeIds,
  resetAnimeIdentityCache,
  type AnimeIds,
} from "./animeIdentity.ts";

export interface AnimeEntry {
  id: string | number;
  title: string;
  year?: number | undefined;
  posterUrl: string;
  posterSmallUrl?: string | undefined;
  backdropUrl?: string | undefined;
  rating?: number | undefined;
  overview?: string | undefined;
  animeType: "anime";
  genres?: string[] | undefined;
  adult?: boolean | undefined;
  category?: AnimeEntryCategory | undefined;
   
  ids?: AnimeIds | undefined;
  seasons?: AnimeSeason[] | undefined;
  anilistId?: number | undefined;
  malId?: number | undefined;
  format?: string | undefined;
  episodeCount?: number | undefined;
  _metadataSource?: "anilist" | "jikan" | "kitsu" | "anikoto" | undefined;
  _episodeCountSource?:
    | "anikoto"
    | "anikotoAiring"
    | "anilist"
    | "anilistAiring"
    | "kitsu"
    | "jikan"
    | undefined;
  _normalizedTitle?: string | undefined;
  _searchText?: string | undefined;
}

type AnimeEntryCategory =
  | "main-season"
  | "movie"
  | "ova"
  | "ona"
  | "special"
  | "recap"
  | "spin-off"
  | "side-story"
  | "music"
  | "unknown";

interface AnimeSeasonPart {
  id: string | number;
  title: string;
  year?: number | undefined;
  number?: number | undefined;
  ids: AnimeIds;
  episodeCount?: number | undefined;
  _episodeCountSource?: AnimeEntry["_episodeCountSource"];
  _metadataSource?: AnimeEntry["_metadataSource"];
}

export interface AnimeSeason {
  id: string | number;
  title: string;
  year?: number | undefined;
  number?: number | undefined;
  ids: AnimeIds;
  category?: AnimeEntryCategory | undefined;
  format?: string | undefined;
  episodeCount?: number | undefined;
  _metadataSource?: AnimeEntry["_metadataSource"];
  _episodeCountSource?:
    | "anikoto"
    | "anikotoAiring"
    | "anilist"
    | "anilistAiring"
    | "kitsu"
    | "jikan"
    | undefined;
  relationType?: string | undefined;
  parts?: AnimeSeasonPart[] | undefined;
}

export type AnimeCategory = "trending" | "anime";

export function isAnimeMovieFormat(format?: string): boolean {
  const normalized = format?.trim().toUpperCase();
  return normalized === "MOVIE" || normalized === "MUSIC";
}

function classifyAnimeCategory(
  format?: string,
  title = "",
  relationType?: string,
): AnimeEntryCategory {
  const normalizedFormat = format?.trim().toUpperCase();
  const normalizedTitle = title.toLocaleLowerCase();
  const normalizedRelation = relationType
    ?.trim()
    .toLocaleLowerCase()
    .replace(/[-_]+/g, " ");

  if (normalizedFormat === "MOVIE") return "movie";
  if (normalizedFormat === "MUSIC") return "music";
  if (normalizedFormat === "OVA" || normalizedFormat === "OAD") return "ova";
  if (normalizedFormat === "ONA") return "ona";
  if (
    normalizedFormat === "SPECIAL" ||
    /\b(?:special|recap|summary|digest|kanwa)\b/.test(normalizedTitle)
  ) {
    return /\b(?:recap|summary|digest)\b/.test(normalizedTitle)
      ? "recap"
      : "special";
  }
  if (/\b(?:movie|gekijouban|film)\b/.test(normalizedTitle)) return "movie";
  if (/\b(?:ova|oad)\b/.test(normalizedTitle)) return "ova";
  if (/\bona\b/.test(normalizedTitle)) return "ona";
  if (normalizedRelation === "spin off") return "spin-off";
  if (normalizedRelation === "side story") return "side-story";
  if (normalizedFormat === "TV" || normalizedFormat === "TV_SHORT") {
    return "main-season";
  }
  if (
    normalizedRelation === "prequel" ||
    normalizedRelation === "sequel"
  ) {
    return "main-season";
  }
  return "unknown";
}

 
function normalizeAnimeRating(value: unknown): number | undefined {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  const score = parsed > 10 ? parsed / 10 : parsed;
  if (!Number.isFinite(score) || score <= 0) return undefined;
  return Math.round(Math.min(10, score) * 10) / 10;
}

export function episodeNumbersForCount(
  maxEpisode: number,
  initialEpisode = 0,
): number[] {
  const count = Math.max(maxEpisode || 0, initialEpisode || 0);
  return count > 0
    ? Array.from({ length: count }, (_, index) => index + 1)
    : [];
}

export function playableAnimeParts(parts: readonly AnimeSeasonPart[]): AnimeSeasonPart[] {
  const end = parts.findIndex((part) => !Number.isInteger(part.episodeCount) || (part.episodeCount || 0) <= 0);
  return parts.slice(0, end < 0 ? parts.length : end);
}

export interface AnimePlaybackUrlOptions {
  title: string;
  posterUrl: string;
  ids?: AnimeIds | undefined;
  episode: number;
  season?: number | undefined;
  sourceEpisode?: number | undefined;
  episodeCount?: number | undefined;
  year?: number | undefined;
  format?: string | undefined;
  language?: "sub" | "dub" | undefined;
  parts?: AnimeSeasonPart[] | undefined;
}

export function buildAnimePlaybackUrl({
  title,
  posterUrl,
  ids,
  episode,
  season,
  sourceEpisode,
  episodeCount,
  year,
  format,
  language = "sub",
  parts,
}: AnimePlaybackUrlOptions): string {
  const params = new URLSearchParams({
    title,
    poster: posterUrl,
    episode: String(episode),
    episodeName: `E${episode}`,
    language,
  });
  appendMegaPlayParams(params, ids);
  if (!isAnimeMovieFormat(format)) {
    params.set("season", String(season !== undefined && Number.isInteger(season) && season > 0 ? season : seasonNumberFromTitle(title) || 1));
  }
  if (sourceEpisode && sourceEpisode > 0 && sourceEpisode !== episode) {
    params.set("source_episode", String(sourceEpisode));
  }
  if (parts && parts.length > 1) {
    let start = 1;
    const ranges = playableAnimeParts(parts).flatMap((part) => {
      const count = part.episodeCount || 0;
      if (count <= 0) return [];
      const range = { start, end: start + count - 1, ids: part.ids };
      start += count;
      return [range];
    });
    if (ranges.length > 1) params.set("episode_parts", JSON.stringify(ranges));
  }
  if (year) params.set("year", String(year));
  if (episodeCount && episodeCount > 0) {
    params.set("episode_count", String(episodeCount));
  }
  if (format) params.set("format", format);
  return `/stream/anime?${params.toString()}`;
}

function deriveAniListEpisodeCount(
  media: Pick<AniListMedia, "episodes" | "status" | "nextAiringEpisode">,
): { count?: number; source?: "anilist" | "anilistAiring" } {
  if (Number.isInteger(media.episodes) && (media.episodes || 0) > 0) {
    return { count: media.episodes!, source: "anilist" };
  }
  const nextEpisode = media.nextAiringEpisode?.episode;
  if (Number.isInteger(nextEpisode) && (nextEpisode || 0) > 1) {
    return { count: (nextEpisode || 0) - 1, source: "anilistAiring" };
  }
  if (media.nextAiringEpisode) return {};
  return {};
}

function deriveAnikotoEpisodeCount(record: {
  episodes?: number | string;
  next_air_ep?: number | string | null;
  status?: string;
}): {
  count?: number;
  source?: "anikoto" | "anikotoAiring";
} {
  const nextEpisode = Number(record.next_air_ep);
  if (Number.isInteger(nextEpisode) && nextEpisode > 1) {
    return { count: nextEpisode - 1, source: "anikotoAiring" };
  }
  if (record.next_air_ep != null) return {};
  const count = Number(record.episodes);
  if (Number.isInteger(count) && count > 0) {
    return { count, source: "anikoto" };
  }
  return {};
}

interface AniListMedia {
  id: number;
  idMal?: number;
  title: { english?: string; romaji?: string; native?: string };
  coverImage: { large?: string; medium?: string };
  averageScore?: number;
  seasonYear?: number;
  startDate?: { year?: number };
  isAdult?: boolean;
  format?: string;
  status?: string;
  episodes?: number;
  nextAiringEpisode?: { episode?: number };
}

interface AniListResponse {
  data?: { Page?: { media?: AniListMedia[] } };
}

interface KitsuAnimeResource {
  id: string;
  attributes?: {
    canonicalTitle?: string;
    titles?: Record<string, string>;
    startDate?: string;
    subtype?: string;
    averageRating?: string;
    episodeCount?: number;
    posterImage?: { large?: string; medium?: string };
  };
  relationships?: {
    mappings?: { data?: Array<{ id: string }> };
  };
}

interface KitsuMappingResource {
  id: string;
  attributes?: {
    externalSite?: string;
    externalId?: string;
  };
}

interface KitsuAnimeResponse {
  data?: KitsuAnimeResource[];
  included?: KitsuMappingResource[];
}

function kitsuResourceToAnime(
  resource: KitsuAnimeResource,
  mappings: Map<string, KitsuMappingResource>,
): AnimeEntry | null {
  const attributes = resource.attributes;
  const poster =
    attributes?.posterImage?.large || attributes?.posterImage?.medium || "";
  if (!poster) return null;
  const titles = attributes?.titles || {};
  const title =
    titles.en ||
    titles.en_us ||
    attributes?.canonicalTitle ||
    titles.en_jp ||
    titles.ja_jp ||
    "unknown";
  const year = Number.parseInt(attributes?.startDate?.slice(0, 4) || "", 10);
  const rating = Number.parseFloat(attributes?.averageRating || "");
  const ids = normalizeAnimeIds({ kitsu: resource.id });
  for (const mappingRef of resource.relationships?.mappings?.data || []) {
    const mapping = mappings.get(mappingRef.id);
    const site = mapping?.attributes?.externalSite?.toLowerCase();
    const id = mapping?.attributes?.externalId;
    if (!id) continue;
    if (site === "anilist/anime") ids.anilist ||= id;
    if (site === "myanimelist/anime") ids.mal ||= id;
  }
  return {
    id: resource.id,
    title,
    year: Number.isFinite(year) ? year : undefined,
    posterUrl: `/!cover!/${encodeMochiUrl(poster)}/`,
    posterSmallUrl: attributes?.posterImage?.medium
      ? `/!cover!/${encodeMochiUrl(attributes.posterImage.medium)}/`
      : undefined,
    rating: normalizeAnimeRating(rating),
    animeType: "anime",
    category: classifyAnimeCategory(attributes?.subtype, title),
    ids,
    anilistId: ids.anilist ? Number(ids.anilist) : undefined,
    malId: ids.mal ? Number(ids.mal) : undefined,
    format: attributes?.subtype?.toUpperCase(),
    episodeCount: attributes?.episodeCount,
    _metadataSource: "kitsu",
    _episodeCountSource: attributes?.episodeCount != null ? "kitsu" : undefined,
    _normalizedTitle: normalizeCatalogText(title),
    _searchText: normalizeCatalogText(
      [title, titles.en, titles.en_jp, titles.ja_jp]
        .filter(Boolean)
        .join(" "),
    ),
  };
}

async function fetchKitsuAnimeList(
  url: string,
  signal?: AbortSignal,
): Promise<AnimeEntry[]> {
  const requestInit: RequestInit = {};
  if (signal) requestInit.signal = signal;
  const response = await fetch(`/!!/${encodeMochiUrl(url)}/`, requestInit);
  if (!response.ok) {
    throw new RequestError("anime catalog request failed", {
      code: "ANIME_CATALOG_UNAVAILABLE",
      status: response.status,
    });
  }
  const json = (await response.json()) as KitsuAnimeResponse;
  const mappings = new Map(
    (json.included || []).map((mapping) => [mapping.id, mapping]),
  );
  return (json.data || [])
    .map((resource) => kitsuResourceToAnime(resource, mappings))
    .filter((entry): entry is AnimeEntry => entry !== null);
}

export interface AnimeEpisodeMapping {
  number: number;
  title?: string;
  anikotoEpisodeId?: string;
  languages: Array<"sub" | "dub">;
}

interface AnikotoAnimeRecord {
  id?: string | number;
  title?: string;
  alternative?: string;
  titles?: string;
  native?: string;
  poster?: string;
  background_image?: string;
  year?: number | string;
  episodes?: number | string;
  score?: number | string;
  status?: string;
  next_air_ep?: number | string | null;
  mal_id?: number | string;
  ani_id?: number | string;
  terms_by_type?: { type?: string[] };
}

interface AnikotoRecentResponse {
  data?: AnikotoAnimeRecord[];
}

interface AnikotoEpisodeRecord {
  number?: number | string;
  title?: string;
  episode_embed_id?: string | number;
  embed_url?: Record<string, string>;
}

interface AnikotoSeriesResponse {
  data?: { episodes?: AnikotoEpisodeRecord[] };
}

const ANILIST_URL = `/!!/${encodeMochiUrl("https://graphql.anilist.co")}/`;
const ANIKOTO_API_URL = "https://anikotoapi.site";
const KITSU_API_URL = "https://kitsu.io/api/edge";
const ANILIST_MEDIA_FIELDS = `
  id
  idMal
  title { english romaji native }
  coverImage { large medium }
  averageScore
  seasonYear
  startDate { year }
  isAdult
  format
  status
  episodes
  nextAiringEpisode { episode }
`;
type AnimeFeedSubscriber = (anime: AnimeEntry[]) => void;

interface AnimeFeedRequest {
  promise: Promise<AnimeEntry[]>;
  latest: AnimeEntry[];
  subscribers: Set<AnimeFeedSubscriber>;
}

const animeFeedRequests = new Map<string, AnimeFeedRequest>();
let animeFeedGeneration = 0;
const sortedAnimePromises = new Map<string, Promise<AnimeEntry[]>>();
const searchAnimePromises = new Map<string, Promise<AnimeEntry[]>>();
const anikotoRecentCache = new Map<
  string,
  { expiresAt: number; entries: AnimeEntry[] }
>();
const anikotoRecentPromises = new Map<string, Promise<AnimeEntry[]>>();
const anikotoSeriesCache = new Map<
  string,
  { expiresAt: number; episodes: AnimeEpisodeMapping[] }
>();
const anikotoSeriesPromises = new Map<
  string,
  Promise<AnimeEpisodeMapping[]>
>();
const ANIME_FEED_CACHE_KEY_PREFIX = "lyra-anime-feed-entries";
const ANIME_SEARCH_CACHE_KEY_PREFIX = "lyra-anime-search-entries";
const ANIME_EPISODE_CACHE_KEY_PREFIX = "lyra-anime-episode-count";
const ANIME_FEED_CACHE_TTL_MS = 30 * 60 * 1000;
const ANIKOTO_RECENT_CACHE_TTL_MS = 30 * 60 * 1000;
const ANIKOTO_SERIES_CACHE_TTL_MS = 10 * 60 * 1000;

interface StoredAnimeFeed {
  anime: AnimeEntry[];
  expiresAt: number;
}

function getAdultAllowed(): boolean {
  return (
    typeof localStorage !== "undefined" &&
    localStorage.getItem("animeAdultContent") === "true"
  );
}

function getAudienceCacheKey(): string {
  return getAdultAllowed() ? "adult" : "safe";
}

function mediaToAnimeEntry(media: AniListMedia): AnimeEntry | null {
  const imageUrl = media.coverImage?.large || media.coverImage?.medium || "";
  if (!imageUrl) return null;
  if (!getAdultAllowed() && media.isAdult) return null;

  const title =
    media.title?.english ||
    media.title?.romaji ||
    media.title?.native ||
    "unknown";
  const titleSearchText = normalizeCatalogText(
    [media.title?.english, media.title?.romaji, media.title?.native]
      .filter(Boolean)
      .join(" "),
  );
  const aniListEpisodeData = deriveAniListEpisodeCount(media);
  const entry: AnimeEntry = {
    id: media.id,
    title,
    year: media.startDate?.year || media.seasonYear,
    _metadataSource: "anilist",
    posterUrl: `/!cover!/${encodeMochiUrl(imageUrl)}/`,
    posterSmallUrl: media.coverImage?.medium
      ? `/!cover!/${encodeMochiUrl(media.coverImage.medium)}/`
      : undefined,
    rating: normalizeAnimeRating(media.averageScore),
    animeType: "anime",
    category: classifyAnimeCategory(media.format, title),
    adult: media.isAdult ?? false,
    ids: normalizeAnimeIds({
      anilist: media.id,
      mal: media.idMal,
    }),
    anilistId: media.id,
    malId: media.idMal,
    format: media.format,
    episodeCount: aniListEpisodeData.count,
    _episodeCountSource: aniListEpisodeData.source,
    _normalizedTitle: normalizeCatalogText(title),
    _searchText: titleSearchText,
  };
  return entry;
}

async function fetchAniListEntries(
  query: string,
  variables: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<AnimeEntry[]> {
  const requestInit: RequestInit = {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  };
  if (signal) requestInit.signal = signal;
  const response = await fetch(ANILIST_URL, requestInit);
  if (!response.ok) {
    throw new RequestError("anime catalog request failed", {
      code: "ANIME_CATALOG_UNAVAILABLE",
      status: response.status,
    });
  }

  const payload = (await response.json()) as AniListResponse;
  return (payload.data?.Page?.media || [])
    .map(mediaToAnimeEntry)
    .filter((entry): entry is AnimeEntry => entry !== null);
}

async function fetchKitsuEntries(
  query: string,
  signal?: AbortSignal,
): Promise<AnimeEntry[]> {
  const url =
    `${KITSU_API_URL}/anime?filter[text]=${encodeURIComponent(query)}` +
    "&page[limit]=20&include=mappings";
  return fetchKitsuAnimeList(url, signal);
}

async function fetchKitsuTrendingEntries(
  signal?: AbortSignal,
): Promise<AnimeEntry[]> {
  const url =
    `${KITSU_API_URL}/anime?filter[status]=current&sort=-userCount` +
    "&page[limit]=20&include=mappings";
  return fetchKitsuAnimeList(url, signal);
}

function parseProviderNumber(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function parseEpisodeNumber(value: unknown, title = ""): number | undefined {
  const parsed = Number(value);
  if (Number.isInteger(parsed) && parsed >= 0) return parsed;
  const match = title.match(/\b(?:episode|ep\.?|e)\s*0*(\d+)\b/i);
  if (!match) return undefined;
  const fallback = Number(match[1]);
  return Number.isInteger(fallback) && fallback >= 0 ? fallback : undefined;
}

function splitAnikotoTitles(value?: string): string[] {
  return (value || "")
    .split(/[;\n]/)
    .map((title) => title.trim())
    .filter(Boolean);
}

function anikotoRecordToAnime(record: AnikotoAnimeRecord): AnimeEntry | null {
  const anikotoId = parseProviderNumber(record.id);
  const imageUrl = record.poster || record.background_image || "";
  const title = record.title?.trim() || splitAnikotoTitles(record.titles)[0];
  if (!anikotoId || !imageUrl || !title) return null;

  const titleVariants = [
    title,
    record.alternative,
    record.titles,
    record.native,
  ]
    .flatMap((value) => splitAnikotoTitles(value))
    .filter(Boolean);
  const ids = normalizeAnimeIds({
    anikoto: anikotoId,
    anilist: parseProviderNumber(record.ani_id),
    mal: parseProviderNumber(record.mal_id),
  });
  const year = parseProviderNumber(record.year);
  const episodeData = deriveAnikotoEpisodeCount(record);
  const format = record.terms_by_type?.type?.[0]?.toUpperCase();

  return {
    id: `anikoto:${anikotoId}`,
    title,
    year,
    posterUrl: `/!cover!/${encodeMochiUrl(imageUrl)}/`,
    backdropUrl: record.background_image
      ? `/!cover!/${encodeMochiUrl(record.background_image)}/`
      : undefined,
    animeType: "anime",
    category: classifyAnimeCategory(format, title),
    ids,
    anilistId: ids.anilist ? Number(ids.anilist) : undefined,
    malId: ids.mal ? Number(ids.mal) : undefined,
    format,
    rating: normalizeAnimeRating(record.score),
    episodeCount: episodeData.count,
    _episodeCountSource: episodeData.source,
    _normalizedTitle: normalizeCatalogText(title),
    _searchText: normalizeCatalogText(titleVariants.join(" ")),
  };
}

async function fetchAnikotoRecentEntries(
  signal?: AbortSignal,
): Promise<AnimeEntry[]> {
  const cacheKey = getAudienceCacheKey();
  const cached = anikotoRecentCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.entries;
  if (cached) anikotoRecentCache.delete(cacheKey);
  const existing = anikotoRecentPromises.get(cacheKey);
  if (existing) return existing;

  const url = `${ANIKOTO_API_URL}/recent-anime?page=1&per_page=50`;
  const requestInit: RequestInit = {};
  if (signal) requestInit.signal = signal;
  const promise = fetch(`/!!/${encodeMochiUrl(url)}/`, requestInit)
    .then(async (response) => {
      if (!response.ok) {
        throw new RequestError("recent anime request failed", {
          code: "ANIME_RECENT_UNAVAILABLE",
          status: response.status,
        });
      }
      const payload = (await response.json()) as AnikotoRecentResponse;
      return (payload.data || [])
        .map(anikotoRecordToAnime)
        .filter((entry): entry is AnimeEntry => entry !== null);
    })
    .then((entries) => {
      anikotoRecentCache.set(cacheKey, {
        entries,
        expiresAt: Date.now() + ANIKOTO_RECENT_CACHE_TTL_MS,
      });
      return entries;
    })
    .catch((error) => {
      anikotoRecentPromises.delete(cacheKey);
      throw error;
    })
    .finally(() => {
      anikotoRecentPromises.delete(cacheKey);
    });
  anikotoRecentPromises.set(cacheKey, promise);
  return promise;
}

export async function fetchAnikotoEpisodes(
  ids: AnimeIds | undefined,
  signal?: AbortSignal,
): Promise<AnimeEpisodeMapping[]> {
  const anikotoId = normalizeAnimeIds(ids).anikoto;
  if (!anikotoId) return [];
  const cached = anikotoSeriesCache.get(anikotoId);
  if (cached && cached.expiresAt > Date.now()) return cached.episodes;
  if (cached) anikotoSeriesCache.delete(anikotoId);
  const existing = anikotoSeriesPromises.get(anikotoId);
  if (existing) return existing;

  const url = `${ANIKOTO_API_URL}/series/${encodeURIComponent(anikotoId)}`;
  const requestInit: RequestInit = {};
  if (signal) requestInit.signal = signal;
  const promise = fetch(`/!!/${encodeMochiUrl(url)}/`, requestInit)
    .then(async (response) => {
      if (!response.ok) {
        throw new RequestError("anime episode request failed", {
          code: "ANIME_EPISODES_UNAVAILABLE",
          status: response.status,
        });
      }
      const payload = (await response.json()) as AnikotoSeriesResponse;
      return (payload.data?.episodes || [])
        .map((episode): AnimeEpisodeMapping | null => {
          const number = parseEpisodeNumber(episode.number, episode.title);
          if (number == null) return null;
          const episodeId = parseProviderNumber(episode.episode_embed_id);
          const languages = Object.keys(episode.embed_url || {}).filter(
            (language): language is "sub" | "dub" =>
              language === "sub" || language === "dub",
          );
          const mapping: AnimeEpisodeMapping = { number, languages };
          if (episode.title) mapping.title = episode.title;
          if (episodeId) mapping.anikotoEpisodeId = String(episodeId);
          return mapping;
        })
        .filter((episode): episode is AnimeEpisodeMapping => episode !== null)
        .sort((a, b) => a.number - b.number);
    })
    .then((episodes) => {
      anikotoSeriesCache.set(anikotoId, {
        episodes,
        expiresAt: Date.now() + ANIKOTO_SERIES_CACHE_TTL_MS,
      });
      return episodes;
    })
    .catch((error) => {
      anikotoSeriesPromises.delete(anikotoId);
      throw error;
    })
    .finally(() => {
      anikotoSeriesPromises.delete(anikotoId);
    });
  anikotoSeriesPromises.set(anikotoId, promise);
  return promise;
}

async function fetchKitsuEpisodeCount(kitsuId: string): Promise<number> {
  const url = `${KITSU_API_URL}/anime/${encodeURIComponent(kitsuId)}`;
  const response = await fetch(`/!!/${encodeMochiUrl(url)}/`);
  if (!response.ok) return 0;
  const payload = (await response.json()) as { data?: KitsuAnimeResource };
  const count = payload.data?.attributes?.episodeCount;
  return Number.isInteger(count) && (count || 0) > 0 ? count! : 0;
}

function formatsCanShareTitle(
  left?: string,
  right?: string,
): boolean {
  const a = left?.toUpperCase();
  const b = right?.toUpperCase();
  if (!a || !b || a === b) return true;
  return [a, b].every((format) => format === "TV" || format === "TV_SHORT");
}

function seasonNumberFromTitle(title: string): number | undefined {
  const match = title.match(
    /(?:season|series)\s+(\d+)|\b(\d+)(?:st|nd|rd|th)\s+season\b/i,
  );
  const explicitNumber = Number(match?.[1] || match?.[2]);
  if (Number.isInteger(explicitNumber) && explicitNumber > 0) {
    return explicitNumber;
  }

  
  
  if (/\b(?:part|cour)\s*\d+\b/i.test(title)) return undefined;

  
  
  
  const trailingNumber = title.match(/\s([2-9]|1[0-2])\s*$/i);
  const number = Number(trailingNumber?.[1]);
  return Number.isInteger(number) && number > 0 ? number : undefined;
}

const SEASON_ID_PROVIDERS = ["mal", "anilist", "kitsu", "anidb", "anikoto"] as const;

function conflictingSeasonIds(left: AnimeIds, right: AnimeIds): boolean {
  return SEASON_ID_PROVIDERS.some((provider) =>
    left[provider] && right[provider] && left[provider] !== right[provider],
  );
}

function sharedProviderIdentity(left: AnimeEntry, right: AnimeEntry): boolean {
  const leftIds = normalizeAnimeIds({
    ...left.ids,
    anilistId: left.anilistId,
    malId: left.malId,
  });
  const rightIds = normalizeAnimeIds({
    ...right.ids,
    anilistId: right.anilistId,
    malId: right.malId,
  });
  if (conflictingSeasonIds(leftIds, rightIds)) return false;
  return SEASON_ID_PROVIDERS.some((provider) => leftIds[provider] && leftIds[provider] === rightIds[provider]);
}

function metadataRank(entry: AnimeEntry): number {
  return { jikan: 4, anilist: 3, kitsu: 2, anikoto: 1 }[entry._metadataSource || "anikoto"];
}

function mergeSeasonMetadata(existing: AnimeEntry, incoming: AnimeEntry): void {
  const preferIncoming = metadataRank(incoming) > metadataRank(existing);
  if (preferIncoming || existing.year == null) existing.year = incoming.year ?? existing.year;
  if (preferIncoming || !existing.format) existing.format = incoming.format || existing.format;
  if (preferIncoming) {
    existing.title = incoming.title;
    existing.category = incoming.category;
    existing._metadataSource = incoming._metadataSource;
  }
}

function mergeEpisodeCount(
  existing: AnimeEntry,
  incoming: AnimeEntry,
  incomingIds: AnimeIds,
): void {
  const incomingCount = incoming.episodeCount;
  if (!Number.isInteger(incomingCount) || !incomingCount || incomingCount < 1) return;
  const existingCount = existing.episodeCount || 0;
  const incomingSource =
    incoming._episodeCountSource ||
    (incomingIds.anikoto ? "anikoto" : undefined);
  const existingRank = episodeCountSourceRank(
    existing._episodeCountSource,
  );
  const incomingRank = episodeCountSourceRank(
    incomingSource,
  );
  if (!existingCount || incomingRank > existingRank) {
    existing.episodeCount = incomingCount;
    existing._episodeCountSource = incomingSource;
    return;
  }
  if (incomingRank === existingRank) {
    existing.episodeCount = Math.max(existingCount, incomingCount);
  }
}

function episodeCountSourceRank(
  source: AnimeEntry["_episodeCountSource"],
): number {
  if (source === "jikan") return 6;
  if (source === "anilist") return 5;
  if (source === "kitsu") return 4;
  if (source === "anikoto") return 3;
  if (source === "anilistAiring") return 2;
  if (source === "anikotoAiring") return 1;
  return 0;
}

export function mergeAnimeEntries(
  ...groups: ReadonlyArray<AnimeEntry>[]
): AnimeEntry[] {
  const entries: AnimeEntry[] = [];
  for (const entry of groups.flat()) {
    const ids = normalizeAnimeIds({
      ...entry.ids,
      anilistId: entry.anilistId,
      malId: entry.malId,
    });
    const existing = entries.find((candidate) =>
      sharedProviderIdentity(candidate, entry) ||
      (normalizeCatalogText(candidate.title) === normalizeCatalogText(entry.title) &&
        formatsCanShareTitle(candidate.format, entry.format) &&
        !conflictingSeasonIds(candidate.ids || {}, ids) &&
        (candidate.year || 0) === (entry.year || 0)),
    );
    if (!existing) {
      const individual = { ...entry, ids };
      delete individual.seasons;
      entries.push(individual);
      continue;
    }
    mergeEpisodeCount(existing, entry, ids);
    existing.ids = mergeAnimeIds(existing.ids, ids);
    existing._searchText = normalizeCatalogText(
      [existing._searchText, existing.title, entry._searchText, entry.title].filter(Boolean).join(" "),
    );
    mergeSeasonMetadata(existing, entry);
    existing.anilistId ||= ids.anilist ? Number(ids.anilist) : undefined;
    existing.malId ||= ids.mal ? Number(ids.mal) : undefined;
    existing.posterUrl ||= entry.posterUrl;
    existing.posterSmallUrl ||= entry.posterSmallUrl;
    existing.backdropUrl ||= entry.backdropUrl;
    existing.rating ??= entry.rating;
  }
  return applySearchFields(entries);
}

function fetchAniListSorted(sort: "TRENDING_DESC" | "POPULARITY_DESC") {
  const cacheKey = `${sort}:${getAudienceCacheKey()}`;
  const cached = sortedAnimePromises.get(cacheKey);
  if (cached) return cached;

  const query = `
    query ($page: Int) {
      Page(page: $page, perPage: 50) {
        media(sort: ${sort}, type: ANIME) {
          ${ANILIST_MEDIA_FIELDS}
        }
      }
    }
  `;

  const promise = fetchAniListEntries(query, { page: 1 }).catch((err) => {
    sortedAnimePromises.delete(cacheKey);
    throw err;
  });
  sortedAnimePromises.set(cacheKey, promise);
  return promise;
}

async function fetchTrendingAnimeEntries(): Promise<AnimeEntry[]> {
  const anilistTrending = await fetchAniListSorted("TRENDING_DESC").catch(
    () => [] as AnimeEntry[],
  );
  if (anilistTrending.length > 0) return anilistTrending;
  return fetchKitsuTrendingEntries().catch(() => [] as AnimeEntry[]);
}

function getCacheKey(category: AnimeCategory): Promise<string> {
  return cacheKey(
    ANIME_FEED_CACHE_KEY_PREFIX,
    import.meta.url,
    `${category}-${getAudienceCacheKey()}`,
  );
}

function applySearchFields(anime: AnimeEntry[]): AnimeEntry[] {
  for (const a of anime) {
    a.ids = normalizeAnimeIds({
      ...a.ids,
      anilistId: a.anilistId,
      malId: a.malId,
    });
    a._normalizedTitle = normalizeCatalogText(a.title || "");
    a._searchText ||= a._normalizedTitle;
  }
  return anime;
}

export function searchAnimeLocally(
  anime: readonly AnimeEntry[],
  query: string,
): AnimeEntry[] {
  const normalizedQuery = normalizeCatalogText(query);
  if (!normalizedQuery) return anime as AnimeEntry[];

  const tokens = normalizedQuery.split(" ");
  const ranked: AnimeEntry[][] = [[], [], [], [], []];
  for (const entry of anime) {
    const rank = catalogMatchRank(
      entry._normalizedTitle ?? normalizeCatalogText(entry.title),
      entry._searchText || "",
      normalizedQuery,
      tokens,
    );
    if (rank >= 0) ranked[rank]!.push(entry);
  }
  return ranked.flat();
}

function filterAnimeSearchResults(
  anime: readonly AnimeEntry[],
  query: string,
): AnimeEntry[] {
  const normalizedQuery = normalizeCatalogText(query);
  if (!normalizedQuery) return anime as AnimeEntry[];
  const tokens = normalizedQuery.split(" ");
  return anime.filter(
    (entry) =>
      catalogMatchRank(
        entry._normalizedTitle ?? normalizeCatalogText(entry.title),
        entry._searchText || "",
        normalizedQuery,
        tokens,
      ) >= 0,
  );
}

function saveToCacheKey(cacheKey: string, anime: AnimeEntry[]): AnimeEntry[] {
  try {
    const stored: StoredAnimeFeed = {
      anime,
      expiresAt: Date.now() + ANIME_FEED_CACHE_TTL_MS,
    };
    localStorage.setItem(cacheKey, JSON.stringify(stored));
  } catch {
    
  }
  return anime;
}

export async function fetchAnimeData(
  category: AnimeCategory,
  onUpdate?: AnimeFeedSubscriber,
): Promise<AnimeEntry[]> {
  const generation = animeFeedGeneration;
  const cacheKey = await getCacheKey(category);
  if (generation !== animeFeedGeneration) return [];
  try {
    const cached = localStorage.getItem(cacheKey);
    if (cached) {
      const stored = JSON.parse(cached) as StoredAnimeFeed;
      if (
        stored.expiresAt > Date.now() &&
        Array.isArray(stored.anime) &&
        stored.anime.length > 0
      ) {
        const anime = applySearchFields(stored.anime);
        try {
          onUpdate?.(anime);
        } catch {}
        return anime;
      }
      localStorage.removeItem(cacheKey);
    }
  } catch {}

  const inFlight = animeFeedRequests.get(cacheKey);
  if (inFlight) {
    if (inFlight.latest.length > 0) {
      try {
        onUpdate?.(inFlight.latest);
      } catch {}
    }
    if (!onUpdate) return inFlight.promise;
    inFlight.subscribers.add(onUpdate);
    return inFlight.promise.finally(() => {
      inFlight.subscribers.delete(onUpdate);
    });
  }

  const request: AnimeFeedRequest = {
    promise: Promise.resolve([]),
    latest: [],
    subscribers: new Set(onUpdate ? [onUpdate] : []),
  };

  const promise = (async () => {
    let providers: Array<() => Promise<AnimeEntry[]>>;

    switch (category) {
      case "trending":
        providers = [fetchTrendingAnimeEntries, fetchAnikotoRecentEntries];
        break;
      case "anime":
        providers = [
          fetchTrendingAnimeEntries,
          () => fetchAniListSorted("POPULARITY_DESC"),
          fetchAnikotoRecentEntries,
        ];
        break;
      default:
        providers = [];
    }

    const providerResults: Array<AnimeEntry[] | undefined> = Array.from({
      length: providers.length,
    });
    await Promise.all(
      providers.map((fetchProvider, index) =>
        fetchProvider()
          .catch(() => [] as AnimeEntry[])
          .then((anime) => {
            if (generation !== animeFeedGeneration) return;
            providerResults[index] = anime;
            if (anime.length === 0) return;
            request.latest = applySearchFields(
              mergeAnimeEntries(
                ...providerResults.map((results) => results || []),
              ),
            );
            for (const subscriber of request.subscribers) {
              try {
                subscriber(request.latest);
              } catch {}
            }
          }),
      ),
    );

    const anime = request.latest;
    if (generation !== animeFeedGeneration) return [];
    return anime.length > 0 ? saveToCacheKey(cacheKey, anime) : anime;
  })().finally(() => {
    if (animeFeedRequests.get(cacheKey) === request) {
      animeFeedRequests.delete(cacheKey);
    }
  });

  request.promise = promise;
  animeFeedRequests.set(cacheKey, request);
  return promise.finally(() => {
    if (onUpdate) request.subscribers.delete(onUpdate);
  });
}

export async function searchAnime(
  query: string,
  signal?: AbortSignal,
  onUpdate?: (results: AnimeEntry[]) => void,
  options: { forceRefresh?: boolean } = {},
): Promise<AnimeEntry[]> {
  const trimmed = query.trim();
  if (!trimmed) return [];
  const forceRefresh = options.forceRefresh === true;

  const searchCacheKey = await cacheKey(
    ANIME_SEARCH_CACHE_KEY_PREFIX,
    import.meta.url,
    `${getAudienceCacheKey()}-${trimmed.toLowerCase()}`,
  );
  try {
    if (!forceRefresh && typeof sessionStorage !== "undefined") {
      const cached = sessionStorage.getItem(searchCacheKey);
      if (cached) {
        const stored = JSON.parse(cached) as { expiresAt?: number; results?: AnimeEntry[] };
        if ((stored.expiresAt || 0) > Date.now() && Array.isArray(stored.results)) {
          const results = applySearchFields(stored.results);
          onUpdate?.(results);
          return results;
        }
      }
    }
  } catch {
    
  }

  const inFlight = searchAnimePromises.get(searchCacheKey);
  if (inFlight && !forceRefresh && !signal && !onUpdate) return inFlight;

  const anilistQuery = `
    query ($search: String) {
      Page(page: 1, perPage: 25) {
        media(search: $search, type: ANIME) {
          ${ANILIST_MEDIA_FIELDS}
        }
      }
    }
  `;

  let results: AnimeEntry[] = [];
  let providersCompleted = 0;
  const publish = (providerResults: AnimeEntry[]) => {
    if (signal?.aborted) return;
    const filtered = filterAnimeSearchResults(providerResults, trimmed);
    results = applySearchFields(mergeAnimeEntries(results, filtered));
    onUpdate?.(results);
  };

  const promise = Promise.all([
    fetchAniListEntries(anilistQuery, { search: trimmed }, signal)
      .then((providerResults) => publish(providerResults))
      .catch((error) => {
        if (signal?.aborted) throw error;
      })
      .then(() => {
        providersCompleted += 1;
      }),
    fetchKitsuEntries(trimmed, signal)
      .then((providerResults) => publish(providerResults))
      .catch((error) => {
        if (signal?.aborted) throw error;
      })
      .then(() => {
        providersCompleted += 1;
      }),
  ])
    .then(() => {
  if (signal?.aborted) {
    throw new DOMException("anime request aborted... /ᐠ - ˕ -マ", "AbortError");
  }
      if (providersCompleted === 0) return [];
      try {
        if (results.length > 0 && typeof sessionStorage !== "undefined") {
          sessionStorage.setItem(searchCacheKey, JSON.stringify({ results, expiresAt: Date.now() + METADATA_CACHE_TTL_MS }));
        }
      } catch {}
      return results;
    })
    .finally(() => {
      if (searchAnimePromises.get(searchCacheKey) === promise) {
        searchAnimePromises.delete(searchCacheKey);
      }
    });

  searchAnimePromises.set(searchCacheKey, promise);
  return promise;
}

export function resetAnimeCache(): void {
  animeFeedGeneration += 1;
  for (const request of animeFeedRequests.values()) {
    request.subscribers.clear();
  }
  animeFeedRequests.clear();
  sortedAnimePromises.clear();
  searchAnimePromises.clear();
  anikotoRecentCache.clear();
  anikotoRecentPromises.clear();
  anikotoSeriesCache.clear();
  anikotoSeriesPromises.clear();
  _jikanEpsCache.clear();
  _jikanEpsPromises.clear();
  resetAnimeIdentityCache();
  try {
    for (const key of Object.keys(sessionStorage)) {
      if (key.startsWith("lyra-anime-")) sessionStorage.removeItem(key);
    }
    for (const key of Object.keys(localStorage)) {
      if (key.startsWith("lyra-anime-feed-")) localStorage.removeItem(key);
    }
  } catch {
    
  }
}

const METADATA_CACHE_TTL_MS = 10 * 60 * 1000;
const _jikanEpsCache = new Map<string, { count: number; expiresAt: number }>();
const _jikanEpsPromises = new Map<string, Promise<number>>();

async function fetchIdentityEpisodeCount(ids: AnimeIds): Promise<number> {
  if (ids.mal) {
    try {
      const response = await fetch(`/api/anime/episodes/${encodeURIComponent(ids.mal)}?count_only=true`, {
        signal: AbortSignal.timeout(20_000),
      });
      if (response.ok) {
        const payload = await response.json() as { count?: number };
        if (Number.isInteger(payload.count) && (payload.count || 0) > 0) return payload.count!;
      }
    } catch {}
    return 0;
  }
  if (ids.anikoto) {
    const episodes = await fetchAnikotoEpisodes(ids).catch(() => []);
    if (episodes.length > 0) {
      return Math.max(1, ...episodes.map((episode) => episode.number));
    }
  }

  if (ids.kitsu) {
    const count = await fetchKitsuEpisodeCount(ids.kitsu).catch(() => 0);
    if (count > 0) return count;
  }

  const response = await fetch("/api/anime/identity/resolve", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ids }),
  });
  if (!response.ok) return 0;
  const identity = (await response.json()) as { episodes?: number };
  return Number.isInteger(identity.episodes) && (identity.episodes || 0) > 0
    ? identity.episodes || 0
    : 0;
}

export function chooseEpisodeCount(
  knownCount?: number,
  resolvedCount?: number,
): number {
  const known = Number.isInteger(knownCount) && (knownCount || 0) > 0
    ? knownCount || 0
    : 0;
  const resolved = Number.isInteger(resolvedCount) && (resolvedCount || 0) > 0
    ? resolvedCount || 0
    : 0;
  return resolved || known;
}

export async function fetchAnimeEpisodeCount(
  input: number | AnimeIds,
): Promise<number> {
  const ids = normalizeAnimeIds(
    typeof input === "number" ? { mal: input } : input,
  );
  const episodeIdentityKey = `identity:${JSON.stringify(Object.entries(ids).sort())}`;
  const cached = _jikanEpsCache.get(episodeIdentityKey);
  if (cached && cached.expiresAt > Date.now()) return cached.count;

  const storageKey = await cacheKey(
    ANIME_EPISODE_CACHE_KEY_PREFIX,
    import.meta.url,
    episodeIdentityKey,
  );
  try {
    const stored = JSON.parse(sessionStorage.getItem(storageKey) || "null") as { count?: number; expiresAt?: number } | null;
    if (stored && Number.isInteger(stored.count) && (stored.count || 0) > 0 && (stored.expiresAt || 0) > Date.now()) {
      const value = { count: stored.count!, expiresAt: stored.expiresAt! };
      _jikanEpsCache.set(episodeIdentityKey, value);
      return value.count;
    }
  } catch {}

  const inFlight = _jikanEpsPromises.get(episodeIdentityKey);
  if (inFlight) return inFlight;

  const promise = fetchIdentityEpisodeCount(ids)
    .then((count) => {
      if (Number.isInteger(count) && count > 0) {
        const value = { count, expiresAt: Date.now() + METADATA_CACHE_TTL_MS };
        _jikanEpsCache.set(episodeIdentityKey, value);
        try {
          sessionStorage.setItem(storageKey, JSON.stringify(value));
        } catch {}
      }
      return Number.isInteger(count) && count > 0 ? count : 0;
    })
    .catch(() => 0)
    .finally(() => {
      _jikanEpsPromises.delete(episodeIdentityKey);
    });
  _jikanEpsPromises.set(episodeIdentityKey, promise);
  return promise;
}
