import { useState, useEffect, useCallback, useMemo, useRef } from "preact/hooks";
import { memo } from "preact/compat";
import {
  fetchGameData,
  resetGameCache,
  getGameDisplayLabel,
  gameCatalogErrorMessage,
  searchGames,
  type GameEntry,
} from "../../features/games/games.ts";
import { negativeMessage } from "../../core/runtime/messages.ts";
import { hostFromUrl, recordGameMetric } from "../../core/media/gameDiagnostics.ts";
import { gamesViewSignal } from "../../core/ui/uiSignals.ts";
import { svgIcon } from "../../core/ui/svgIcon.ts";
import { app } from "../../core/runtime/app.ts";
import { getStoredGameSource } from "../../core/config/settingsOptions.ts";
import { useMenuView } from "../../hooks/useMenuView.ts";
import CatalogView from "../catalog/CatalogView.tsx";
import CatalogImage from "../catalog/CatalogImage.tsx";
import CatalogSkeletonCard, {
  CATALOG_SKELETON_KEYS,
} from "../catalog/CatalogSkeletonCard.tsx";
import "../../assets/styles/catalog/catalog.css";
import "../../assets/styles/games/games.css";

const SVG_GAMEPAD = svgIcon("IconGamecontroller", { solid: true });
const SVG_SEARCH = svgIcon("IconMagnifyingGlass2");
const GameCard = memo(function GameCard({
  game,
  onPlay,
}: {
  game: GameEntry;
  onPlay: (game: GameEntry) => void;
}) {
  return (
    <article
      class="game-card"
      role="button"
      tabIndex={0}
      onClick={() => onPlay(game)}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onPlay(game);
        }
      }}
    >
      <CatalogImage
        className="game-cover"
        src={game.coverUrl}
        alt={game.name}
        fallbackSize={30}
      />
      <div class="game-info">
        <h1>{game.name}</h1>
      </div>
    </article>
  );
});

function renderGameSkeleton(key: string) {
  return (
    <CatalogSkeletonCard
      key={key}
      cardClassName="game-card"
      coverClassName="game-cover"
      infoClassName="game-info"
    />
  );
}

export default function GamesCatalog({
  openOnMount = false,
}: {
  openOnMount?: boolean;
}) {
  const [allGames, setAllGames] = useState<GameEntry[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  const loadGeneration = useRef(0);
  const loadGames = useCallback(() => {
    const requestGeneration = ++loadGeneration.current;
    const sourceAtStart = getStoredGameSource();
    setError(null);
    fetchGameData()
      .then((games) => {
        if (
          requestGeneration !== loadGeneration.current ||
          sourceAtStart !== getStoredGameSource()
        ) {
          return;
        }
        setAllGames(games);
        setLoaded(true);
      })
      .catch((error) => {
        if (
          requestGeneration !== loadGeneration.current ||
          sourceAtStart !== getStoredGameSource()
        ) {
          return;
        }
        setError(gameCatalogErrorMessage(error));
        setLoaded(true);
      });
  }, []);

  const loadGamesIfNeeded = useCallback(() => {
    if (!loaded || allGames.length === 0) loadGames();
  }, [allGames.length, loadGames, loaded]);

  const { visible, active, searchBarRef, show, hide, toggle } = useMenuView({
    bodyClass: "games-view",
    signal: gamesViewSignal,
    iconId: "games-icon",
    inactiveIcon: SVG_GAMEPAD,
    activeIcon: SVG_SEARCH,
    openedStorageKey: "lyraUserOpenedGameMenu",
    oppositeBodyClass: "anime-view",
    hideOpposite: () => window.hideAnimeMenu?.(),
    onShowFrame: loadGamesIfNeeded,
    showOnMount: openOnMount,
  });

  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<{
        source?: string;
        games?: GameEntry[];
      }>).detail;
      const selectedSource = getStoredGameSource();
      if (!detail?.games || detail.source !== selectedSource) {
        return;
      }
      setAllGames(detail.games);
      setLoaded(true);
      setError(null);
    };
    window.addEventListener("lyra:game-catalog-updated", handler);
    return () => {
      window.removeEventListener("lyra:game-catalog-updated", handler);
      loadGeneration.current += 1;
    };
  }, []);

  useEffect(() => {
    const handler = () => {
      loadGeneration.current += 1;
      resetGameCache();
      setAllGames([]);
      setLoaded(false);
      setError(null);
      setQuery("");
      if (visible) loadGames();
    };
    document.addEventListener("gameSourceUpdated", handler);
    return () => document.removeEventListener("gameSourceUpdated", handler);
  }, [visible, loadGames]);

  useEffect(() => {
    window.showGameMenu = show;
    window.hideGameMenu = hide;
    window.toggleGameMenu = toggle;

    app().getGameDisplayLabel = getGameDisplayLabel;
  }, [show, hide, toggle]);

  const handlePlay = useCallback(
    (game: GameEntry) => {
      const gameHost = hostFromUrl(game.gameUrl);
      const launchMetric = {
        stage: "launch" as const,
        source: game.sourceKey,
        status: "started" as const,
        durationMs: 0,
        ...(gameHost ? { urlHost: gameHost } : {}),
      };
      recordGameMetric(launchMetric);

      if (game.isExternal) {
        const popup = window.open(game.gameUrl, "_blank", "noopener,noreferrer");
        if (!popup) {
          recordGameMetric({
            ...launchMetric,
            status: "error",
            errorKind: "popup-blocked",
          });
        }
      } else if (app().handleSearch) {
        hide();
        try {
          const launchResult = app().handleSearch?.(
            game.gameUrl,
            game.name,
            game.coverUrl,
          );
          void Promise.resolve(launchResult).catch(() => {
            recordGameMetric({
              ...launchMetric,
              status: "error",
              errorKind: "navigation-start-failed",
            });
          });
        } catch {
          recordGameMetric({
            ...launchMetric,
            status: "error",
            errorKind: "navigation-start-failed",
          });
        }
      }
    },
    [hide],
  );

  const filteredGames = useMemo(() => {
    return searchGames(allGames, query);
  }, [allGames, query]);

  const placeholder = loaded
    ? `search through ${allGames.length} games... ◝(ᵔᗜᵔ)◜`
    : "fetching games...";

  return (
    <CatalogView
      id="games-page"
      className="games-page"
      topbarClassName="games-topbar"
      searchBarClassName="games-search-bar"
      searchIconClassName="games-search-icon"
      inputId="catalogSearchInput"
      gridContainerClassName="game-grid-container"
      gridClassName="game-grid"
      visible={visible}
      active={active}
      searchBarRef={searchBarRef}
      query={query}
      placeholder={placeholder}
      onQueryChange={setQuery}
      gridVisible={filteredGames.length > 0}
      showSkeleton={!loaded}
      skeletonKeys={CATALOG_SKELETON_KEYS}
      items={filteredGames}
      renderSkeleton={renderGameSkeleton}
      renderItem={(game) => (
        <GameCard
          key={`${game.sourceKey}-${game.gameUrl}`}
          game={game}
          onPlay={handlePlay}
        />
      )}
      emptyMessage={
        loaded && filteredGames.length === 0
          ? error || negativeMessage("zero matching games were found")
          : null
      }
    />
  );
}
