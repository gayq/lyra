import { memo } from "preact/compat";
import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";
import {
  buildAnimePlaybackUrl,
  chooseEpisodeCount,
  episodeNumbersForCount,
  fetchAnimeEpisodeCount,
  fetchAnikotoEpisodes,
  isAnimeMovieFormat,
  type AnimeEpisodeMapping,
  type AnimeSeason,
} from "../../features/anime/anime.ts";
import {
  hasAnimeIdentity,
  normalizeAnimeIds,
  type AnimeIds,
} from "../../features/anime/animeIdentity.ts";
import { useManagedModal } from "../../core/ui/modal.ts";
import { negativeMessage } from "../../core/runtime/messages.ts";
import { svgIcon } from "../../core/ui/svgIcon.ts";
import { useVirtualGrid } from "../../hooks/useVirtualGrid.ts";
import "../../assets/styles/anime/episode-selector.css";
import "../../assets/styles/anime/episode-picker-modal.css";

const SVG_XMARK = svgIcon("IconCrossMedium");

interface EpisodePickerModalProps {
  visible: boolean;
  title: string;
  year?: number | undefined;
  type: "movie" | "tv" | "anime";
  ids?: AnimeIds | undefined;
  seasons?: AnimeSeason[] | undefined;
  seasonsLoading?: boolean | undefined;
  anilistId?: number | undefined;
  malId?: number | undefined;
  posterUrl: string;
  episodeCount?: number | undefined;
  format?: string | undefined;
  initialEpisode?: number | undefined;
  initialLanguage?: "sub" | "dub" | undefined;
  onClose: () => void;
  onPlay: (
    playerUrl: string,
    displayTitle: string,
    poster: string,
  ) => void;
}

function getStableSeasonSelection(
  seasonOptions: readonly Pick<AnimeSeason, "id" | "number">[],
  selectedSeasonId: string | number | null,
): string | number | null {
  if (
    selectedSeasonId !== null &&
    seasonOptions.some(
      (season) => String(season.id) === String(selectedSeasonId),
    )
  ) {
    return selectedSeasonId;
  }
  return (
    seasonOptions.find((season) => Number(season.number) === 1)?.id ??
    seasonOptions[0]?.id ??
    null
  );
}

function getSeasonOptionsForPicker(
  seasonsLoading: boolean,
  seasons?: readonly AnimeSeason[],
): AnimeSeason[] {
  if (seasonsLoading) return [];
  const seen = new Set<string>();
  return (seasons || [])
    .filter((season) => {
      if (isAnimeMovieFormat(season.format)) return false;
      const key = String(season.id);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((left, right) => {
      const leftNumber = Number(left.number);
      const rightNumber = Number(right.number);
      const hasLeftNumber = Number.isFinite(leftNumber);
      const hasRightNumber = Number.isFinite(rightNumber);
      if (hasLeftNumber && hasRightNumber && leftNumber !== rightNumber) {
        return leftNumber - rightNumber;
      }
      if (hasLeftNumber !== hasRightNumber) return hasLeftNumber ? -1 : 1;
      return 0;
    });
}

function getEpisodeNumbersForPicker(
  loadingEpisodes: boolean,
  anikotoEpisodes: readonly Pick<AnimeEpisodeMapping, "number">[],
  hasMultipleParts: boolean,
  maxEpisode: number,
  initialEpisode = 0,
  episodeDataKey?: string | null,
  activeEpisodeKey?: string,
  allowStaleWhileLoading = false,
): number[] {
  const hasCurrentEpisodeData =
    activeEpisodeKey === undefined || episodeDataKey === activeEpisodeKey;
  const hasLoadedEpisodeData = anikotoEpisodes.length > 0 || maxEpisode > 0;
  const shouldShowEpisodeData =
    hasCurrentEpisodeData ||
    (allowStaleWhileLoading && loadingEpisodes && hasLoadedEpisodeData);
  const currentEpisodes = shouldShowEpisodeData ? anikotoEpisodes : [];
  const currentMaxEpisode = shouldShowEpisodeData ? maxEpisode : 0;
  const hasEpisodeData = currentEpisodes.length > 0 || currentMaxEpisode > 0;
  if (loadingEpisodes && !hasEpisodeData) return [];
  if (currentEpisodes.length > 0 && !hasMultipleParts) {
    return [...new Set(currentEpisodes.map((episode) => episode.number))].sort(
      (a, b) => a - b,
    );
  }
  return episodeNumbersForCount(currentMaxEpisode, initialEpisode);
}

const EpisodePickerModal = memo(function EpisodePickerModal({
  visible,
  title,
  year,
  ids,
  seasons,
  seasonsLoading = false,
  anilistId,
  malId,
  posterUrl,
  episodeCount,
  format,
  initialEpisode,
  initialLanguage = "sub",
  onClose,
  onPlay,
}: EpisodePickerModalProps) {
  const identityIds = useMemo(
    () =>
      normalizeAnimeIds({
        ...ids,
        anilistId,
        malId,
      }),
    [ids, anilistId, malId],
  );
  const seasonOptions = useMemo(
    () => getSeasonOptionsForPicker(seasonsLoading, seasons),
    [seasons, seasonsLoading],
  );
  const [selectedSeasonId, setSelectedSeasonId] = useState<string | number | null>(
    null,
  );
  const [isClosing, setIsClosing] = useState(false);
  const [loadingEpisodes, setLoadingEpisodes] = useState(false);
  const [anikotoEpisodes, setAnikotoEpisodes] = useState<
    AnimeEpisodeMapping[]
  >([]);
  const [maxEpisode, setMaxEpisode] = useState(0);
  const [episodeDataKey, setEpisodeDataKey] = useState<string | null>(null);
  const episodeRequestIdRef = useRef(0);
  const autoPlayedRef = useRef(0);
  const modalRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  const activeSeasonId = getStableSeasonSelection(
    seasonOptions,
    selectedSeasonId,
  );
  const selectedSeason = seasonOptions.find(
    (season) => String(season.id) === String(activeSeasonId),
  );
  const activeTitle = selectedSeason?.title || title;
  const activeYear = selectedSeason?.year ?? year;
  const activeFormat = selectedSeason?.format || format;
  const activeEpisodeCount = selectedSeason?.episodeCount ?? episodeCount;
  const activeParts = selectedSeason?.parts || [];
  const hasMultipleParts = activeParts.length > 1;
  const activeIds = useMemo(
    () => normalizeAnimeIds(selectedSeason?.ids || identityIds),
    [identityIds, selectedSeason?.ids],
  );
  const activeIdsKey = useMemo(
    () =>
      `season:${String(activeSeasonId)}|${Object.entries(activeIds)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([provider, id]) => `${provider}:${id}`)
        .join("|")}`,
    [activeIds, activeSeasonId],
  );
  const hasCurrentEpisodeData = episodeDataKey === activeIdsKey;
  const hasEpisodeData = anikotoEpisodes.length > 0 || maxEpisode > 0;
  const canShowStaleEpisodeData =
    !hasCurrentEpisodeData &&
    hasEpisodeData &&
    (loadingEpisodes || hasAnimeIdentity(activeIds));
  const currentAnikotoEpisodes =
    hasCurrentEpisodeData || canShowStaleEpisodeData ? anikotoEpisodes : [];
  const currentMaxEpisode =
    hasCurrentEpisodeData || canShowStaleEpisodeData ? maxEpisode : 0;
  const currentLoadingEpisodes = hasCurrentEpisodeData
    ? loadingEpisodes
    : hasAnimeIdentity(activeIds);

  const { modalStateClass, onAnimationEnd } = useManagedModal({
    visible,
    isClosing,
    onRequestClose: () => setIsClosing(true),
    onCloseComplete: () => onCloseRef.current(),
  });

  useEffect(() => {
    if (!visible) {
      episodeRequestIdRef.current += 1;
      setIsClosing(false);
      setLoadingEpisodes(false);
      setAnikotoEpisodes([]);
      setMaxEpisode(0);
      setEpisodeDataKey(null);
      setSelectedSeasonId(null);
      autoPlayedRef.current = 0;
      return;
    }
    setSelectedSeasonId((current) =>
      getStableSeasonSelection(seasonOptions, current),
    );
  }, [visible, seasonOptions]);

  useEffect(() => {
    if (!visible) return;
    const requestId = episodeRequestIdRef.current + 1;
    episodeRequestIdRef.current = requestId;
    let cancelled = false;
    const isCurrentRequest = () =>
      !cancelled && episodeRequestIdRef.current === requestId;

    if (isAnimeMovieFormat(activeFormat)) {
      setLoadingEpisodes(false);
      setAnikotoEpisodes([]);
      setMaxEpisode(1);
      setEpisodeDataKey(activeIdsKey);
      return () => {
        cancelled = true;
      };
    }

    const knownEpisodeCount = activeEpisodeCount || initialEpisode || 0;
    const hasDirectSeries = Boolean(activeIds.anikoto);
    const hasIdentity = hasAnimeIdentity(activeIds);
    
    
    
    
    const hasUsableEpisodeData = anikotoEpisodes.length > 0 || maxEpisode > 0;
    if (!hasUsableEpisodeData) {
      setAnikotoEpisodes([]);
      setMaxEpisode(0);
      setEpisodeDataKey(null);
    }
    if (!hasIdentity) {
      setAnikotoEpisodes([]);
      setMaxEpisode(knownEpisodeCount);
      setLoadingEpisodes(false);
      setEpisodeDataKey(activeIdsKey);
      return () => {
        cancelled = true;
      };
    }
    setLoadingEpisodes(true);

    const load = async () => {
      let directEpisodes: AnimeEpisodeMapping[] = [];
      if (hasDirectSeries) {
        directEpisodes = await fetchAnikotoEpisodes(activeIds).catch(() => []);
        if (!isCurrentRequest()) return;
        if (directEpisodes.length > 0) {
          setAnikotoEpisodes(directEpisodes);
          setMaxEpisode(
            Math.max(
              knownEpisodeCount,
              ...directEpisodes.map((episode) => episode.number),
            ),
          );
          setEpisodeDataKey(activeIdsKey);
          setLoadingEpisodes(false);
          if (!hasMultipleParts) return;
        }
      }

      const resolvedCount = await fetchAnimeEpisodeCount(activeIds).catch(() => 0);
      if (!isCurrentRequest()) return;
      if (directEpisodes.length === 0) setAnikotoEpisodes([]);
      setMaxEpisode(chooseEpisodeCount(knownEpisodeCount, resolvedCount));
      setEpisodeDataKey(activeIdsKey);
      setLoadingEpisodes(false);
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [
    visible,
    activeSeasonId,
    activeIdsKey,
    activeEpisodeCount,
    activeFormat,
    initialEpisode,
    hasMultipleParts,
  ]);

  const playEpisode = useCallback(
    (episode: number) => {
      const mapping = currentAnikotoEpisodes.find(
        (item) => item.number === episode,
      );
      let partStart = 1;
      let playbackPart = undefined as (typeof activeParts)[number] | undefined;
      for (const part of activeParts) {
        const partCount = part.episodeCount || 0;
        if (partCount > 0 && episode >= partStart && episode < partStart + partCount) {
          playbackPart = part;
          break;
        }
        partStart += partCount;
      }
      const sourceEpisode = playbackPart
        ? episode - partStart + 1
        : episode;
      const playbackIds = playbackPart?.ids || activeIds;
      if (episode < 0 || (episode === 0 && !mapping?.anikotoEpisodeId)) return;
      onPlay(
        buildAnimePlaybackUrl({
          title: activeTitle,
          posterUrl,
          ids: mapping?.anikotoEpisodeId
            ? { ...playbackIds, anikotoEpisode: mapping.anikotoEpisodeId }
            : playbackIds,
          episode,
          sourceEpisode,
          episodeCount: currentMaxEpisode,
          year: activeYear,
          format: activeFormat,
          language: initialLanguage,
          parts: activeParts,
        }),
        activeTitle,
        posterUrl,
      );
    },
    [
      activeIds,
      activeTitle,
      posterUrl,
      activeYear,
      currentAnikotoEpisodes,
      currentMaxEpisode,
      activeFormat,
      initialLanguage,
      activeParts,
      onPlay,
    ],
  );

  useEffect(() => {
    if (
      !visible ||
      !initialEpisode ||
      autoPlayedRef.current === initialEpisode
    ) {
      return;
    }
    autoPlayedRef.current = initialEpisode;
    playEpisode(initialEpisode);
  }, [visible, initialEpisode, playEpisode]);

  const episodeNumbers = useMemo(
    () =>
      seasonsLoading
        ? []
        : getEpisodeNumbersForPicker(
            currentLoadingEpisodes,
            currentAnikotoEpisodes,
            hasMultipleParts,
            currentMaxEpisode,
            initialEpisode,
            episodeDataKey,
            activeIdsKey,
            canShowStaleEpisodeData,
          ),
    [
      activeIdsKey,
      canShowStaleEpisodeData,
      currentAnikotoEpisodes,
      currentLoadingEpisodes,
      currentMaxEpisode,
      episodeDataKey,
      hasMultipleParts,
      initialEpisode,
      seasonsLoading,
    ],
  );
  const {
    gridRef,
    range: episodeRange,
    visibleItems: visibleEpisodeNumbers,
  } = useVirtualGrid(episodeNumbers, visible, modalRef);

  if (!visible) return null;

  return (
    <div
      class={`popup episode-picker-modal ${modalStateClass}`}
      ref={modalRef}
      onAnimationEnd={onAnimationEnd}
    >
      <button
        class="modal-close-btn episode-picker-modal-close"
        type="button"
        onClick={() => setIsClosing(true)}
        dangerouslySetInnerHTML={{ __html: SVG_XMARK }}
      />
      <h2 class="episode-picker-modal-title">{title}</h2>
      <div class="episode-picker-modal-body">
        {!seasonsLoading && seasonOptions.length > 1 && (
          <div class="episode-season-tabs" role="tablist">
            {seasonOptions.map((season, index) => {
              const isActive =
                String(season.id) === String(activeSeasonId);
              return (
                <button
                  key={String(season.id)}
                  type="button"
                  role="tab"
                  aria-selected={isActive}
                  class={`episode-season-tab${isActive ? " is-active" : ""}`}
                  onClick={() => {
                    if (String(season.id) === String(activeSeasonId)) return;
                    setSelectedSeasonId(season.id);
                    setAnikotoEpisodes([]);
                    setMaxEpisode(0);
                    setEpisodeDataKey(null);
                    setLoadingEpisodes(true);
                    autoPlayedRef.current = 0;
                  }}
                >
                  Season {season.number || index + 1}
                  {season.year ? ` · ${season.year}` : ""}
                </button>
              );
            })}
          </div>
        )}
        <span class="episode-picker-modal-label">
          {seasonsLoading
            ? "finding seasons..."
            : currentLoadingEpisodes && episodeNumbers.length === 0
              ? "fetching episodes..."
              : "choose an episode"}
        </span>
        <div
          class="episode-selector-grid episode-picker-grid"
          ref={gridRef}
        >
          {episodeRange.topSpacer > 0 && (
            <div
              class="episode-picker-virtual-spacer"
              style={`height:${episodeRange.topSpacer}px`}
            />
          )}
          {!seasonsLoading &&
            visibleEpisodeNumbers.map((episode) => (
              <button
                key={episode}
                class="episode-selector-button episode-picker-btn"
                type="button"
                onClick={() => playEpisode(episode)}
              >
                {episode}
              </button>
            ))}
          {episodeRange.bottomSpacer > 0 && (
            <div
              class="episode-picker-virtual-spacer"
              style={`height:${episodeRange.bottomSpacer}px`}
            />
          )}
        </div>
        {!seasonsLoading &&
          !currentLoadingEpisodes &&
          episodeNumbers.length === 0 && (
            <p class="episode-picker-modal-empty">
              {negativeMessage("episode data unavailable")}
            </p>
          )}
      </div>
    </div>
  );
});

export default EpisodePickerModal;
