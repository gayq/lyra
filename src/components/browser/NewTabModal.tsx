import { useCallback, useEffect, useRef, useState, useMemo } from "preact/hooks";
import { store, useStore } from "../../state/store.ts";
import { useManagedModal } from "../../core/ui/modal.ts";
import "../../assets/styles/browser/new-tab-modal.css";
import {
  fetchGameData,
  searchGames,
  type GameEntry,
} from "../../features/games/games.ts";
import {
  buildAnimePlaybackUrl,
  searchAnime,
  type AnimeEntry,
} from "../../features/anime/anime.ts";
import { normalizeAnimeIds } from "../../features/anime/animeIdentity.ts";
import { fetchSearchSuggestions } from "../../features/search/searchSuggestions.ts";
import { parseNewTabQuery } from "../../features/search/newTabSearch.ts";
import { useDebouncedValue } from "../../hooks/useDebouncedValue.ts";
import { getStoredGameSource } from "../../core/config/settingsOptions.ts";
import { NEGATIVE } from "../../core/runtime/messages.ts";
import {
  IconMagnifyingGlass2,
  IconGamecontroller,
  IconSushi,
  IconWindow,
} from "../icons";

function loadNewTabGameData() {
  return fetchGameData().catch((err) => {
    console.error("failed to load new tab game data:", err, NEGATIVE);
    return [];
  });
}

function replaceGames(games: readonly GameEntry[]): boolean {
  const unchanged =
    store.allGames.length === games.length &&
    games.every((game, index) => store.allGames[index] === game);
  if (unchanged) return false;

  store.allGames.splice(0, store.allGames.length, ...games);
  window.Lyra.allGames = store.allGames;
  store.notify();
  return true;
}

export default function NewTabModal({
  openOnMount = false,
}: {
  openOnMount?: boolean;
}) {
  const [visible, setVisible] = useState(openOnMount);
  const [isClosing, setIsClosing] = useState(false);
  const [mode, setMode] = useState("newTab");
  const [query, setQuery] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const loadGeneration = useRef(0);
  const loadedGameSourceRef = useRef<string | null>(null);
  const [catalogVersion, setCatalogVersion] = useState(0);
  const [gamesLoading, setGamesLoading] = useState(false);
  const [animeResults, setAnimeResults] = useState<AnimeEntry[]>([]);
  const [animeResultQuery, setAnimeResultQuery] = useState("");
  const [animeSearching, setAnimeSearching] = useState(false);
  const [webSuggestions, setWebSuggestions] = useState<string[]>([]);
  const [webSuggestionQuery, setWebSuggestionQuery] = useState("");
  const [webSearching, setWebSearching] = useState(false);
  const animeRequestIdRef = useRef(0);
  const animeAbortRef = useRef<AbortController | null>(null);
  const webRequestIdRef = useRef(0);
  const webAbortRef = useRef<AbortController | null>(null);

  const tabs = useStore((s) => s.tabs) || [];
  const activeTabId = useStore((s) => s.activeTabId);
  const splitPair = useStore((s) => s.splitPair) || { left: null, right: null };
  const isPickingSplitTab = useStore((s) => s.isPickingSplitTab);
  const parsedSearch = useMemo(() => parseNewTabQuery(query), [query]);
  const debouncedAnimeQuery = useDebouncedValue(
    parsedSearch.mode === "anime" ? parsedSearch.query.trim() : "",
    120,
  );
  const debouncedWebQuery = useDebouncedValue(
    parsedSearch.mode === "web" ? parsedSearch.query.trim() : "",
    120,
  );

  const requestClose = useCallback(() => {
    if (isClosing || !visible) return;
    setIsClosing(true);
  }, [isClosing, visible]);

  const { modalStateClass, onAnimationEnd } = useManagedModal({
    visible,
    isClosing,
    onRequestClose: requestClose,
    onCloseComplete: () => {
      setVisible(false);
      setIsClosing(false);
      setQuery("");
    },
    useOverlay: false,
  });

  useEffect(() => {
    const appWindow = window as Record<string, any>;
    appWindow.showNewTabModal = () => {
      setIsClosing(false);
      setVisible(true);
    };
    appWindow.hideNewTabModal = () => requestClose();
    return () => {
      delete appWindow.showNewTabModal;
      delete appWindow.hideNewTabModal;
    };
  }, [visible, isClosing]);

  useEffect(() => {
    setQuery("");
    if (inputRef.current) inputRef.current.value = "";

    if (isPickingSplitTab) {
      loadGeneration.current += 1;
      setGamesLoading(false);
      setMode("splitSelect");
    } else {
      setMode("newTab");
      const requestGeneration = ++loadGeneration.current;
      const sourceAtStart = getStoredGameSource();
      if (visible && !isClosing) {
        if (
          loadedGameSourceRef.current === sourceAtStart &&
          store.allGames.length > 0
        ) {
          setGamesLoading(false);
          return;
        }
        setGamesLoading(true);
        void loadNewTabGameData().then((games) => {
          if (
            requestGeneration !== loadGeneration.current ||
            sourceAtStart !== getStoredGameSource()
          ) {
            return;
          }
          if (games.length > 0) loadedGameSourceRef.current = sourceAtStart;
          if (replaceGames(games)) {
            setCatalogVersion((version) => version + 1);
          }
          setGamesLoading(false);
        });
      }
    }
  }, [isPickingSplitTab, visible, isClosing]);

  useEffect(() => {
    const handleCatalogUpdated = (event: Event) => {
      const detail = (event as CustomEvent<{ source?: string; games?: GameEntry[] }>).detail;
      if (
        !detail?.games ||
        detail.source !== getStoredGameSource()
      ) {
        return;
      }
      loadGeneration.current += 1;
      loadedGameSourceRef.current = detail.source;
      if (replaceGames(detail.games)) {
        setCatalogVersion((version) => version + 1);
      }
      setGamesLoading(false);
    };
    const handleSourceUpdated = () => {
      loadGeneration.current += 1;
      loadedGameSourceRef.current = null;
      store.allGames.length = 0;
      window.Lyra.allGames = store.allGames;
      store.notify();
      setCatalogVersion((version) => version + 1);
      if (visible && !isClosing && !isPickingSplitTab) {
        setGamesLoading(true);
        const requestGeneration = ++loadGeneration.current;
        const sourceAtStart = getStoredGameSource();
        void loadNewTabGameData().then((games) => {
          if (
            requestGeneration !== loadGeneration.current ||
            sourceAtStart !== getStoredGameSource()
          ) {
            return;
          }
          if (games.length > 0) loadedGameSourceRef.current = sourceAtStart;
          if (replaceGames(games)) {
            setCatalogVersion((version) => version + 1);
          }
          setGamesLoading(false);
        });
      }
    };
    window.addEventListener("lyra:game-catalog-updated", handleCatalogUpdated);
    document.addEventListener("gameSourceUpdated", handleSourceUpdated);
    return () => {
      window.removeEventListener("lyra:game-catalog-updated", handleCatalogUpdated);
      document.removeEventListener("gameSourceUpdated", handleSourceUpdated);
      loadGeneration.current += 1;
    };
  }, [visible, isClosing, isPickingSplitTab]);

  useEffect(() => {
    animeRequestIdRef.current += 1;
    animeAbortRef.current?.abort();
    animeAbortRef.current = null;
    webRequestIdRef.current += 1;
    webAbortRef.current?.abort();
    webAbortRef.current = null;
  }, [query]);

  useEffect(() => {
    if (
      mode !== "newTab" ||
      parsedSearch.mode !== "anime" ||
      !debouncedAnimeQuery
    ) {
      setAnimeSearching(false);
      setAnimeResults([]);
      setAnimeResultQuery("");
      return;
    }

    const requestId = animeRequestIdRef.current + 1;
    animeRequestIdRef.current = requestId;
    const controller = new AbortController();
    animeAbortRef.current = controller;
    setAnimeSearching(true);

    searchAnime(debouncedAnimeQuery, controller.signal, (results) => {
      if (animeRequestIdRef.current !== requestId) return;
      setAnimeResults(results);
      setAnimeResultQuery(debouncedAnimeQuery.toLocaleLowerCase());
    })
      .then((results) => {
        if (animeRequestIdRef.current !== requestId) return;
        setAnimeResults(results);
        setAnimeResultQuery(debouncedAnimeQuery.toLocaleLowerCase());
        setAnimeSearching(false);
      })
      .catch(() => {
        if (controller.signal.aborted) return;
        if (animeRequestIdRef.current !== requestId) return;
        setAnimeSearching(false);
      });

    return () => {
      controller.abort();
      if (animeAbortRef.current === controller) animeAbortRef.current = null;
    };
  }, [debouncedAnimeQuery, mode, parsedSearch.mode]);

  useEffect(() => {
    if (
      mode !== "newTab" ||
      parsedSearch.mode !== "web" ||
      !debouncedWebQuery
    ) {
      setWebSearching(false);
      setWebSuggestions([]);
      setWebSuggestionQuery("");
      return;
    }

    const requestId = webRequestIdRef.current + 1;
    webRequestIdRef.current = requestId;
    const controller = new AbortController();
    webAbortRef.current = controller;
    setWebSearching(true);

    fetchSearchSuggestions(debouncedWebQuery, controller.signal)
      .then((suggestions) => {
        if (webRequestIdRef.current !== requestId) return;
        setWebSuggestions(suggestions);
        setWebSuggestionQuery(debouncedWebQuery.toLocaleLowerCase());
        setWebSearching(false);
      })
      .catch(() => {
        if (controller.signal.aborted) return;
        if (webRequestIdRef.current !== requestId) return;
        setWebSuggestions([]);
        setWebSuggestionQuery(debouncedWebQuery.toLocaleLowerCase());
        setWebSearching(false);
      });

    return () => {
      controller.abort();
      if (webAbortRef.current === controller) webAbortRef.current = null;
    };
  }, [debouncedWebQuery, mode, parsedSearch.mode]);

  useEffect(() => {
    const el = inputRef.current;
    if (el) {
      el.focus();
      el.value = "";
    }
    setQuery("");
  }, [visible, isClosing]);

  useEffect(() => {
    if (!visible) return;
    const outsideClick = (e: MouseEvent) => {
      const target = e.target as Node | null;
      const modal = document.getElementById("new-tab-modal");
      const addBtn = document.getElementById("add-tab-btn");
      const splitBtn = document.getElementById("splitViewBtn");
      if (
        modal &&
        !modal.contains(target) &&
        addBtn &&
        !addBtn.contains(target) &&
        (!splitBtn || !splitBtn.contains(target))
      ) {
        requestClose();
        if (store.isPickingSplitTab) {
          store.isPickingSplitTab = false;
          store.updateIframeView();
        }
      }
    };
    const onBlur = () => {
      window.setTimeout(() => {
        if (document.activeElement?.tagName === "IFRAME") {
          requestClose();
          if (store.isPickingSplitTab) {
            store.isPickingSplitTab = false;
            store.updateIframeView();
          }
        }
      }, 0);
    };
    const onEscape = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        requestClose();
        if (store.isPickingSplitTab) {
          store.isPickingSplitTab = false;
          store.updateIframeView();
        }
      }
    };
    window.addEventListener("click", outsideClick);
    window.addEventListener("blur", onBlur);
    document.addEventListener("keydown", onEscape);
    return () => {
      window.removeEventListener("click", outsideClick);
      window.removeEventListener("blur", onBlur);
      document.removeEventListener("keydown", onEscape);
    };
  }, [visible, isClosing]);

  const handleAction = useCallback(
    (
      url: string,
      title: string,
      isGame = false,
      icon: string | null = null,
      isExternal = false,
    ) => {
      if (isExternal) {
        window.open(url, "_blank", "noopener,noreferrer");
      } else if (url) {
        store.addTab(url, title, isGame, icon);
      }
      requestClose();
    },
    [requestClose],
  );

  const handleAnimeAction = useCallback(
    (anime: AnimeEntry) => {
      const ids = normalizeAnimeIds({
        ...anime.ids,
        anilistId: anime.anilistId,
        malId: anime.malId,
      });
      const playbackUrl = buildAnimePlaybackUrl({
        title: anime.title,
        posterUrl: anime.posterUrl,
        ids,
        episode: 1,
        episodeCount: anime.episodeCount,
        year: anime.year,
        format: anime.format,
      });
      store.addTab(playbackUrl, anime.title);
      requestClose();
    },
    [requestClose],
  );

  const lowerQuery = useMemo(() => query.toLocaleLowerCase(), [query]);
  const normalizedCatalogQuery = useMemo(
    () => parsedSearch.query.trim().toLocaleLowerCase(),
    [parsedSearch.query],
  );
  const filteredGames = useMemo(() => {
    if (
      mode !== "newTab" ||
      parsedSearch.mode !== "games" ||
      !parsedSearch.query
    ) {
      return [];
    }
    return searchGames(store.allGames as GameEntry[], parsedSearch.query).slice(
      0,
      4,
    );
  }, [catalogVersion, mode, parsedSearch.mode, parsedSearch.query]);

  const filteredAnime = useMemo(() => {
    if (
      mode !== "newTab" ||
      parsedSearch.mode !== "anime" ||
      animeResultQuery !== normalizedCatalogQuery
    ) {
      return [];
    }
    return animeResults.slice(0, 4);
  }, [animeResults, animeResultQuery, mode, normalizedCatalogQuery, parsedSearch.mode]);

  const filteredWebSuggestions = useMemo(() => {
    if (
      mode !== "newTab" ||
      parsedSearch.mode !== "web" ||
      webSuggestionQuery !== normalizedCatalogQuery
    ) {
      return [];
    }
    return webSuggestions
      .filter(
        (suggestion) =>
          suggestion.trim().toLocaleLowerCase() !== normalizedCatalogQuery,
      )
      .slice(0, 4);
  }, [
    mode,
    normalizedCatalogQuery,
    parsedSearch.mode,
    webSuggestionQuery,
    webSuggestions,
  ]);

  const filteredTabs = useMemo(() => {
    if (mode !== "splitSelect") return [];
    return tabs.filter(
      (t) =>
        t.id !== activeTabId && 
        t.id !== splitPair.left && 
        t.id !== splitPair.right && 
        (t.title || "").toLowerCase().includes(lowerQuery),
    );
  }, [mode, lowerQuery, tabs, activeTabId, splitPair]);

  const hasResults =
    mode === "splitSelect"
      ? filteredTabs.length > 0
      : !parsedSearch.query
        ? false
        : parsedSearch.mode === "web"
          ? webSearching || filteredWebSuggestions.length > 0
          : parsedSearch.mode === "games"
            ? gamesLoading ||
              filteredGames.length > 0 ||
              (!gamesLoading && catalogVersion > 0)
            : animeSearching ||
              (!animeSearching && animeResultQuery === normalizedCatalogQuery);

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      requestClose();
      return;
    }
    if (e.key !== "Enter") return;

    e.preventDefault();
    const currentQuery = inputRef.current?.value?.trim() || query.trim();
    if (mode === "newTab") {
      const currentSearch = parseNewTabQuery(currentQuery);
      if (currentSearch.mode === "web" && currentSearch.query) {
        handleAction(currentSearch.query, "fetching data...");
      } else if (currentSearch.mode === "games" && filteredGames[0]) {
        const game = filteredGames[0];
        handleAction(
          game.gameUrl,
          game.name,
          true,
          game.coverUrl,
          game.isExternal,
        );
      } else if (currentSearch.mode === "anime" && filteredAnime[0]) {
        handleAnimeAction(filteredAnime[0]);
      }
    } else if (mode === "splitSelect") {
      const tab = filteredTabs[0];
      if (tab) {
        requestClose();
        store.switchTab(tab.id);
      }
    }
  };
  if (!visible) return null;

  return (
    <div
      id="new-tab-modal"
      class={`popup new-tab-modal ${modalStateClass}`}
      onAnimationEnd={onAnimationEnd}
    >
      <div class={`new-tab-unified-wrapper${hasResults ? " has-results" : ""}`}>
        <div class="new-tab-search-container">
          <IconMagnifyingGlass2 />
          <input
            ref={inputRef}
            type="text"
            id="newTabInput"
            placeholder={
              mode === "splitSelect"
                ? "select a tab to split with..."
                : "search or enter url (˶>⩊<˶)"
            }
            autocomplete="off"
            onKeyDown={handleKeyDown}
            onInput={() => setQuery(inputRef.current?.value || "")}
          />
        </div>
        <div
          class="new-tab-results-container"
          style={{ display: hasResults ? "block" : "none" }}
        >
          {mode === "newTab" &&
            parsedSearch.mode === "web" &&
            parsedSearch.query && (
              <>
                {filteredWebSuggestions.map((suggestion) => (
                  <div
                    key={suggestion}
                    class="new-tab-result-item"
                    onClick={() => handleAction(suggestion, "fetching data...")}
                  >
                    <IconMagnifyingGlass2 />
                    <span>{suggestion}</span>
                  </div>
                ))}
                {webSearching && (
                  <div class="new-tab-result-item new-tab-result-status">
                    <IconMagnifyingGlass2 />
                    <span>searching suggestions...</span>
                  </div>
                )}
              </>
            )}
          {mode === "newTab" &&
            parsedSearch.mode === "games" &&
            parsedSearch.query && (
              <>
                {filteredGames.map((game) => (
                  <div
                    key={game.gameUrl}
                    class="new-tab-result-item"
                    onClick={() =>
                      handleAction(
                        game.gameUrl,
                        game.name,
                        true,
                        game.coverUrl,
                        game.isExternal,
                      )
                    }
                  >
                    <IconGamecontroller />
                    <span>{game.name}</span>
                  </div>
                ))}
                {gamesLoading && (
                  <div class="new-tab-result-item new-tab-result-status">
                    <IconGamecontroller />
                    <span>searching games...</span>
                  </div>
                )}
                {!gamesLoading &&
                  catalogVersion > 0 &&
                  filteredGames.length === 0 && (
                    <div class="new-tab-result-item new-tab-result-status">
                      <IconGamecontroller />
                      <span>no games found</span>
                    </div>
                  )}
              </>
            )}
          {mode === "newTab" &&
            parsedSearch.mode === "anime" &&
            parsedSearch.query && (
              <>
                {filteredAnime.map((anime) => (
                  <div
                    key={`${anime.animeType}-${anime.id}`}
                    class="new-tab-result-item"
                    onClick={() => handleAnimeAction(anime)}
                  >
                    <IconSushi />
                    <span>
                      {anime.title}
                      {anime.year ? ` (${anime.year})` : ""}
                    </span>
                  </div>
                ))}
                {animeSearching && (
                  <div class="new-tab-result-item new-tab-result-status">
                    <IconSushi />
                    <span>searching anime...</span>
                  </div>
                )}
                {!animeSearching &&
                  animeResultQuery === normalizedCatalogQuery &&
                  animeResults.length === 0 && (
                    <div class="new-tab-result-item new-tab-result-status">
                      <IconSushi />
                      <span>no anime found</span>
                    </div>
                  )}
              </>
            )}
          {mode === "splitSelect" &&
            filteredTabs.map((tab) => (
              <div
                key={tab.id}
                class="new-tab-result-item"
                onClick={() => {
                  requestClose();
                  store.switchTab(tab.id);
                }}
              >
                <IconWindow />{" "}
                <span>{tab.title}</span>
              </div>
            ))}
        </div>
      </div>
    </div>
  );
}
