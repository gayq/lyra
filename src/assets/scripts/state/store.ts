import { create } from "zustand";
import { HistoryManager } from "../core/history.ts";
import { initializeIframe,
  updateHistoryUI,
  cleanupIframe,
  reduceIframeMemory,
  restoreIframeMemory,
} from "../core/iframe.ts";
import { handleSearch as performSearch } from "../search/search.ts";
import { getProxyUrl, normalizeGameHistoryUrl } from "../core/utils.ts";

interface Tab {
  id: number;
  title: string;
  favicon: string | null;
  iframe: HTMLIFrameElement;
  wrapper: HTMLDivElement;
  historyManager: HistoryManager;
  isUrlLoaded: boolean;
  isLoading: boolean;
  scrollX: number;
  scrollY: number;
  openerTabId: number | null;
  fixedTitle?: boolean;
  fixedFavicon?: boolean;
  gameDisplayByUrl?: Record<string, string>;
  _historyNavigating?: boolean;
  _historyTarget?: string | null;
  _iframeLoadHandler: EventListener | null;
  _iframeFocusHandler: EventListener | null;
  _iframeElementFocusHandler: EventListener | null;
}

const clientTabMap = new Map<string, number>();
const tabMemory = new Map<number, unknown>();
const lastOpenTabRequest: { url: string | null; ts: number } = { url: null, ts: 0 };

export const useStore = create<{
  tabs: Tab[];
  activeTabId: number | null;
  splitPair: { left: number | null; right: number | null };
  isPickingSplitTab: boolean;
  allGames: unknown[];
  isLoading: boolean;
}>(() => ({
  tabs: [],
  activeTabId: null,
  splitPair: { left: null, right: null },
  isPickingSplitTab: false,
  allGames: [],
  isLoading: false,
}));

function syncToZustand(s: {
  tabs: Tab[];
  activeTabId: number | null;
  splitPair: { left: number | null; right: number | null };
  isPickingSplitTab: boolean;
  allGames: unknown[];
  isLoading: boolean;
}) {
  useStore.setState({
    tabs: [...s.tabs],
    activeTabId: s.activeTabId,
    splitPair: { ...s.splitPair },
    isPickingSplitTab: s.isPickingSplitTab,
    allGames: s.allGames,
    isLoading: s.isLoading,
  });
}

const buildGameDisplayLabel = (title: unknown) => {
  const safeTitle = String(title || "")
    .trim()
    .toLowerCase();
  if (!safeTitle) return null;
  const source = (
    localStorage.getItem("gameSource") || "selenite"
  ).toLowerCase();
  return `game: ${safeTitle} / source: ${source}`;
};

const rememberTabGameLabel = (tab: Tab, url: string | null, title: unknown) => {
  if (!tab || !url) return;
  const normalized = normalizeGameHistoryUrl(url);
  const label = buildGameDisplayLabel(title);
  if (!normalized || !label) return;
  if (!tab.gameDisplayByUrl) tab.gameDisplayByUrl = {};
  tab.gameDisplayByUrl[normalized] = label;
};

const mDecode = (str: string) => {
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

function clearHistoryNavigation(tab: Tab, incomingUrl: string | null) {
  if (!tab || !tab._historyNavigating) return;
  if (!tab._historyTarget || tab._historyTarget === incomingUrl) {
    tab._historyNavigating = false;
    tab._historyTarget = null;
  }
}

export const store = {
  tabs: [] as Tab[],
  activeTabId: null as number | null,
  splitPair: { left: null as number | null, right: null as number | null },
  isPickingSplitTab: false,
  allGames: [] as unknown[],
  isLoading: false,

  subscribe(fn: (state: unknown, prevState: unknown) => void) {
    return useStore.subscribe(fn);
  },

  notify() {
    syncToZustand(this);
  },

  notifySync() {
    this.notify();
  },

  getActiveTab(): Tab | null {
    return this.tabs.find((t) => t.id === this.activeTabId) || null;
  },

  createIframe(): { iframe: HTMLIFrameElement; wrapper: HTMLDivElement } {
    const wrapper = document.createElement("div");
    wrapper.className = "iframe";
    const iframe = document.createElement("iframe");
    iframe.allow = "fullscreen; camera; microphone; display-capture; clipboard-read; clipboard-write; autoplay; cross-origin-isolated;";
    iframe.referrerPolicy = "no-referrer";
    iframe.tabIndex = -1;
    wrapper.appendChild(iframe);
    const container = document.getElementById("iframe-container");
    if (container) container.appendChild(wrapper);
    return { iframe, wrapper };
  },

  addTab(url: string | null = null, title = "new tab", isGame = false, gameIcon: string | null = null): Tab {
    const newTabId = Date.now();
    const { iframe, wrapper } = this.createIframe();
    iframe.dataset.tabId = String(newTabId);
    iframe.name = newTabId.toString();

    const historyManager = new HistoryManager({
      onUpdate: (history) => {
        const activeTab = this.getActiveTab();
        if (
          activeTab?.id === newTabId &&
          !document.body.classList.contains("split-view")
        ) {
          updateHistoryUI(activeTab as never, history);
        } else if (
          activeTab?.id === this.splitPair.left &&
          document.body.classList.contains("split-view")
        ) {
          updateHistoryUI(activeTab as never, history);
        }
      },
    });

    const newTab: Tab = {
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
                newTab.iframe.contentWindow!.location.hostname || "untitled";
            }
          }
          if (!newTab.fixedFavicon) {
            const faviconLink = doc.querySelector<HTMLLinkElement>(
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

    const iframeFocusHandler = (e: CustomEvent) => {
      const clickedTabId = (e.detail as { tabId: number }).tabId;
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

    const iframeElementFocusHandler = (evt: Event) => {
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
    newTab._iframeFocusHandler = iframeFocusHandler as EventListener;
    newTab._iframeElementFocusHandler = iframeElementFocusHandler;

    iframe.addEventListener("load", iframeLoadHandler);
    iframe.addEventListener("iframe-focus", iframeFocusHandler as EventListener);
    iframe.addEventListener("focus", iframeElementFocusHandler);
    iframe.addEventListener("pointerdown", iframeElementFocusHandler);
    iframe.addEventListener("mouseenter", iframeElementFocusHandler);

    this.tabs.push(newTab);
    initializeIframe(iframe, historyManager, newTab.id);

    if (url) {
      performSearch(url, newTab as never, isGame ? title : undefined);
    }

    this.switchTab(newTabId);
    return newTab;
  },

  switchTab(tabId: number) {
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
          restoreIframeMemory(activeTab.iframe);
        } catch (e) {}
        requestAnimationFrame(() => {
          try {
            activeTab.iframe.contentWindow!.scrollTo(
              activeTab.scrollX,
              activeTab.scrollY,
            );
          } catch (e) {}
        });
      }
    } else {
      document.body.classList.remove("browser-view");
    }

    this.updateIframeView();
  },

  closeTab(tabId: number) {
    if (this.tabs.length <= 1) return;
    const tabIndex = this.tabs.findIndex((tab) => tab.id === tabId);
    if (tabIndex === -1) return;

    const closedTab = this.tabs.splice(tabIndex, 1)[0]!;

    if (closedTab.iframe) {
      closedTab.iframe.removeEventListener(
        "load",
        closedTab._iframeLoadHandler!,
      );
      closedTab.iframe.removeEventListener(
        "iframe-focus",
        closedTab._iframeFocusHandler!,
      );
      closedTab.iframe.removeEventListener(
        "focus",
        closedTab._iframeElementFocusHandler!,
      );
      closedTab.iframe.removeEventListener(
        "pointerdown",
        closedTab._iframeElementFocusHandler!,
      );
      closedTab.iframe.removeEventListener(
        "mouseenter",
        closedTab._iframeElementFocusHandler!,
      );
      cleanupIframe(closedTab.iframe);
      closedTab.wrapper.remove();
      closedTab._iframeLoadHandler = null;
      closedTab._iframeFocusHandler = null;
      closedTab._iframeElementFocusHandler = null;
      (closedTab as any).iframe = null;
    }

    if (closedTab.historyManager?.destroy) {
      closedTab.historyManager.destroy();
      (closedTab as any).historyManager = null;
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
        this.activeTabId = this.tabs[Math.max(0, tabIndex - 1)]!.id;
      }
    }

    if (this.tabs.length === 0) {
      this.addTab(null, "new tab");
    } else if (this.activeTabId === null) {
      this.switchTab(this.tabs[0]!.id);
    } else {
      this.updateIframeView();
    }
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

    let leftIframe = null as HTMLDivElement | null;
    let rightIframe = null as HTMLDivElement | null;

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

      const isVisible = isSplitLeft || isSplitRight || isSingleActive;
      if (isVisible && tab.iframe) {
        try {
          restoreIframeMemory(tab.iframe);
        } catch (e) {}
      } else if (!isVisible && tab.iframe && tab.iframe.contentWindow) {
        try {
          reduceIframeMemory(tab.iframe);
        } catch (e) {}
      }

      const isActiveFocus =
        (isSplitViewActive || isPicking) && tab.id === this.activeTabId;
      if (isActiveFocus) tab.wrapper.classList.add("active-focus");

      tab.wrapper.classList.toggle("split-focus-shadow", isActiveFocus && (isSplitViewActive || isPicking));

      if (isSplitLeft) leftIframe = tab.wrapper;
      if (isSplitRight) rightIframe = tab.wrapper;

      if (!isSplitViewActive && !isPicking) {
        const w = tab.wrapper;
        if (w.style.width) w.style.width = "";
        if (w.style.flexBasis) w.style.flexBasis = "";
        if (w.style.flexGrow) w.style.flexGrow = "";
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
      updateHistoryUI(activeTab as never, {
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
    const refreshBtnIcon = document.querySelector("#refreshIcon > i");
    if (refreshBtnIcon) {
      refreshBtnIcon.classList.remove("fa-arrow-rotate-right", "fa-xmark");
      refreshBtnIcon.classList.add(
        activeTab?.isLoading ? "fa-xmark" : "fa-arrow-rotate-right",
      );
    }
    const searchInputNav = document.getElementById("searchInputt") as HTMLInputElement | null;
    if (searchInputNav) {
      searchInputNav.placeholder = activeTab?.isLoading
        ? "fetching url... (˶˃ ᵕ ˂˶)"
        : "search or enter url (˶>⩊<˶)";
    }
  },

  showLoading(tabId: number | null = null) {
    const target = tabId
      ? this.tabs.find((t) => t.id === tabId)
      : this.getActiveTab();
    if (target) target.isLoading = true;

    this._showIframeLoading(tabId);

    const resolvedTabId = (tabId || this.getActiveTab()?.id) ?? null;
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
  },

  hideLoading(tabId: number | null = null) {
    const target = tabId
      ? this.tabs.find((t) => t.id === tabId)
      : this.getActiveTab();
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

  removeIframeLoading(_tabId?: number) {
    const stillLoading = this.tabs.some(t => t.isLoading);
    if (!stillLoading) {
      const footer = document.getElementById("sidebar-footer");
      if (footer) footer.classList.remove("loading");
    }
  },

  _showIframeLoading(_tabId: number | null = null) {
    const footer = document.getElementById("sidebar-footer");
    if (footer) footer.classList.add("loading");
  },

  _hideIframeLoading(_tabId: number | null = null) {
    const stillLoading = this.tabs.some(t => t.isLoading);
    if (!stillLoading) {
      const footer = document.getElementById("sidebar-footer");
      if (footer) footer.classList.remove("loading");
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
        tab.iframe.removeEventListener("load", tab._iframeLoadHandler!);
        tab.iframe.removeEventListener("iframe-focus", tab._iframeFocusHandler!);
        tab.iframe.removeEventListener("focus", tab._iframeElementFocusHandler!);
        tab.iframe.removeEventListener(
          "pointerdown",
          tab._iframeElementFocusHandler!,
        );
        tab.iframe.removeEventListener(
          "mouseenter",
          tab._iframeElementFocusHandler!,
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

  handleServiceWorkerMessage(event: MessageEvent) {
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

      const openerTabId = data.tabId ? parseInt(data.tabId as string, 10) : null;
      const tab = store.addTab(targetUrl, data.title || "fetching data...");
      if (tab && openerTabId) tab.openerTabId = openerTabId as number;
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
      const targetTabId = data.tabId ? parseInt(data.tabId as string, 10) : null;
      let targetTab: Tab | null = null;

      if (targetTabId) {
        targetTab = tabs.find((tab) => tab.id === targetTabId) || null;
        if (targetTab && data.clientId)
          clientTabMap.set(data.clientId as string, targetTab.id);
      }
      if (!targetTab && data.clientId && clientTabMap.has(data.clientId as string)) {
        const mappedId = clientTabMap.get(data.clientId as string);
        targetTab = tabs.find((tab) => tab.id === mappedId) || null;
      }
      if (!targetTab && data.isTopFrame && incomingDecodedUrl) {
        const match = tabs.find(
          (tab) => tab.historyManager?.getCurrentUrl?.() === incomingDecodedUrl,
        );
        if (match) {
          targetTab = match;
          if (data.clientId) clientTabMap.set(data.clientId as string, match.id);
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
            if (data.clientId) clientTabMap.set(data.clientId as string, hostMatch.id);
          }
        } catch (e) {}
      }
      if (!targetTab && data.isTopFrame && tabs.length === 1) {
        targetTab = tabs[0]!;
        if (data.clientId) clientTabMap.set(data.clientId as string, targetTab.id);
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
        updateHistoryUI(targetTab as never, {
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
    let cachedContainerRect: DOMRect | null = null;
    let cachedGap = 0;
    let cachedLeftIframe: Element | null = null;

    const getLeftIframe = () => {
      if (cachedLeftIframe && cachedLeftIframe.isConnected) {
        return cachedLeftIframe;
      }
      cachedLeftIframe = document.querySelector(".iframe.active-split-left");
      return cachedLeftIframe;
    };

    const onMouseMove = (e: MouseEvent) => {
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
      if (leftIframe) (leftIframe as HTMLElement).style.flexBasis = percent + "%";
    };

    const onMouseUp = () => {
      cachedContainerRect = null;
      cachedGap = 0;
      document.body.classList.remove("is-resizing");
      document.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("mouseup", onMouseUp);
    };

    let cursorRaf: number | null = null;
    container.addEventListener("mousemove", (e: MouseEvent) => {
      if (document.body.classList.contains("is-resizing")) return;
      if (!document.body.classList.contains("split-view")) {
        container.style.cursor = "default";
        cachedLeftIframe = null;
        return;
      }
      if (cursorRaf) return;
      const clientX = e.clientX;
      cursorRaf = requestAnimationFrame(() => {
        cursorRaf = null;
        const leftIframe = getLeftIframe();
        if (!leftIframe) {
          container.style.cursor = "default";
          return;
        }
        const leftIframeRect = leftIframe.getBoundingClientRect();
        const handleGripLeft = leftIframeRect.right - handleWidth / 2;
        const handleGripRight = leftIframeRect.right + handleWidth / 2;
        container.style.cursor =
          clientX >= handleGripLeft && clientX <= handleGripRight
            ? "col-resize"
            : "default";
      });
    });

    container.addEventListener("mousedown", (e: MouseEvent) => {
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
    window.WavesApp.tabs = this.tabs as any;
    window.WavesApp.splitPair = this.splitPair;
    window.WavesApp.isLoading = false;
    window.WavesApp.allGames = this.allGames;
    window.WavesApp.getActiveTab = () => this.getActiveTab();
    window.WavesApp.renderTabs = () => this.notify();
    window.WavesApp.resetSession = () => this.resetSession();
    window.WavesApp.openNewTabFromServiceWorker = (url: string | null, options: { title?: string; openerTabId?: number } = {}) => {
      if (!url) return null;
      const tab = this.addTab(url, options.title || "fetching data...");
      if (tab && options.openerTabId) tab.openerTabId = options.openerTabId;
      return tab;
    };
    window.WavesApp.handleSearch = async (query: string, gameName?: string, gameIcon?: string | null) => {
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
        await performSearch(query, activeTab as never, gameName);
      }
    };

  },
};

export function showLoading(tabId?: number) {
  store.showLoading(tabId);
}
export function hideLoading(tabId?: number) {
  store.hideLoading(tabId);
}
export function removeIframeLoading(tabId?: number) {
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
