export const ANIME_SETTING_KEYS = {
  autoPlayNextEpisode: "animeAutoPlayNextEpisode",
  autoSkipIntroOutro: "animeAutoSkipIntroOutro",
} as const;

export const ANIME_QUALITY_KEY = "animePreferredQuality";
export const ANIME_QUALITY_OPTIONS = ["auto", "1080p", "720p", "360p"] as const;
export type AnimeQuality = (typeof ANIME_QUALITY_OPTIONS)[number];
const DEFAULT_ANIME_QUALITY: AnimeQuality = "auto";

const DEFAULT_ANIME_SETTINGS = {
  autoPlayNextEpisode: true,
  autoSkipIntroOutro: false,
} as const;

export type AnimeSettingName = keyof typeof ANIME_SETTING_KEYS;

export function readAnimeSetting(name: AnimeSettingName): boolean {
  const fallback = DEFAULT_ANIME_SETTINGS[name];
  try {
    const stored = localStorage.getItem(ANIME_SETTING_KEYS[name]);
    return stored === null ? fallback : stored === "true";
  } catch {
    return fallback;
  }
}

export function readAnimeQuality(): AnimeQuality {
  try {
    const stored = localStorage.getItem(ANIME_QUALITY_KEY);
    return ANIME_QUALITY_OPTIONS.includes(stored as AnimeQuality)
      ? (stored as AnimeQuality)
      : DEFAULT_ANIME_QUALITY;
  } catch {
    return DEFAULT_ANIME_QUALITY;
  }
}
