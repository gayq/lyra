import { create } from "zustand";
import { HistoryManager } from "../core/browser/history.ts";
import { initializeIframe,
  updateHistoryUI,
  cleanupIframe,
  clearExtensionPageForNavigation,
} from "../core/browser/iframe.ts";
import { handleSearch as performSearch } from "../features/search/search.ts";
import {
  canonicalize,
  getProxyUrl,
  encodeMochiUrl,
  normalizeGameHistoryUrl,
} from "../core/runtime/utils.ts";
import {
  getRivet,
  mountRivetNewTabOverride,
} from "../core/proxy/rivetBridge.ts";
import { getStoredGameSource } from "../core/config/settingsOptions.ts";
import { NEGATIVE } from "../core/runtime/messages.ts";

function proxyGameFavicon(icon: string): string {
  if (!icon || icon.startsWith("/")) return icon;
  return `/!cover!/${encodeMochiUrl(icon)}/`;
}

export type PlayerStatus =
  | "idle"
  | "loading"
  | "buffering"
  | "waiting"
  | "stalled"
  | "playing"
  | "paused"
  | "ended"
  | "error";

function isPlayerStatus(value: string): value is PlayerStatus {
  return [
    "idle",
    "loading",
    "buffering",
    "waiting",
    "stalled",
    "playing",
    "paused",
    "ended",
    "error",
  ].includes(value);
}

interface Tab {
  id: number;
  title: string;
  favicon: string | null;
  iframe: HTMLIFrameElement;
  wrapper: HTMLDivElement;
  historyManager: HistoryManager;
  isUrlLoaded: boolean;
  isLoading: boolean;
  playerStatus: PlayerStatus;
  scrollX: number;
  scrollY: number;
  openerTabId: number | null;
  isGame?: boolean;
  fixedTitle?: boolean;
  fixedFavicon?: boolean;
  gameDisplayByUrl?: Record<string, string>;
  extensionPage?: {
    extId: string;
    page: string;
    url: string;
  };
  pageState?: {
    url: string | null;
    title: string;
    favicon: string | null;
    historyLength: number | null;
    historyState: unknown;
    navigationType: string | null;
    updatedAt: number;
  };
  _historyNavigating?: boolean;
  _historyTarget?: string | null;
  _historyNavigationClearTimer?: ReturnType<typeof setTimeout> | null;
  _iframeLoadHandler: EventListener | null;
  _iframeFocusHandler: EventListener | null;
  _iframeElementFocusHandler: EventListener | null;
}

interface AddTabOptions {
  applyNewTabOverride?: boolean;
}

type TabPageState = NonNullable<Tab["pageState"]>;

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

let syncedTabsSignature = "";
let syncedSplitLeft: number | null = null;
let syncedSplitRight: number | null = null;

function tabsSignature(tabs: readonly Tab[]): string {
  return tabs
    .map(
      (tab) =>
        `${tab.id}\u0000${tab.title}\u0000${tab.favicon ?? ""}\u0000${
          tab.isLoading ? 1 : 0
        }\u0000${tab.isUrlLoaded ? 1 : 0}\u0000${tab.playerStatus}`,
    )
    .join("\u0001");
}

function syncToZustand(s: {
  tabs: Tab[];
  activeTabId: number | null;
  splitPair: { left: number | null; right: number | null };
  isPickingSplitTab: boolean;
  allGames: unknown[];
  isLoading: boolean;
}) {
  const current = useStore.getState();
  const next: Partial<typeof current> = {};
  const nextTabsSignature = tabsSignature(s.tabs);
  if (nextTabsSignature !== syncedTabsSignature) {
    syncedTabsSignature = nextTabsSignature;
    next.tabs = [...s.tabs];
  }
  if (current.activeTabId !== s.activeTabId) {
    next.activeTabId = s.activeTabId;
  }
  if (
    syncedSplitLeft !== s.splitPair.left ||
    syncedSplitRight !== s.splitPair.right
  ) {
    syncedSplitLeft = s.splitPair.left;
    syncedSplitRight = s.splitPair.right;
    next.splitPair = { ...s.splitPair };
  }
  if (current.isPickingSplitTab !== s.isPickingSplitTab) {
    next.isPickingSplitTab = s.isPickingSplitTab;
  }
  if (current.allGames !== s.allGames) next.allGames = s.allGames;
  if (current.isLoading !== s.isLoading) next.isLoading = s.isLoading;
  if (Object.keys(next).length > 0) useStore.setState(next);
}

const buildGameDisplayLabel = (title: unknown) => {
  const safeTitle = String(title || "")
    .trim()
    .toLowerCase();
  if (!safeTitle) return null;
  const source = getStoredGameSource();
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

const decodePageMetadata = (encoded: string) => {
  if (!encoded) return null;
  const key = "wb!";
  try {
    const bytes = atob(encoded);
    let decoded = "";
    for (let index = 0; index < bytes.length; index++) {
      decoded += String.fromCharCode(
        bytes.charCodeAt(index) ^ key.charCodeAt(index % key.length),
      );
    }
    return decodeURIComponent(decoded);
  } catch {
    return encoded;
  }
};

function clearHistoryNavigation(tab: Tab, incomingUrl: string | null) {
  if (!tab || !tab._historyNavigating) return;
  if (
    !tab._historyTarget ||
    !incomingUrl ||
    canonicalize(tab._historyTarget) === canonicalize(incomingUrl)
  ) {
    if (tab._historyNavigationClearTimer) {
      clearTimeout(tab._historyNavigationClearTimer);
    }
    tab._historyNavigationClearTimer = setTimeout(() => {
      tab._historyNavigating = false;
      tab._historyTarget = null;
      tab._historyNavigationClearTimer = null;
    }, 750);
  }
}

function isExpectedHistoryNavigationUrl(tab: Tab, incomingUrl: string | null) {
  return (
    !tab._historyTarget ||
    !incomingUrl ||
    canonicalize(tab._historyTarget) === canonicalize(incomingUrl)
  );
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

  getActivePageState(): TabPageState | null {
    return this.getActiveTab()?.pageState || null;
  },

  getTabPageState(tabId: number): TabPageState | null {
    return this.tabs.find((tab) => tab.id === tabId)?.pageState || null;
  },

  getReusableActiveTab(): Tab | null {
    const tab = this.getActiveTab();
    if (!tab || tab.isUrlLoaded || tab.extensionPage || tab.pageState?.url) {
      return null;
    }
    if (tab.historyManager?.getCurrentUrl?.()) return null;
    if (tab.iframe.dataset.manualUrl) return null;
    const frameSrc = tab.iframe.getAttribute("src");
    if (frameSrc && frameSrc !== "about:blank") return null;
    return tab;
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

  addTab(
    url: string | null = null,
    title = "new tab",
    isGame = false,
    gameIcon: string | null = null,
    options: AddTabOptions = {},
  ): Tab {
    const safeTitle = typeof title === "string" ? title : "new tab";
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
      title: safeTitle,
      favicon: null,
      iframe: iframe,
      wrapper: wrapper,
      historyManager: historyManager,
      isUrlLoaded: !!url,
      isLoading: false,
      playerStatus: "idle",
      scrollX: 0,
      scrollY: 0,
      openerTabId: null,
      isGame,
      _iframeLoadHandler: null,
      _iframeFocusHandler: null,
      _iframeElementFocusHandler: null,
    };

    if (isGame) {
      newTab.fixedTitle = true;
      newTab.title = safeTitle;
      if (gameIcon) {
        newTab.fixedFavicon = true;
        newTab.favicon = proxyGameFavicon(gameIcon);
      }
      rememberTabGameLabel(newTab, url, safeTitle);
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
        console.warn(
          "could not access iframe content to update tab title:",
          e,
          NEGATIVE,
        );
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

    if (!url && options.applyNewTabOverride !== false) {
      mountRivetNewTabOverride(newTab);
    }

    if (url) {
      performSearch(url, newTab as never, isGame ? title : undefined);
    }

    this.switchTab(newTabId);
    getRivet()?.notifyTabCreated(newTabId);
    return newTab;
  },

  switchTab(tabId: number) {
    const previousActiveId = this.activeTabId;

    if (!this.isPickingSplitTab && previousActiveId === tabId) return;

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
    getRivet()?.notifyTabActivated(tabId);
  },

  closeTab(tabId: number) {
    if (this.tabs.length <= 1) return;
    const tabIndex = this.tabs.findIndex((tab) => tab.id === tabId);
    if (tabIndex === -1) return;

    const closedTab = this.tabs.splice(tabIndex, 1)[0]!;
    if (closedTab._historyNavigationClearTimer) {
      clearTimeout(closedTab._historyNavigationClearTimer);
      closedTab._historyNavigationClearTimer = null;
    }
    closedTab._historyNavigating = false;
    closedTab._historyTarget = null;

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

    const wasActive = this.activeTabId === tabId;
    const nextActiveTabId = wasActive
      ? this.tabs[Math.max(0, tabIndex - 1)]?.id ?? null
      : null;
    if (wasActive) {
      this.activeTabId = null;
    }

    getRivet()?.notifyTabRemoved(tabId);

    if (this.tabs.length === 0) {
      this.addTab(null, "new tab");
    } else if (nextActiveTabId !== null) {
      this.switchTab(nextActiveTabId);
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

      const isActiveFocus =
        (isSplitViewActive || isPicking) && tab.id === this.activeTabId;
      if (isActiveFocus) tab.wrapper.classList.add("active-focus");

      tab.wrapper.classList.toggle("split-focus-shadow", isActiveFocus && (isSplitViewActive || isPicking));

      if (isSplitLeft) leftIframe = tab.wrapper;
      if (isSplitRight) rightIframe = tab.wrapper;

      if (!isSplitViewActive && !isPicking) {
        const wrapper = tab.wrapper;
        if (wrapper.style.width) wrapper.style.width = "";
        if (wrapper.style.flexBasis) wrapper.style.flexBasis = "";
        if (wrapper.style.flexGrow) wrapper.style.flexGrow = "";
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

    this.notify();
  },

  showLoading(tabId: number | null = null) {
    const target = tabId
      ? this.tabs.find((t) => t.id === tabId)
      : this.getActiveTab();
    if (target) {
      target.isLoading = true;
      target.playerStatus = "idle";
    }

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
      this.notify();
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

    if (!isInSplit && tabId && activeId && tabId !== activeId) return;

    if (!tabId || tabId === activeId) {
      this.notify();
    }
  },

  setPlayerStatus(tabId: number | null, status: PlayerStatus) {
    const target = tabId
      ? this.tabs.find((tab) => tab.id === tabId)
      : this.getActiveTab();
    if (!target || target.playerStatus === status) return;
    target.playerStatus = status;
    this.notify();
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
    if (typeof window !== "undefined" && typeof window.dispatchEvent === "function") {
      window.dispatchEvent(new CustomEvent("rivet-close-extension-popup"));
    }
    const tabsCopy = [...this.tabs];
    for (const tab of tabsCopy) {
      if (tab._historyNavigationClearTimer) {
        clearTimeout(tab._historyNavigationClearTimer);
        tab._historyNavigationClearTimer = null;
      }
      tab._historyNavigating = false;
      tab._historyTarget = null;
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

    this.addTab(null, "new tab", false, null, {
      applyNewTabOverride: false,
    });
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
      const title = typeof data.title === "string" ? data.title : "fetching data...";
      const tab = store.addTab(targetUrl, title);
      if (tab && openerTabId) tab.openerTabId = openerTabId as number;
      return;
    }
    if (data && data.type === "page-meta") {
      const isEncoded = !!data.encoded;
      const incomingUrl = isEncoded
          ? decodePageMetadata(data.url)
        : data.url || data.href || data.decodedUrl || null;
      const incomingDecodedUrl = isEncoded
          ? decodePageMetadata(data.decodedUrl)
        : data.decodedUrl || data.url || data.href || null;
      const incomingTitle = isEncoded
          ? decodePageMetadata(data.title)
        : typeof data.title === "string"
          ? data.title
          : "";
      const incomingFavicon = isEncoded
          ? decodePageMetadata(data.favicon)
        : data.favicon || data.rawFavicon || null;
      const incomingRawFavicon = isEncoded
          ? decodePageMetadata(data.rawFavicon)
        : data.rawFavicon || data.favicon || null;
      const incomingHistory =
        data.history && typeof data.history === "object" ? data.history : null;
      const incomingHistoryLength =
        typeof data.historyLength === "number"
          ? data.historyLength
          : typeof incomingHistory?.length === "number"
            ? incomingHistory.length
            : null;
      const incomingHistoryState =
        "historyState" in data
          ? data.historyState
          : incomingHistory && "state" in incomingHistory
            ? incomingHistory.state
            : null;
      const incomingNavigationType =
        typeof data.navigationType === "string" ? data.navigationType : null;

      const tabs = store.tabs;
      const targetTabId = data.tabId ? parseInt(data.tabId as string, 10) : null;
      let targetTab: Tab | null = null;
      const sourceTab = event.source
        ? tabs.find((tab) => tab.iframe?.contentWindow === event.source) || null
        : null;

      if (targetTabId) {
        targetTab = tabs.find((tab) => tab.id === targetTabId) || null;
        if (sourceTab && targetTab && sourceTab.id !== targetTab.id) return;
        if (targetTab && data.clientId)
          clientTabMap.set(data.clientId as string, targetTab.id);
      }
      if (!targetTab && sourceTab) {
        targetTab = sourceTab;
        if (data.clientId) clientTabMap.set(data.clientId as string, sourceTab.id);
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
      if (
        targetTab.extensionPage &&
        typeof incomingDecodedUrl === "string" &&
        /^https?:\/\//i.test(incomingDecodedUrl)
      ) {
        clearExtensionPageForNavigation(targetTab.iframe, targetTab);
      }
      if (
        incomingUrl &&
        targetTab._historyNavigating &&
        !isExpectedHistoryNavigationUrl(targetTab, incomingUrl)
      ) {
        return;
      }

      if (incomingUrl && targetTab.historyManager) {
        const currentUrl = targetTab.historyManager.getCurrentUrl();
        if (targetTab._historyNavigating) {
          if (isExpectedHistoryNavigationUrl(targetTab, incomingUrl)) {
            targetTab.historyManager.replace(incomingUrl);
            clearHistoryNavigation(targetTab, incomingUrl);
          }
        } else if (!currentUrl) {
          targetTab.historyManager.push(incomingUrl);
        } else if (currentUrl !== incomingUrl) {
          targetTab.historyManager.push(incomingUrl);
        } else {
          targetTab.historyManager.replace(incomingUrl);
        }
      }
      if (incomingUrl && !targetTab.isUrlLoaded) {
        targetTab.isUrlLoaded = true;
        if (targetTab.id === store.activeTabId) {
          document.body.classList.add("browser-view");
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
      targetTab.pageState = {
        url: incomingUrl || incomingDecodedUrl || null,
        title: targetTab.title,
        favicon: targetTab.favicon,
        historyLength: incomingHistoryLength,
        historyState: incomingHistoryState,
        navigationType: incomingNavigationType,
        updatedAt: Date.now(),
      };
      if (
        typeof targetTab.pageState.url === "string" &&
        /^https?:\/\//i.test(targetTab.pageState.url)
      ) {
        targetTab.iframe.dataset.manualUrl = targetTab.pageState.url;
      }

      store.notify();
      getRivet()?.notifyTabUpdated(targetTab.id, {
        ...(targetTab.pageState.url ? { url: targetTab.pageState.url } : {}),
        title: targetTab.title,
        favIconUrl: targetTab.favicon ?? "",
      });

      if (targetTab.historyManager) {
        updateHistoryUI(targetTab as never, {
          currentUrl:
            targetTab.pageState.url || targetTab.historyManager.getCurrentUrl(),
          canGoBack: targetTab.historyManager.canGoBack(),
          canGoForward: targetTab.historyManager.canGoForward(),
        });
      }
      return;
    }
    if (data && data.type === "url-update" && data.url) {
      const activeTab = store.getActiveTab();
      if (activeTab && activeTab.historyManager) {
        if (activeTab._historyNavigating) {
          if (isExpectedHistoryNavigationUrl(activeTab, data.url)) {
            activeTab.historyManager.replace(data.url);
            clearHistoryNavigation(activeTab, data.url);
          }
        } else {
          activeTab.historyManager.push(data.url);
        }
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
    let resizeRaf: number | null = null;
    let pendingLeftPercent: number | null = null;

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
      pendingLeftPercent = percent;
      if (resizeRaf) return;
      resizeRaf = requestAnimationFrame(() => {
        resizeRaf = null;
        if (pendingLeftPercent === null) return;
        const leftIframe = getLeftIframe();
        if (leftIframe) {
          (leftIframe as HTMLElement).style.flexBasis = `${pendingLeftPercent}%`;
        }
        pendingLeftPercent = null;
      });
    };

    const onMouseUp = () => {
      cachedContainerRect = null;
      cachedGap = 0;
      pendingLeftPercent = null;
      if (resizeRaf) {
        cancelAnimationFrame(resizeRaf);
        resizeRaf = null;
      }
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

  setupWindowLyra() {
    window.Lyra = window.Lyra || {};
    window.Lyra.tabs = this.tabs as any;
    window.Lyra.splitPair = this.splitPair;
    window.Lyra.isLoading = false;
    window.Lyra.allGames = this.allGames;
    window.Lyra.getActiveTab = () => this.getActiveTab();
    window.Lyra.getActivePageState = () => this.getActivePageState();
    window.Lyra.getTabPageState = (tabId: number) =>
      this.getTabPageState(tabId);
    window.Lyra.setPlayerStatus = (tabId: number, status: string) => {
      if (isPlayerStatus(status)) this.setPlayerStatus(tabId, status);
    };
    window.Lyra.renderTabs = () => this.notify();
    window.Lyra.resetSession = () => this.resetSession();
    window.Lyra.openNewTabFromServiceWorker = (url: string | null, options: { title?: string; openerTabId?: number } = {}) => {
      if (!url) return null;
      const tab = this.addTab(url, options.title || "fetching data...");
      if (tab && options.openerTabId) tab.openerTabId = options.openerTabId;
      return tab;
    };
    window.Lyra.handleSearch = async (query: string, gameName?: string, gameIcon?: string | null) => {
      const activeTab = this.getActiveTab();
      if (activeTab) {
        const isStreamingUrl = /^(\/stream\/anime)/.test(query);
        if (gameName && !isStreamingUrl) {
          activeTab.isGame = true;
          activeTab.fixedTitle = true;
          activeTab.title = gameName;
          if (gameIcon) {
            activeTab.fixedFavicon = true;
            activeTab.favicon = proxyGameFavicon(gameIcon);
          } else {
            activeTab.fixedFavicon = false;
          }
          rememberTabGameLabel(activeTab, query, gameName);
          this.notify();
        } else {
          activeTab.isGame = false;
          activeTab.fixedTitle = false;
          if (isStreamingUrl && gameIcon) {
            activeTab.fixedFavicon = true;
            activeTab.favicon = proxyGameFavicon(gameIcon);
          } else {
            activeTab.fixedFavicon = false;
          }
          this.notify();
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
export function showBrowserView() {
  document.body.classList.add("browser-view");
}
export function showHomeView() {
  document.body.classList.remove("browser-view");
}
