import { useCallback } from "preact/hooks";
import { store, useStore } from "../state/store.js";
import { navigateIframeTo, stopIframeLoading } from "../core/iframe.js";
import { useSearchInputBindings } from "../search/search.ts";

let loadingTimeoutId = null;

function injectEruda(iframe) {
  if (!iframe?.contentDocument || !iframe?.contentWindow) return;

  const doc = iframe.contentDocument;
  const win = iframe.contentWindow;

  if (doc.getElementById("eruda")) {
    try {
      win.eruda?.init();
      win.eruda?.show();
    } catch (e) {}
    return;
  }

  function doInject() {
    try {
      if (doc.getElementById("eruda")) {
        try {
          win.eruda?.init();
          win.eruda?.show();
        } catch (e) {}
        return;
      }

      if (loadingTimeoutId) clearTimeout(loadingTimeoutId);
      loadingTimeoutId = setTimeout(() => {
        try {
          const s = doc.getElementById("eruda");
          if (s) s.remove();
        } catch (e) {}
      }, 15000);

      const script = doc.createElement("script");
      script.id = "eruda";
      script.src = "/!!/https://cdn.jsdelivr.net/npm/eruda";
      script.async = true;
      script.onload = () => {
        clearTimeout(loadingTimeoutId);
        setTimeout(() => {
          try {
            win.eruda?.init();
            win.eruda?.show();
          } catch (e) {}
        }, 0);
      };
      script.onerror = () => {
        clearTimeout(loadingTimeoutId);
        try {
          script.remove();
        } catch (e) {}
      };

      let target = doc.head;
      if (!target) {
        target = doc.documentElement || doc.body;
      }
      if (!target) {
        console.warn("eruda: no injection target found in iframe document");
        return;
      }
      target.appendChild(script);
    } catch (err) {
      console.error("eruda injection failed:", err);
    }
  }

  if (doc.readyState === "loading") {
    doc.addEventListener("DOMContentLoaded", doInject, { once: true });
  } else {
    doInject();
  }
}

function toggleEruda() {
  const activeTab = store.getActiveTab();
  if (!activeTab?.iframe?.contentWindow) return;
  const iframe = activeTab.iframe;
  try {
    const isActive = iframe.dataset.erudaActive === "true";
    if (isActive && iframe.contentWindow.eruda) {
      if (typeof iframe.contentWindow.eruda.destroy === "function")
        iframe.contentWindow.eruda.destroy();
      iframe.dataset.erudaActive = "false";
    } else {
      iframe.dataset.erudaActive = "true";
      injectEruda(iframe);
    }
  } catch (err) {
    console.error("error toggling eruda:", err);
  }
}

export default function NavBar() {
  const tabs = useStore((s) => s.tabs);
  const activeTabId = useStore((s) => s.activeTabId);
  const splitPair = useStore((s) => s.splitPair);
  const isPickingSplitTab = useStore((s) => s.isPickingSplitTab);

  const handleBack = useCallback(() => {
    const activeTab = store.getActiveTab();
    if (!activeTab) return;
    const urlToGo = activeTab.historyManager.back();
    if (urlToGo) {
      activeTab._historyNavigating = true;
      activeTab._historyTarget = urlToGo;
      navigateIframeTo(activeTab.iframe, urlToGo);
    }
  }, []);

  const handleForward = useCallback(() => {
    const activeTab = store.getActiveTab();
    if (!activeTab) return;
    const urlToGo = activeTab.historyManager.forward();
    if (urlToGo) {
      activeTab._historyNavigating = true;
      activeTab._historyTarget = urlToGo;
      navigateIframeTo(activeTab.iframe, urlToGo);
    }
  }, []);

  const handleRefresh = useCallback(async () => {
    const activeTab = store.getActiveTab();
    if (!activeTab) return;
    if (activeTab.isLoading) {
      stopIframeLoading(activeTab.iframe);
    } else {
      const manualUrl = activeTab.iframe.dataset.manualUrl;
      if (manualUrl) {
        if (window.WavesApp?.handleSearch)
          await window.WavesApp.handleSearch(manualUrl, activeTab);
      } else if (
        activeTab.iframe.contentWindow &&
        activeTab.iframe.src &&
        activeTab.iframe.src !== "about-blank"
      ) {
        store.showLoading(activeTab.id);
        activeTab.iframe.parentElement?.classList.remove("loaded");
        if (!activeTab.fixedTitle) activeTab.title = "fetching data...";
        if (!activeTab.fixedFavicon) activeTab.favicon = null;
        store.notify();
        try {
          activeTab.iframe.contentWindow.location.reload();
        } catch (e) {
          navigateIframeTo(activeTab.iframe, activeTab.iframe.src);
        }
      }
    }
  }, []);

  const handleFullscreen = useCallback(() => {
    const activeTab = store.getActiveTab();
    if (!activeTab) return;
    const iframe = activeTab.iframe;
    if (iframe.requestFullscreen) iframe.requestFullscreen();
    else if (iframe.mozRequestFullScreen) iframe.mozRequestFullScreen();
    else if (iframe.webkitRequestFullscreen) iframe.webkitRequestFullscreen();
  }, []);

  const handleHome = useCallback((e) => {
    e.preventDefault();
    store.resetSession();
  }, []);

  const handleSplitView = useCallback((e) => {
    e.preventDefault();
    const wasPicking = store.isPickingSplitTab;
    store.toggleSplitView();
    if (store.isPickingSplitTab) {
      document.getElementById("new-tab-modal")?.classList.add("is-visible");
    } else if (wasPicking) {
      document.getElementById("new-tab-modal")?.classList.remove("is-visible");
    }
  }, []);

  const handleSidebarToggle = useCallback((e) => {
    e.preventDefault();
    document.body.classList.toggle("sidebar-hidden");
    localStorage.setItem(
      "sidebarHidden",
      document.body.classList.contains("sidebar-hidden"),
    );
  }, []);

  const activeTab = tabs.find((t) => t.id === activeTabId) || null;
  useSearchInputBindings({
    inputId: "searchInputt",
    suggestionsId: "suggestions-container-nav",
    activeTab,
    syncHistory: true,
  });

  const isSplitPairDefined =
    splitPair.left !== null && splitPair.right !== null;
  const splitBtnDisabled =
    tabs.length <= 1 && !isSplitPairDefined && !isPickingSplitTab;
  const splitBtnActive = isSplitPairDefined || isPickingSplitTab;

  return (
    <div class="main-nav">
      <div class="nav-controls">
        <a id="toggle-sidebar-btn" href="#" onClick={handleSidebarToggle}>
          <i class="fa-regular fa-table-rows"></i>
        </a>
        <a
          id="backIcon"
          href="#"
          onClick={(e) => {
            e.preventDefault();
            handleBack();
          }}
        >
          <i class="fa-regular fa-chevron-left"></i>
        </a>
        <a
          id="forwardIcon"
          href="#"
          onClick={(e) => {
            e.preventDefault();
            handleForward();
          }}
        >
          <i class="fa-regular fa-chevron-right"></i>
        </a>
        <a
          id="refreshIcon"
          href="#"
          onClick={(e) => {
            e.preventDefault();
            handleRefresh();
          }}
        >
          <i
            class={`fa-regular ${activeTab?.isLoading ? "fa-xmark" : "fa-arrow-rotate-right"}`}
          ></i>
        </a>
      </div>
      <div class="omnibox">
        <i id="lockIcon" class="fa-regular fa-unlock-keyhole"></i>
        <input
          type="text"
          id="searchInputt"
          placeholder="search or enter url (˶>⩊<˶)"
          autocomplete="off"
        />
        <div id="suggestions-container-nav" class="suggestions-box"></div>
      </div>
      <div class="window-controls">
        <a id="home-btn" href="/" onClick={handleHome}>
          <i class="fa-regular fa-house-chimney-window"></i>
        </a>
        <a
          id="fullscreenBtn"
          href="#"
          onClick={(e) => {
            e.preventDefault();
            handleFullscreen();
          }}
        >
          <i class="fa-regular fa-expand"></i>
        </a>
        <a
          id="splitViewBtn"
          href="#"
          onClick={handleSplitView}
          class={`${splitBtnActive ? "active" : ""} ${splitBtnDisabled ? "disabled" : ""}`}
          disabled={splitBtnDisabled}
        >
          <i class="fa-regular fa-table-columns"></i>
        </a>
        <a
          id="erudaBtn"
          href="#"
          onClick={(e) => {
            e.preventDefault();
            toggleEruda();
          }}
        >
          <i class="fa-regular fa-square-code"></i>
        </a>
      </div>
    </div>
  );
}