import { useState, useEffect, useRef, useCallback, useMemo, } from "preact/hooks";
import { memo } from "preact/compat";
import { fetchGameData, resetGameCache, getGameDisplayLabel } from "../features/games.ts";
import { showHomeView } from "../state/store.js";
import { attachSearchLight } from "../core/load.js";

const FADE_DURATION = 60;
const SKELETON_KEYS = Array.from({ length: 12 }, (_, i) => `skeleton-${i}`);

const GameCard = memo(function GameCard({ game, onPlay }) {
  const [loaded, setLoaded] = useState(false);
  const [errored, setErrored] = useState(false);

  return (
    <article class="game-card" onClick={() => onPlay(game)}>
      <div
        class={`game-cover${!loaded && !errored ? " skeleton" : ""}${errored ? " no-cover" : ""}`}
      >
        {!errored && game.coverUrl && (
          <img
            loading="lazy"
            decoding="async"
            alt={game.name}
            src={game.coverUrl}
            onLoad={() => setLoaded(true)}
            onError={() => {
              setLoaded(true);
              setErrored(true);
            }}
          />
        )}
      </div>
      <div class="game-info">
        <h1>{game.name}</h1>
      </div>
    </article>
  );
});

function SkeletonCard() {
  return (
    <article class="game-card skeleton-card">
      <div class="game-cover skeleton" />
      <div class="game-info">
        <div />
        <div />
      </div>
    </article>
  );
}

export default function GamesPage() {
  const [allGames, setAllGames] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const [visible, setVisible] = useState(false);
  const [active, setActive] = useState(false);
  const [query, setQuery] = useState("");
  const [error, setError] = useState(null);

  const searchBarRef = useRef(null);
  const searchInputRef = useRef(null);
  const scrollTargetRef = useRef(null);
  const savedScrollRef = useRef(0);
  const fadeTimerRef = useRef(null);

  useEffect(() => {
    if (searchBarRef.current) attachSearchLight(searchBarRef.current);
  }, [visible]);

  useEffect(() => {
    scrollTargetRef.current = document.querySelector(".meow") || window;
  }, []);

  useEffect(() => {
    if (!visible) return;
    const target = scrollTargetRef.current;
    const bar = searchBarRef.current;
    if (!target || !bar) return;

    let scrollRaf = null;
    const onScroll = () => {
      if (scrollRaf) return;
      scrollRaf = requestAnimationFrame(() => {
        scrollRaf = null;
        const top = target === window ? window.scrollY : target.scrollTop;
        bar.classList.toggle("is-sticky", top > 10);
      });
    };
    target.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      target.removeEventListener("scroll", onScroll);
      if (scrollRaf) cancelAnimationFrame(scrollRaf);
    };
  }, [visible]);

  useEffect(() => {
    const handler = () => {
      resetGameCache();
      setAllGames([]);
      setLoaded(false);
      setError(null);
      setQuery("");
      if (visible) loadGames();
    };
    document.addEventListener("gameSourceUpdated", handler);
    return () => document.removeEventListener("gameSourceUpdated", handler);
  }, [visible]);

  useEffect(() => {
    if (!visible) return;
    const onKey = (e) => {
      if (e.key === "Escape") hide();
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [visible]);

  const loadGames = useCallback(() => {
    setError(null);
    fetchGameData()
      .then((games) => {
        setAllGames(games);
        setLoaded(true);
      })
      .catch(() => {
        setError(
          "failed to fetch games .‸. (this is an issue with the source)",
        );
        setLoaded(true);
      });
  }, []);

  const show = useCallback(() => {
    if (fadeTimerRef.current) {
      clearTimeout(fadeTimerRef.current);
      fadeTimerRef.current = null;
    }

    if (
      window.toggleSettingsMenu &&
      document.getElementById("settings-menu")?.classList.contains("open")
    ) {
      window.toggleSettingsMenu();
    }
    if (
      document.body.classList.contains("watch-view") &&
      window.hideWatchMenu
    ) {
      window.hideWatchMenu();
    }

    showHomeView();
    document.body.classList.add("games-view");
    setVisible(true);
    localStorage.setItem("wavesUserOpenedGameMenu", "true");

    requestAnimationFrame(() => {
      setActive(true);
      const target = scrollTargetRef.current;
      if (target) {
        if (target === window) window.scrollTo(0, savedScrollRef.current);
        else target.scrollTop = savedScrollRef.current;
      }
    });

    if (!loaded || allGames.length === 0) {
      loadGames();
    }

    const iconEl = document.querySelector("#choi i");
    if (iconEl) iconEl.className = "fa-solid fa-magnifying-glass";
  }, [loaded, allGames.length, loadGames]);

  const hide = useCallback(() => {
    if (!document.body.classList.contains("games-view")) return;

    const target = scrollTargetRef.current;
    if (target) {
      savedScrollRef.current =
        target === window
          ? window.scrollY || document.documentElement.scrollTop
          : target.scrollTop;
    }

    setActive(false);

    if (fadeTimerRef.current) clearTimeout(fadeTimerRef.current);
    fadeTimerRef.current = setTimeout(() => {
      setVisible(false);
      document.body.classList.remove("games-view");
      fadeTimerRef.current = null;
    }, FADE_DURATION);

    const iconEl = document.querySelector("#choi i");
    if (iconEl) iconEl.className = "fa-solid fa-gamepad-modern";
  }, []);

  const toggle = useCallback(() => {
    if (document.body.classList.contains("games-view")) hide();
    else show();
  }, [show, hide]);

  useEffect(() => {
    window.showGameMenu = show;
    window.hideGameMenu = hide;
    window.toggleGameMenu = toggle;

    window.WavesApp = window.WavesApp || {};
    window.WavesApp.getGameDisplayLabel = getGameDisplayLabel;

    const gameIcon = document.getElementById("choi");
    const brand =
      document.getElementById("branding-container") ||
      document.getElementById("brand");
    const onGameIconClick = (e) => {
      e.preventDefault();
      toggle();
    };
    const onBrandClick = (e) => {
      e.preventDefault();
      if (document.body.classList.contains("games-view")) hide();
    };

    if (gameIcon) gameIcon.addEventListener("click", onGameIconClick);
    if (brand) brand.addEventListener("click", onBrandClick);

    return () => {
      if (gameIcon) gameIcon.removeEventListener("click", onGameIconClick);
      if (brand) brand.removeEventListener("click", onBrandClick);
    };
  }, [show, hide, toggle]);

  const handlePlay = useCallback(
    (game) => {
      if (game.isExternal) {
        window.open(game.gameUrl, "_blank");
      } else if (window.WavesApp?.handleSearch) {
        hide();
        window.WavesApp.handleSearch(game.gameUrl, game.name, game.coverUrl);
      }
    },
    [hide],
  );

  const filteredGames = useMemo(() => {
    if (!query) return allGames;
    const q = query.toLowerCase().trim();
    return allGames.filter(
      (g) => (g._nameLc || "").includes(q) || (g._authorLc || "").includes(q),
    );
  }, [allGames, query]);

  const placeholder = loaded
    ? `search through ${allGames.length} games... ٩(^ᗜ^ )و ´-`
    : "fetching games...";

  if (!visible) return null;

  return (
    <section
      id="games-page"
      class={`games-page${visible ? " is-visible" : ""}${active ? " is-active" : ""}`}
      aria-hidden={!visible}
    >
      <div class="games-topbar">
        <div class="search-bar games-search-bar" ref={searchBarRef}>
          <div class="light"></div>
          <div class="light-border"></div>
          <div class="light-inset-bg"></div>
          <i class="fa-light fa-magnifying-glass games-search-icon"></i>
          <input
            type="text"
            id="gameSearchInput"
            ref={searchInputRef}
            placeholder={placeholder}
            autocomplete="off"
            value={query}
            onInput={(e) => setQuery(e.currentTarget.value)}
          />
        </div>
      </div>
      <div class="game-grid-container">
        <div
          class="game-grid"
          style={filteredGames.length ? "display:grid" : "display:none"}
        >
          {!loaded
            ? SKELETON_KEYS.map((key) => <SkeletonCard key={key} />)
            : filteredGames.map((game) => (
                <GameCard
                  key={game.id || game.gameUrl}
                  game={game}
                  onPlay={handlePlay}
                />
              ))}
        </div>
        {loaded && filteredGames.length === 0 && (
          <p class="no-results">{error || "zero games match were found :("}</p>
        )}
      </div>
    </section>
  );
}