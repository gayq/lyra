import { create } from "zustand";
import { HistoryManager } from "../core/history.js";
import {
  initializeIframe,
  updateHistoryUI,
  cleanupIframe,
  reduceIframeMemory,
} from "../core/iframe.js";
import { handleSearch as performSearch } from "../search/search.ts";
import { getProxyUrl } from "../core/utils.js";

const clientTabMap = new Map();
const tabMemory = new Map();
const lastOpenTabRequest = { url: null, ts: 0 };

let _renderRaf = 0;

export const useStore = create(() => ({
  tabs: [],
  activeTabId: null,
  splitPair: { left: null, right: null },
  isPickingSplitTab: false,
  allGames: [],
  isLoading: false,
}));

function syncToZustand(s) {
  useStore.setState({
    tabs: [...s.tabs],
    activeTabId: s.activeTabId,
    splitPair: { ...s.splitPair },
    isPickingSplitTab: s.isPickingSplitTab,
    allGames: s.allGames,
    isLoading: s.isLoading,
  });
}

const normalizeGameHistoryUrl = (candidate) => {
  if (!candidate || typeof candidate !== "string") return null;
  try {
    const parsed = new URL(candidate);
    if (parsed.hostname && parsed.hostname.includes("gn-math.dev")) {
      const rawId = parsed.searchParams.get("id");
      if (rawId) {
        const decodedId = decodeURIComponent(String(rawId)).trim();
        const cleanId = decodedId.split(/[?&#]/)[0].trim();
        if (cleanId)
          return `${parsed.protocol}//${parsed.host}/?id=${encodeURIComponent(cleanId)}`;
      }
    }
    let pathname = parsed.pathname || "/";
    pathname = pathname.replace(/\/+$/, "");
    if (!pathname) pathname = "/";
    pathname = pathname.replace(/\/index\.(html?|php)$/i, "");
    if (!pathname) pathname = "/";
    return `${parsed.protocol}//${parsed.host}${pathname}${parsed.search}`;
  } catch (e) {
    return candidate.trim().replace(/\/+$/, "").toLowerCase();
  }
};

const buildGameDisplayLabel = (title) => {
  const safeTitle = String(title || "")
    .trim()
    .toLowerCase();
  if (!safeTitle) return null;
  const source = (
    localStorage.getItem("gameSource") || "selenite"
  ).toLowerCase();
  return `game: ${safeTitle} / source: ${source}`;
};

const rememberTabGameLabel = (tab, url, title) => {
  if (!tab || !url) return;
  const normalized = normalizeGameHistoryUrl(url);
  const label = buildGameDisplayLabel(title);
  if (!normalized || !label) return;
  if (!tab.gameDisplayByUrl) tab.gameDisplayByUrl = {};
  tab.gameDisplayByUrl[normalized] = label;
};

const mDecode = (str) => {
  if (!str) return null;
  const key = "wb!";
  try {
    const d = atob(str);
    let x = "";
    for (let i = 0; i < d.length; i++) {
      x += String.fromCharCode(
        d.charCodeAt(i) ^ key.charCodeAt(i % key.length),
      );
    }
    return decodeURIComponent(x);
  } catch (e) {
    return str;
  }
};

function clearHistoryNavigation(tab, incomingUrl) {
  if (!tab || !tab._historyNavigating) return;
  if (!tab._historyTarget || tab._historyTarget === incomingUrl) {
    tab._historyNavigating = false;
    tab._historyTarget = null;
  }
}

let _refreshBtnIcon = null;
let _searchInputNav = null;

export const store = {
  tabs: [],
  activeTabId: null,
  splitPair: { left: null, right: null },
  isPickingSplitTab: false,
  allGames: [],
  isLoading: false,

  subscribe(fn) {
    return useStore.subscribe(fn);
  },

  notify() {
    if (_renderRaf) return;
    _renderRaf = requestAnimationFrame(() => {
      _renderRaf = 0;
      syncToZustand(this);
    });
  },

  notifySync() {
    if (_renderRaf) {
      cancelAnimationFrame(_renderRaf);
      _renderRaf = 0;
    }
    syncToZustand(this);
  },

  getActiveTab() {
    return this.tabs.find((t) => t.id === this.activeTabId) || null;
  },

  createIframe() {
    const wrapper = document.createElement("div");
    wrapper.className = "iframe";
    const iframe = document.createElement("iframe");
    iframe.loading = "lazy";
    iframe.allow =
      "fullscreen; camera; microphone; display-capture; clipboard-read; clipboard-write; autoplay;";
    iframe.referrerPolicy = "no-referrer";
    iframe.tabIndex = -1;
    wrapper.appendChild(iframe);
    const container = document.getElementById("iframe-container");
    if (container) container.appendChild(wrapper);
    return { iframe, wrapper };
  },

  addTab(url = null, title = "new tab", isGame = false, gameIcon = null) {
    const newTabId = Date.now();
    const { iframe, wrapper } = this.createIframe();
    iframe.dataset.tabId = newTabId;
    iframe.name = newTabId.toString();

    const historyManager = new HistoryManager({
      onUpdate: (history) => {
        const activeTab = this.getActiveTab();
        if (
          activeTab?.id === newTabId &&
          !document.body.classList.contains("split-view")
        ) {
          updateHistoryUI(activeTab, history);
        } else if (
          activeTab?.id === this.splitPair.left &&
          document.body.classList.contains("split-view")
        ) {
          updateHistoryUI(activeTab, history);
        }
      },
    });

    const newTab = {
      id: newTabId,
      title: title,
      favicon: null,
      iframe: iframe,
      wrapper: wrapper,
      historyManager: historyManager,
      isUrlLoaded: !!url,
      isLoading: false,
      scrollX: 0,
      scrollY: 0,
      openerTabId: null,
      _iframeLoadHandler: null,
      _iframeFocusHandler: null,
      _iframeElementFocusHandler: null,
    };

    if (isGame) {
      newTab.fixedTitle = true;
      newTab.title = title;
      if (gameIcon) {
        newTab.fixedFavicon = true;
        newTab.favicon = gameIcon;
      }
      rememberTabGameLabel(newTab, url, title);
    }

    const iframeLoadHandler = () => {
      try {
        const doc = newTab.iframe.contentDocument;
        if (doc) {
          if (!newTab.fixedTitle) {
            const newTitle = doc.title;
            if (newTitle && newTitle.trim() !== "") {
              newTab.title = newTitle;
            } else {
              newTab.title =
                newTab.iframe.contentWindow.location.hostname || "untitled";
            }
          }
          if (!newTab.fixedFavicon) {
            const faviconLink = doc.querySelector(
              'link[rel="icon"], link[rel="shortcut icon"]',
            );
            newTab.favicon = faviconLink ? faviconLink.href : null;
          }
          this.notify();
        }
      } catch (e) {
        console.warn("could not access iframe content to update tab title", e);
      }
    };

    const iframeFocusHandler = (e) => {
      const clickedTabId = e.detail.tabId;
      if (document.body.classList.contains("split-view")) {
        const isSplitTab =
          clickedTabId === this.splitPair.left ||
          clickedTabId === this.splitPair.right;
        const isNotActive = clickedTabId !== this.activeTabId;
        if (isSplitTab && isNotActive) {
          this.switchTab(clickedTabId);
        }
      }
    };

    const iframeElementFocusHandler = (evt) => {
      const isSplitView = document.body.classList.contains("split-view");
      const isSplitTab =
        newTabId === this.splitPair.left || newTabId === this.splitPair.right;

      if (
        evt?.type === "mouseenter" &&
        (!isSplitView || this.activeTabId === newTabId)
      )
        return;
      if (evt?.type === "pointerdown") {
        try {
          iframe.focus({ preventScroll: true });
        } catch (e) {}
      }
      if (isSplitView && isSplitTab && this.activeTabId !== newTabId) {
        this.switchTab(newTabId);
        return;
      }
      const focusEvent = new CustomEvent("iframe-focus", {
        detail: { tabId: newTabId },
        bubbles: false,
      });
      iframe.dispatchEvent(focusEvent);
    };

    newTab._iframeLoadHandler = iframeLoadHandler;
    newTab._iframeFocusHandler = iframeFocusHandler;
    newTab._iframeElementFocusHandler = iframeElementFocusHandler;

    iframe.addEventListener("load", iframeLoadHandler);
    iframe.addEventListener("iframe-focus", iframeFocusHandler);
    iframe.addEventListener("focus", iframeElementFocusHandler);
    iframe.addEventListener("pointerdown", iframeElementFocusHandler);
    iframe.addEventListener("mouseenter", iframeElementFocusHandler);

    this.tabs.push(newTab);
    initializeIframe(iframe, historyManager, newTab.id);

    if (url) {
      performSearch(url, newTab, isGame ? title : undefined);
    }

    this.switchTab(newTabId);
    return newTab;
  },

  switchTab(tabId) {
    const previousActiveId = this.activeTabId;

    if (this.isPickingSplitTab) {
      if (tabId === this.splitPair.left) return;
      this.splitPair.right = tabId;
      this.isPickingSplitTab = false;
      this.activeTabId = this.splitPair.left;
    } else {
      this.activeTabId = tabId;
    }

    const oldActiveTab = this.tabs.find((t) => t.id === previousActiveId);
    if (oldActiveTab && oldActiveTab.iframe.contentWindow) {
      try {
        oldActiveTab.scrollX = oldActiveTab.iframe.contentWindow.scrollX;
        oldActiveTab.scrollY = oldActiveTab.iframe.contentWindow.scrollY;
        reduceIframeMemory(oldActiveTab.iframe);
      } catch (e) {}
    }

    const activeTab = this.getActiveTab();
    if (activeTab) {
      const isSplitViewActive =
        this.splitPair.left !== null &&
        this.splitPair.right !== null &&
        (this.activeTabId === this.splitPair.left ||
          this.activeTabId === this.splitPair.right);

      if (activeTab.isUrlLoaded || isSplitViewActive) {
        document.body.classList.add("browser-view");
      } else {
        document.body.classList.remove("browser-view");
      }

      if (activeTab.iframe.contentWindow) {
        try {
          setTimeout(() => {
            activeTab.iframe.contentWindow.scrollTo(
              activeTab.scrollX,
              activeTab.scrollY,
            );
          }, 0);
        } catch (e) {}
      }
    } else {
      document.body.classList.remove("browser-view");
    }

    this.updateIframeView();
  },

  closeTab(tabId) {
    if (this.tabs.length <= 1) return;
    const tabIndex = this.tabs.findIndex((tab) => tab.id === tabId);
    if (tabIndex === -1) return;

    const [closedTab] = this.tabs.splice(tabIndex, 1);

    if (closedTab.iframe) {
      closedTab.iframe.removeEventListener(
        "load",
        closedTab._iframeLoadHandler,
      );
      closedTab.iframe.removeEventListener(
        "iframe-focus",
        closedTab._iframeFocusHandler,
      );
      closedTab.iframe.removeEventListener(
        "focus",
        closedTab._iframeElementFocusHandler,
      );
      closedTab.iframe.removeEventListener(
        "pointerdown",
        closedTab._iframeElementFocusHandler,
      );
      closedTab.iframe.removeEventListener(
        "mouseenter",
        closedTab._iframeElementFocusHandler,
      );
      cleanupIframe(closedTab.iframe);
      closedTab.wrapper.remove();
      closedTab._iframeLoadHandler = null;
      closedTab._iframeFocusHandler = null;
      closedTab._iframeElementFocusHandler = null;
      closedTab.iframe = null;
    }

    if (closedTab.historyManager?.destroy) {
      closedTab.historyManager.destroy();
      closedTab.historyManager = null;
    }
    tabMemory.delete(tabId);

    const wasInSplitPair =
      tabId === this.splitPair.left || tabId === this.splitPair.right;
    if (wasInSplitPair) {
      this.splitPair.left = null;
      this.splitPair.right = null;
      this.isPickingSplitTab = false;
    }

    if (this.activeTabId === tabId) {
      this.activeTabId = null;
      if (this.tabs.length > 0) {
        this.activeTabId = this.tabs[Math.max(0, tabIndex - 1)].id;
      }
    }

    if (this.tabs.length === 0) {
      this.addTab(null, "new tab");
    } else if (this.activeTabId === null) {
      this.switchTab(this.tabs[0].id);
    } else {
      this.updateIframeView();
    }

    this.notify();
  },

  updateIframeView() {
    const isSplitPairDefined =
      this.splitPair.left !== null &&
      this.splitPair.right !== null &&
      this.tabs.some((t) => t.id === this.splitPair.left) &&
      this.tabs.some((t) => t.id === this.splitPair.right);

    if (!isSplitPairDefined && !this.isPickingSplitTab) {
      this.splitPair.left = null;
      this.splitPair.right = null;
    }

    const isSplitViewActive =
      isSplitPairDefined &&
      (this.activeTabId === this.splitPair.left ||
        this.activeTabId === this.splitPair.right);
    const isPicking = this.isPickingSplitTab;

    if (isSplitViewActive) this.isPickingSplitTab = false;

    document.body.classList.toggle("split-view", isSplitViewActive);
    document.body.classList.toggle("is-picking-split", isPicking);

    let leftIframe = null;
    let rightIframe = null;

    this.tabs.forEach((tab) => {
      tab.wrapper.classList.remove("active-focus");
      const isSplitLeft =
        (isSplitViewActive && tab.id === this.splitPair.left) ||
        (isPicking && tab.id === this.splitPair.left);
      const isSplitRight = isSplitViewActive && tab.id === this.splitPair.right;
      const isSingleActive =
        !isSplitViewActive && !isPicking && tab.id === this.activeTabId;

      tab.wrapper.classList.toggle("active-split-left", isSplitLeft);
      tab.wrapper.classList.toggle("active-split-right", isSplitRight);
      tab.wrapper.classList.toggle("active", isSingleActive);

      const isActiveFocus =
        (isSplitViewActive || isPicking) && tab.id === this.activeTabId;
      if (isActiveFocus) tab.wrapper.classList.add("active-focus");

      if (isSplitViewActive || isPicking) {
        tab.wrapper.style.boxShadow = isActiveFocus
          ? "0 0 0 1px #ffffff80"
          : "none";
      } else {
        tab.wrapper.style.boxShadow = "";
      }

      if (isSplitLeft) leftIframe = tab.wrapper;
      if (isSplitRight) rightIframe = tab.wrapper;

      if (!isSplitViewActive && !isPicking) {
        tab.wrapper.style.width = null;
        tab.wrapper.style.flexBasis = null;
        tab.wrapper.style.flexGrow = null;
      }
    });

    if ((isSplitViewActive || isPicking) && leftIframe) {
      let leftBasis = leftIframe.style.flexBasis;
      if (!leftBasis || leftBasis === "auto" || leftBasis === "0px") {
        leftBasis = `calc(50%)`;
      }
      leftIframe.style.flexGrow = "0";
      leftIframe.style.flexBasis = leftBasis;
      if (rightIframe) {
        rightIframe.style.flexGrow = "1";
        rightIframe.style.flexBasis = "0";
      }
    }

    const activeTab = this.getActiveTab();
    if (activeTab) {
      updateHistoryUI(activeTab, {
        currentUrl: activeTab.historyManager.getCurrentUrl(),
        canGoBack: activeTab.historyManager.canGoBack(),
        canGoForward: activeTab.historyManager.canGoForward(),
      });
    }

    this.syncRefreshButton();
    this.notify();
  },

  syncRefreshButton() {
    const activeTab = this.getActiveTab();
    if (!_refreshBtnIcon) _refreshBtnIcon = document.querySelector("#refreshIcon > i");
    if (_refreshBtnIcon) {
      _refreshBtnIcon.classList.remove("fa-arrow-rotate-right", "fa-xmark");
      _refreshBtnIcon.classList.add(
        activeTab?.isLoading ? "fa-xmark" : "fa-arrow-rotate-right",
      );
    }
    if (!_searchInputNav) _searchInputNav = document.getElementById("searchInputt");
    if (_searchInputNav) {
      _searchInputNav.placeholder = activeTab?.isLoading
        ? "fetching url... (˶˃ ᵕ ˂˶)"
        : "search or enter url (˶>⩊<˶)";
    }
  },

  showLoading(tabId = null) {
    const target = tabId
      ? this.tabs.find((t) => t.id === tabId)
      : this.getActiveTab();
    if (target) target.isLoading = true;

    const resolvedTabId = tabId || this.getActiveTab()?.id;
    const activeId = this.getActiveTab()?.id ?? null;
    const isSplitView = document.body.classList.contains("split-view");
    const isInSplit =
      isSplitView &&
      this.splitPair &&
      (resolvedTabId === this.splitPair.left ||
        resolvedTabId === this.splitPair.right);

    if (!isInSplit && (!activeId || (tabId && activeId !== tabId))) return;

    if (!tabId || tabId === activeId) {
      this.syncRefreshButton();
    }

    this._showIframeLoading(resolvedTabId);
  },

  hideLoading(tabId = null) {
    const target = tabId ? this.tabs.find((t) => t.id === tabId) : null;
    if (target) target.isLoading = false;

    const activeId = this.getActiveTab()?.id ?? null;
    const isSplitView = document.body.classList.contains("split-view");
    const isInSplit =
      isSplitView &&
      this.splitPair &&
      (tabId === this.splitPair?.left || tabId === this.splitPair?.right);

    this._hideIframeLoading(tabId);

    if (!isInSplit && tabId && activeId && tabId !== activeId) return;

    if (!tabId || tabId === activeId) {
      this.syncRefreshButton();
    }
  },

  removeIframeLoading(tabId) {
    if (!tabId) return;
    const container = document.getElementById("iframe-container");
    if (!container) return;
    const overlay = container.querySelector(
      `[data-loading-id="iframe-loading-${tabId}"]`,
    );
    if (overlay) overlay.remove();
  },

  _showIframeLoading(tabId = null) {
    const container = document.getElementById("iframe-container");
    if (!container) return;
    let target = container;
    if (tabId) {
      const tab = this.tabs.find((t) => t.id === tabId);
      if (tab?.wrapper) target = tab.wrapper;
    }
    const overlayId = tabId
      ? `iframe-loading-${tabId}`
      : "iframe-loading-default";
    let overlay = target.querySelector(`[data-loading-id="${overlayId}"]`);
    if (overlay) {
      overlay.classList.add("visible");
      return;
    }
    overlay = document.createElement("div");
    overlay.className = "iframe-loading visible";
    overlay.dataset.loadingId = overlayId;
    const cat = document.createElement("div");
    cat.className = "iframe-loading-cat";
    const text = document.createElement("div");
    text.className = "iframe-loading-text";
    text.textContent = "loading...";
    overlay.appendChild(cat);
    overlay.appendChild(text);
    target.appendChild(overlay);
  },

  _hideIframeLoading(tabId = null) {
    const container = document.getElementById("iframe-container");
    if (!container) return;
    if (tabId) {
      const overlay = container.querySelector(
        `[data-loading-id="iframe-loading-${tabId}"]`,
      );
      if (overlay) overlay.classList.remove("visible");
    } else {
      container
        .querySelectorAll(".iframe-loading")
        .forEach((o) => o.classList.remove("visible"));
    }
  },

  toggleSplitView() {
    const isSplitPairDefined =
      this.splitPair.left !== null && this.splitPair.right !== null;
    if (this.tabs.length <= 1 && !this.isPickingSplitTab && !isSplitPairDefined)
      return;

    if (this.isPickingSplitTab) {
      this.isPickingSplitTab = false;
    } else if (isSplitPairDefined) {
      this.splitPair.left = null;
      this.splitPair.right = null;
    } else {
      this.isPickingSplitTab = true;
      this.splitPair.left = this.activeTabId;
    }

    this.updateIframeView();
  },

  resetSession() {
    const tabsCopy = [...this.tabs];
    for (const tab of tabsCopy) {
      if (tab.iframe) {
        tab.iframe.removeEventListener("load", tab._iframeLoadHandler);
        tab.iframe.removeEventListener("iframe-focus", tab._iframeFocusHandler);
        tab.iframe.removeEventListener("focus", tab._iframeElementFocusHandler);
        tab.iframe.removeEventListener(
          "pointerdown",
          tab._iframeElementFocusHandler,
        );
        tab.iframe.removeEventListener(
          "mouseenter",
          tab._iframeElementFocusHandler,
        );
        cleanupIframe(tab.iframe);
        tab.wrapper?.remove();
      }
      if (tab.historyManager?.destroy) tab.historyManager.destroy();
    }

    this.tabs.length = 0;
    tabMemory.clear();
    this.activeTabId = null;
    this.splitPair.left = null;
    this.splitPair.right = null;
    this.isPickingSplitTab = false;

    const container = document.getElementById("iframe-container");
    if (container)
      container.innerHTML = '<div id="iframe-resize-divider"></div>';
    document.body.classList.remove(
      "split-view",
      "is-picking-split",
      "is-resizing",
      "browser-view",
    );

    this.addTab(null, "new tab");
    this.notify();
  },

  handleServiceWorkerMessage(event) {
    const { data } = event;
    if (data && data.type === "open-new-tab") {
      const targetUrl = data.decodedUrl || data.url || null;
      if (!targetUrl) return;
      const now = Date.now();
      if (
        lastOpenTabRequest.url === targetUrl &&
        now - lastOpenTabRequest.ts < 750
      )
        return;
      lastOpenTabRequest.url = targetUrl;
      lastOpenTabRequest.ts = now;

      const openerTabId = data.tabId ? parseInt(data.tabId, 10) : null;
      const tab = store.addTab(targetUrl, data.title || "fetching data...");
      if (tab && openerTabId) tab.openerTabId = openerTabId;
      return;
    }
    if (data && data.type === "page-meta") {
      const isEncoded = !!data.encoded;
      const incomingUrl = isEncoded
        ? mDecode(data.url)
        : data.url || data.href || data.decodedUrl || null;
      const incomingDecodedUrl = isEncoded
        ? mDecode(data.decodedUrl)
        : data.decodedUrl || data.url || data.href || null;
      const incomingTitle = isEncoded
        ? mDecode(data.title)
        : typeof data.title === "string"
          ? data.title
          : "";
      const incomingFavicon = isEncoded
        ? mDecode(data.favicon)
        : data.favicon || data.rawFavicon || null;
      const incomingRawFavicon = isEncoded
        ? mDecode(data.rawFavicon)
        : data.rawFavicon || data.favicon || null;

      const tabs = store.tabs;
      const targetTabId = data.tabId ? parseInt(data.tabId, 10) : null;
      let targetTab = null;

      if (targetTabId) {
        targetTab = tabs.find((tab) => tab.id === targetTabId) || null;
        if (targetTab && data.clientId)
          clientTabMap.set(data.clientId, targetTab.id);
      }
      if (!targetTab && data.clientId && clientTabMap.has(data.clientId)) {
        const mappedId = clientTabMap.get(data.clientId);
        targetTab = tabs.find((tab) => tab.id === mappedId) || null;
      }
      if (!targetTab && data.isTopFrame && incomingDecodedUrl) {
        const match = tabs.find(
          (tab) => tab.historyManager?.getCurrentUrl?.() === incomingDecodedUrl,
        );
        if (match) {
          targetTab = match;
          if (data.clientId) clientTabMap.set(data.clientId, match.id);
        }
      }
      if (!targetTab && data.isTopFrame && incomingDecodedUrl) {
        try {
          const incomingHost = new URL(incomingDecodedUrl).host;
          const hostMatch = tabs.find((tab) => {
            const current = tab.historyManager?.getCurrentUrl?.();
            if (!current) return false;
            try {
              return new URL(current).host === incomingHost;
            } catch (e) {
              return false;
            }
          });
          if (hostMatch) {
            targetTab = hostMatch;
            if (data.clientId) clientTabMap.set(data.clientId, hostMatch.id);
          }
        } catch (e) {}
      }
      if (!targetTab && data.isTopFrame && tabs.length === 1) {
        targetTab = tabs[0];
        if (data.clientId) clientTabMap.set(data.clientId, targetTab.id);
      }

      if (!targetTab) return;

      if (incomingUrl && targetTab.historyManager) {
        const currentUrl = targetTab.historyManager.getCurrentUrl();
        if (targetTab._historyNavigating) {
          targetTab.historyManager.replace(incomingUrl);
          clearHistoryNavigation(targetTab, incomingUrl);
        } else if (!currentUrl) {
          targetTab.historyManager.push(incomingUrl);
        } else if (currentUrl !== incomingUrl) {
          targetTab.historyManager.push(incomingUrl);
        } else {
          targetTab.historyManager.replace(incomingUrl);
        }
      }

      if (typeof incomingTitle === "string" && !targetTab.fixedTitle) {
        if (incomingTitle.trim() !== "") targetTab.title = incomingTitle;
      }
      if (data.memory && typeof data.memory.usedJSHeapSize === "number") {
        tabMemory.set(targetTab.id, data.memory);
      }

      const faviconUrl = incomingFavicon ?? incomingRawFavicon ?? null;
      if (faviconUrl && !targetTab.fixedFavicon) {
        targetTab.favicon = faviconUrl.startsWith("/!!/")
          ? faviconUrl
          : getProxyUrl(faviconUrl);
      }

      store.notify();

      if (targetTab.historyManager) {
        updateHistoryUI(targetTab, {
          currentUrl: targetTab.historyManager.getCurrentUrl(),
          canGoBack: targetTab.historyManager.canGoBack(),
          canGoForward: targetTab.historyManager.canGoForward(),
        });
      }
      return;
    }
    if (data && data.type === "url-update" && data.url) {
      const activeTab = store.getActiveTab();
      if (activeTab && activeTab.historyManager) {
        activeTab.historyManager.push(data.url);
        if (!activeTab.isUrlLoaded) {
          activeTab.isUrlLoaded = true;
          document.body.classList.add("browser-view");
        }
      }
    }
  },

  initSplitResize() {
    const container = document.getElementById("iframe-container");
    if (!container) return;
    const handleWidth = 10;
    let cachedContainerRect = null;
    let cachedGap = 0;
    let cachedLeftIframe = null;

    const getLeftIframe = () => {
      if (cachedLeftIframe && cachedLeftIframe.isConnected) {
        return cachedLeftIframe;
      }
      cachedLeftIframe = document.querySelector(".iframe.active-split-left");
      return cachedLeftIframe;
    };

    const onMouseMove = (e) => {
      if (!cachedContainerRect) {
        cachedContainerRect = container.getBoundingClientRect();
        const containerStyle = window.getComputedStyle(container);
        cachedGap = parseFloat(containerStyle.gap) || 0;
      }
      const containerRect = cachedContainerRect;
      if (!containerRect) return;
      let newLeftWidth = e.clientX - containerRect.left;
      const totalWidthWithoutGap = containerRect.width - cachedGap;
      let percent = (newLeftWidth / totalWidthWithoutGap) * 100;
      percent = Math.max(20, Math.min(80, percent));
      const leftIframe = getLeftIframe();
      if (leftIframe) leftIframe.style.flexBasis = percent + "%";
    };

    const onMouseUp = () => {
      cachedContainerRect = null;
      cachedGap = 0;
      document.body.classList.remove("is-resizing");
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
    };

    container.addEventListener("mousemove", (e) => {
      if (document.body.classList.contains("is-resizing")) return;
      if (!document.body.classList.contains("split-view")) {
        container.style.cursor = "default";
        cachedLeftIframe = null;
        return;
      }
      const leftIframe = getLeftIframe();
      if (!leftIframe) {
        container.style.cursor = "default";
        return;
      }
      const leftIframeRect = leftIframe.getBoundingClientRect();
      const handleGripLeft = leftIframeRect.right - handleWidth / 2;
      const handleGripRight = leftIframeRect.right + handleWidth / 2;
      container.style.cursor =
        e.clientX >= handleGripLeft && e.clientX <= handleGripRight
          ? "col-resize"
          : "default";
    });

    container.addEventListener("mousedown", (e) => {
      if (!document.body.classList.contains("split-view")) return;
      const leftIframe = getLeftIframe();
      if (!leftIframe) return;
      const leftIframeRect = leftIframe.getBoundingClientRect();
      const handleGripLeft = leftIframeRect.right - handleWidth / 2;
      const handleGripRight = leftIframeRect.right + handleWidth / 2;
      if (e.clientX >= handleGripLeft && e.clientX <= handleGripRight) {
        e.preventDefault();
        document.body.classList.add("is-resizing");
        document.addEventListener("mousemove", onMouseMove);
        document.addEventListener("mouseup", onMouseUp);
      }
    });
  },

  setupWindowWavesApp() {
    window.WavesApp = window.WavesApp || {};
    window.WavesApp.tabs = this.tabs;
    window.WavesApp.splitPair = this.splitPair;
    window.WavesApp.isLoading = false;
    window.WavesApp.allGames = this.allGames;
    window.WavesApp.getActiveTab = () => this.getActiveTab();
    window.WavesApp.renderTabs = () => this.notify();
    window.WavesApp.resetSession = () => this.resetSession();
    window.WavesApp.openNewTabFromServiceWorker = (url, options = {}) => {
      if (!url) return null;
      const tab = this.addTab(url, options.title || "fetching data...");
      if (tab && options.openerTabId) tab.openerTabId = options.openerTabId;
      return tab;
    };
    window.WavesApp.handleSearch = async (query, gameName, gameIcon) => {
      const activeTab = this.getActiveTab();
      if (activeTab) {
        if (gameName) {
          activeTab.fixedTitle = true;
          activeTab.title = gameName;
          if (gameIcon) {
            activeTab.fixedFavicon = true;
            activeTab.favicon = gameIcon;
          } else {
            activeTab.fixedFavicon = false;
          }
          rememberTabGameLabel(activeTab, query, gameName);
          this.notify();
        } else {
          activeTab.fixedTitle = false;
          activeTab.fixedFavicon = false;
        }
        await performSearch(query, activeTab, gameName);
      }
    };

  },
};

export function showLoading(tabId) {
  store.showLoading(tabId);
}
export function hideLoading(tabId) {
  store.hideLoading(tabId);
}
export function removeIframeLoading(tabId) {
  store.removeIframeLoading(tabId);
}
export function showBrowserView() {
  document.body.classList.add("browser-view");
}
export function showHomeView() {
  document.body.classList.remove("browser-view");
}
export function syncRefreshButtonWithActiveTab() {
  store.syncRefreshButton();
}