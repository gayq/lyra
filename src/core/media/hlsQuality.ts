import type { AnimeQuality } from "./animeSettings.ts";

export const PLAYER_SIZE_ABR_CONFIG = {
  capLevelToPlayerSize: true,
} as const;

interface HlsQualityController {
  currentLevel: number;
}

interface QualityLevel {
  index: number;
  height: number;
  bitrate: number;
}

export function applyQualitySelection(
  hls: HlsQualityController,
  requestedLevel: number,
  availableLevels: readonly number[],
): boolean {
  if (
    requestedLevel < -1 ||
    (requestedLevel >= 0 && !availableLevels.includes(requestedLevel))
  ) {
    return false;
  }
  hls.currentLevel = requestedLevel;
  return true;
}

export function preferredQualityLevel(
  preference: AnimeQuality,
  levels: readonly QualityLevel[],
): number {
  if (preference === "auto" || levels.length === 0) return -1;

  const targetHeight = Number.parseInt(preference, 10);
  const measured = levels.filter((level) => level.height > 0);
  if (measured.length === 0) {
    return levels.reduce((lowest, level) =>
      level.bitrate < lowest.bitrate ? level : lowest,
    ).index;
  }

  const withinTarget = measured.filter((level) => level.height <= targetHeight);
  if (withinTarget.length > 0) {
    return withinTarget.reduce((best, level) =>
      level.height > best.height ||
      (level.height === best.height && level.bitrate > best.bitrate)
        ? level
        : best,
    ).index;
  }

  return measured.reduce((lowest, level) =>
    level.height < lowest.height ||
    (level.height === lowest.height && level.bitrate < lowest.bitrate)
      ? level
      : lowest,
  ).index;
}

export function qualityMenuLabel(
  selectedLabel: string | null,
  autoLabel: string | null,
  isRequesting = false,
): string {
  if (selectedLabel !== null) {
    return isRequesting ? `requesting: ${selectedLabel}` : selectedLabel;
  }
  return autoLabel ? `auto · ${autoLabel}` : "auto";
}
