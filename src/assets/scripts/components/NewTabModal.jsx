import { useEffect, useRef, useState, useCallback, useMemo } from "preact/hooks";
import { store, useStore } from "../state/store.js";

const SOURCE_CONFIG = {
  selenite: {
    games: "https://selenite.cc/resources/games.json",
    assets: "https://selenite.cc/resources/semag/",
  },
  gnMath: {
    zones: "https://cdn.jsdelivr.net/gh/freebuisness/assets@main/zones.json",
    html: "https://cdn.jsdelivr.net/gh/freebuisness/html@main",
    covers: "https://cdn.jsdelivr.net/gh/freebuisness/covers@main",
  },
  edurocks: {
    games: "https://www.edurocks.org/gxxes.json",
    assets: "https://edurocks.org",
  },
  velara: {
    games: "https://velara.cc/data/games.json",
    assets: "https://velara.cc",
  },
};

function loadNewTabGameData(allGames) {
  if (allGames.length > 0) return Promise.resolve(allGames);
  const source = (() => {
    const stored = localStorage.getItem("gameSource") || "selenite";
    return ["selenite", "gn-math", "edurocks", "velara"].includes(stored)
      ? stored
      : "selenite";
  })();
  let fetchPromise;
  if (source === "velara") {
    fetchPromise = fetch(`/!!/${SOURCE_CONFIG.velara.games}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(r.statusText)))
      .then((data) =>
        data
          .filter(
            (g) =>
              g &&
              g.title &&
              g.title !== "!!DMCA" &&
              g.title !== "!!Game Request" &&
              !g.title.includes("[!]"),
          )
          .map((game) => {
            let finalUrl = game.location;
            if (finalUrl && !finalUrl.startsWith("http"))
              finalUrl =
                SOURCE_CONFIG.velara.assets +
                (finalUrl.startsWith("/") ? "" : "/") +
                finalUrl;
            else if (game.grdmca) finalUrl = game.grdmca;
            return {
              name: game.title,
              gameUrl: finalUrl,
              isExternal: !game.location && !!game.grdmca,
              coverUrl: game.image
                ? `/!!/${SOURCE_CONFIG.velara.assets}/${game.image}`
                : null,
            };
          }),
      );
  } else if (source === "selenite") {
    fetchPromise = fetch(`/!!/${SOURCE_CONFIG.selenite.games}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(r.statusText)))
      .then((data) =>
        (Array.isArray(data) ? data : [])
          .filter((g) => g && g.name && g.directory)
          .map((game) => {
            const gamePath = String(game.directory).replace(/^\/+/, "");
            const imagePath = String(game.image || "").replace(/^\/+/, "");
            const finalUrl = `${SOURCE_CONFIG.selenite.assets}${gamePath}`;
            const finalCover = imagePath
              ? `${SOURCE_CONFIG.selenite.assets}${gamePath}/${imagePath}`
              : null;
            return {
              name: game.name,
              gameUrl: finalUrl,
              isExternal: false,
              coverUrl: finalCover ? `/!!/${finalCover}` : null,
            };
          }),
      );
  } else if (source === "edurocks") {
    fetchPromise = fetch(`/!!/${SOURCE_CONFIG.edurocks.games}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(r.statusText)))
      .then((data) =>
        data
          .map((game) => {
            let finalUrl = game.url.startsWith("http")
              ? game.url
              : SOURCE_CONFIG.edurocks.assets +
                "/" +
                game.url.replace(/^\.\//, "");
            let finalCover = game.img.startsWith("http")
              ? game.img
              : SOURCE_CONFIG.edurocks.assets +
                "/" +
                game.img.replace(/^\.\//, "");
            return {
              name: game.name,
              gameUrl: finalUrl,
              isExternal: false,
              coverUrl: finalCover ? `/!!/${finalCover}` : null,
            };
          })
          .filter((g) => !g.name.includes("[!]")),
      );
  } else {
    fetchPromise = fetch(`/!!/${SOURCE_CONFIG.gnMath.zones}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(r.statusText)))
      .then((data) =>
        data
          .map((zone) => {
            const isExternal = zone.url ? zone.url.startsWith("http") : false;
            const finalUrl = zone.url ? zone.url.replace("{HTML_URL}", SOURCE_CONFIG.gnMath.html) : `https://gn-math.dev/?id=${zone.id}`;
            return {
              id: zone.id,
              name: zone.name,
              gameUrl: isExternal
                ? zone.url
                : finalUrl,
              isExternal,
              coverUrl: zone.cover
                ? `/!!/${zone.cover.replace("{COVER_URL}", SOURCE_CONFIG.gnMath.covers)}`
                : null,
            };
          })
          .filter(
            (g) => !g.name.startsWith("[!]") && !g.name.startsWith("Chat Bot"),
          ),
      );
  }
  return fetchPromise
    .then((games) => {
      games.sort((a, b) => a.name.localeCompare(b.name));
      allGames.splice(0, allGames.length, ...games);
      window.WavesApp.allGames = allGames;
      return allGames;
    })
    .catch((err) => {
      console.error("failed to load new tab game data:", err);
      return [];
    });
}

export default function NewTabModal() {
  const [visible, setVisible] = useState(false);
  const [mode, setMode] = useState("newTab");
  const [query, setQuery] = useState("");
  const inputRef = useRef(null);
  const lastVisibleRef = useRef(false);

  const tabs = useStore((s) => s.tabs) || [];
  const activeTabId = useStore((s) => s.activeTabId);
  const splitPair = useStore((s) => s.splitPair) || { left: null, right: null };
  const isPickingSplitTab = useStore((s) => s.isPickingSplitTab);

  useEffect(() => {
    const modal = document.getElementById("new-tab-modal");
    if (!modal) return;
    const observer = new MutationObserver(() => {
      const isVis = modal.classList.contains("is-visible");
      if (lastVisibleRef.current === isVis) return;
      lastVisibleRef.current = isVis;
      setVisible(isVis);
      if (!isVis) return;
      const el = inputRef.current;
      if (el) {
        el.focus();
        el.value = "";
      }
      setQuery("");
    });
    observer.observe(modal, { attributes: true, attributeFilter: ["class"] });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    setQuery("");
    if (inputRef.current) inputRef.current.value = "";

    if (isPickingSplitTab) {
      setMode("splitSelect");
    } else {
      setMode("newTab");
      if (visible) {
        loadNewTabGameData(store.allGames);
      }
    }
  }, [isPickingSplitTab, visible]);

  const hide = () => {
    const modal = document.getElementById("new-tab-modal");
    if (modal) modal.classList.remove("is-visible");
    setVisible(false);
    setQuery("");
  };

  useEffect(() => {
    if (!visible) return;
    const outsideClick = (e) => {
      const modal = document.getElementById("new-tab-modal");
      const addBtn = document.getElementById("add-tab-btn");
      const splitBtn = document.getElementById("splitViewBtn");
      if (
        modal &&
        !modal.contains(e.target) &&
        addBtn &&
        !addBtn.contains(e.target) &&
        (!splitBtn || !splitBtn.contains(e.target))
      ) {
        hide();
        if (store.isPickingSplitTab) {
          store.isPickingSplitTab = false;
          store.updateIframeView();
        }
      }
    };
    const onBlur = () => {
      if (document.activeElement?.tagName === "IFRAME") {
        hide();
        if (store.isPickingSplitTab) {
          store.isPickingSplitTab = false;
          store.updateIframeView();
        }
      }
    };
    const onEscape = (e) => {
      if (e.key === "Escape") {
        hide();
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
  }, [visible]);

  const handleAction = (url, title, isGame = false, icon = null) => {
    if (url) store.addTab(url, title, isGame, icon);
    hide();
  };

  const lowerQuery = useMemo(() => query.toLowerCase(), [query]);
  const filteredGames = useMemo(() => {
    if (!query) return [];
    return store.allGames
      .filter((g) => (g.name || "").toLowerCase().includes(lowerQuery))
      .slice(0, 4);
  }, [query, lowerQuery]);
  
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
  
  const hasResults = mode === "newTab" ? !!query : filteredTabs.length > 0;

  const handleKeyUp = (e) => {
    if (e.key === "Escape") {
      hide();
      return;
    }
    if (mode === "newTab") {
      if (e.key === "Enter") {
        const q = query.trim();
        if (q) handleAction(q, "fetching data...");
      } else {
        setQuery(inputRef.current?.value || "");
      }
    } else if (mode === "splitSelect") {
      if (e.key === "Enter") {
        if (filteredTabs.length > 0) {
          hide();
          store.switchTab(filteredTabs[0].id);
        }
      } else {
        setQuery(inputRef.current?.value || "");
      }
    }
  };
  const currentSearchEngine =
    localStorage.getItem("searchEngine") || "duckduckgo";

  return (
    <div
      id="new-tab-modal"
      class="popup new-tab-popup"
      style={{ display: "none" }}
    >
      <div class={`new-tab-unified-wrapper${hasResults ? " has-results" : ""}`}>
        <div class="new-tab-search-container">
          <i class="fa-regular fa-magnifying-glass"></i>
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
            onKeyUp={handleKeyUp}
            onInput={() => setQuery(inputRef.current?.value || "")}
          />
        </div>
        <div
          class="new-tab-results-container"
          style={{ display: hasResults ? "block" : "none" }}
        >
          {mode === "newTab" && query && (
            <>
              <div
                class="new-tab-result-item"
                onClick={() => handleAction(query, "fetching data...")}
              >
                <i class="fa-regular fa-magnifying-glass"></i> {query} - Search
                with {currentSearchEngine}
              </div>
              {filteredGames.map((game) => (
                <div
                  key={game.gameUrl}
                  class="new-tab-result-item"
                  onClick={() =>
                    handleAction(game.gameUrl, game.name, true, game.coverUrl)
                  }
                >
                  <i class="fa-solid fa-gamepad-modern"></i>{" "}
                  <span>{game.name}</span>
                </div>
              ))}
            </>
          )}
          {mode === "splitSelect" &&
            filteredTabs.map((tab) => (
              <div
                key={tab.id}
                class="new-tab-result-item"
                onClick={() => {
                  hide();
                  store.switchTab(tab.id);
                }}
              >
                <i class="fa-regular fa-window-maximize"></i>{" "}
                <span>{tab.title}</span>
              </div>
            ))}
        </div>
      </div>
    </div>
  );
}