import { showLoading, hideLoading } from "../state/store.ts";
import { decodeUrl, getProxyUrl, normalizeGameHistoryUrl } from "./utils";

interface WavesTab {
  id: number;
  iframe: HTMLIFrameElement;
  title: string;
  favicon: string | null;
  isUrlLoaded: boolean;
  isLoading: boolean;
  fixedTitle?: boolean;
  fixedFavicon?: boolean;
  gameDisplayByUrl?: Record<string, string>;
  historyManager?: {
    getCurrentUrl(): string | null;
    canGoBack(): boolean;
    canGoForward(): boolean;
    push(url: string): void;
    replace(url: string): void;
    back(): string | null;
    forward(): string | null;
  };
  [key: string]: unknown;
}

interface HistoryUIState {
  currentUrl: string | null;
  canGoBack: boolean;
  canGoForward: boolean;
}

declare global {
  interface Window {
    WavesApp: {
      tabs?: WavesTab[];
      isLoading?: boolean;
      [key: string]: unknown;
    };
  }
}

let loadingTimeout: ReturnType<typeof setTimeout> | null = null;

function getTabIdFromIframe(iframe: HTMLIFrameElement): number | null {
  if (!iframe) return null;
  const val = iframe.dataset?.tabId;
  if (!val) return null;
  const num = parseInt(val, 10);
  return Number.isNaN(num) ? null : num;
}

function detachContentWindowListeners(iframe: HTMLIFrameElement): void {
  try {
    const iframeWindow = iframe.contentWindow as
      | (Window & Record<string, unknown>)
      | null;
    if (!iframeWindow) return;
    if (iframeWindow.__beforeUnloadHandler) {
      iframeWindow.removeEventListener(
        "beforeunload",
        iframeWindow.__beforeUnloadHandler as EventListener,
      );
      iframeWindow.__beforeUnloadHandler = null;
    }
    if (iframeWindow.__domContentLoadedHandler) {
      iframeWindow.removeEventListener(
        "DOMContentLoaded",
        iframeWindow.__domContentLoadedHandler as EventListener,
      );
      iframeWindow.__domContentLoadedHandler = null;
    }
    if (iframeWindow.__wavesFocusHandler) {
      iframeWindow.removeEventListener(
        "mousedown",
        iframeWindow.__wavesFocusHandler as EventListener,
        true,
      );
      iframeWindow.__wavesFocusHandler = null;
    }
  } catch (e) {
    console.warn("unable to detach iframe window listeners:", e);
  }
}

export function stopIframeLoading(iframe: HTMLIFrameElement): void {
  if (!iframe) return;
  const tabId = getTabIdFromIframe(iframe);
  const iframeExt = iframe as HTMLIFrameElement & Record<string, unknown>;

  if (loadingTimeout) clearTimeout(loadingTimeout);
  if (iframeExt.__usableTimeout) {
    clearTimeout(iframeExt.__usableTimeout as ReturnType<typeof setTimeout>);
    iframeExt.__usableTimeout = null;
  }

  try {
    if (iframe.contentWindow) iframe.contentWindow.stop();
  } catch (e) {
    console.warn("could not stop iframe loading:", e);
  }

  updateTabDetails(iframe);

  hideLoading(tabId ?? undefined);
  window.WavesApp.isLoading = false;
  iframe.parentElement?.classList.add("loaded");

  const tab = window.WavesApp?.tabs?.find((tab) => tab.iframe === iframe);
  let currentUrl: string | null | undefined = iframe.dataset.manualUrl;
  if (!currentUrl) {
    try {
      currentUrl = iframe.contentWindow?.location?.href;
    } catch (e) {
      currentUrl = null;
    }
  }
  if (!currentUrl) currentUrl = iframe.src;

  if (tab && currentUrl && currentUrl !== "about:blank") {
    if (tab.historyManager) {
      const hasExistingEntry = !!tab.historyManager.getCurrentUrl();
      if (hasExistingEntry) {
        tab.historyManager.replace(currentUrl);
      } else {
        tab.historyManager.push(currentUrl);
      }
    }
    updateHistoryUI(tab, {
      currentUrl: tab.historyManager?.getCurrentUrl?.() ?? currentUrl,
      canGoBack: tab.historyManager?.canGoBack?.() ?? false,
      canGoForward: tab.historyManager?.canGoForward?.() ?? false,
    });
  }
}

export function navigateIframeTo(iframe: HTMLIFrameElement, url: string): void {
  if (!url || !iframe) return;
  const iframeExt = iframe as HTMLIFrameElement & Record<string, unknown>;
  const tab = window.WavesApp.tabs!.find((t) => t.iframe === iframe);
  showLoading((tab?.id || getTabIdFromIframe(iframe)) ?? undefined);
  window.WavesApp.isLoading = true;
  delete iframe.dataset.reloadAttempted;
  iframe.parentElement?.classList.remove("loaded");

  if (tab) {
    if (!tab.fixedTitle) {
      tab.title = "fetching data...";
    }
    if (!tab.fixedFavicon) {
      tab.favicon = null;
    }
    if (window.WavesApp.renderTabs)
      (window.WavesApp.renderTabs as () => void)();
  }

  iframe.dataset.navigationStarted = "true";
  iframe.removeAttribute("srcdoc");
  delete iframe.dataset.manualUrl;

  if (iframeExt.__usableTimeout) {
    clearTimeout(iframeExt.__usableTimeout as ReturnType<typeof setTimeout>);
    iframeExt.__usableTimeout = null;
  }

  const isProxyUrl = url.startsWith("/b/s/") || url.startsWith("/b/u/");
  if (isProxyUrl && window.WavesApp?.waitForTransport) {
    (async () => {
      try {
        await (window.WavesApp.waitForTransport as (timeout: number) => Promise<void>)(8000);
      } catch (e: unknown) {
        console.warn(
          "navigateIframeTo: transport not ready, attempting recovery...",
          (e as Error).message,
        );
        const conn = (window as unknown as Record<string, unknown>)["wavesConnection"] as
          { recoverOnWake?: () => Promise<void> } | undefined;
        if (conn?.recoverOnWake) {
          try {
            await conn.recoverOnWake();
            await (window.WavesApp.waitForTransport as (timeout: number) => Promise<void>)(6000);
          } catch {
            console.warn("navigateIframeTo: recovery failed, navigating anyway");
          }
        }
      }
      iframe.src = url;
    })();
  } else {
    iframe.src = url;
  }
}

export function cleanupIframe(iframe: HTMLIFrameElement): void {
  if (!iframe) return;
  const iframeExt = iframe as HTMLIFrameElement & Record<string, unknown>;
  const handlers = iframeExt.__wavesInternalHandlers as
    | { onError: EventListener; onLoad: EventListener }
    | null
    | undefined;
  if (handlers) {
    iframe.removeEventListener("error", handlers.onError);
    iframe.removeEventListener("load", handlers.onLoad);
    iframeExt.__wavesInternalHandlers = null;
  }
  iframeExt[SUSPEND_KEY] = undefined;
  detachContentWindowListeners(iframe);
  iframe.removeAttribute("srcdoc");
  iframe.removeAttribute("data-navigation-started");
  iframe.removeAttribute("data-reload-attempted");
  iframe.removeAttribute("data-manual-url");
  delete iframe.dataset.reloadCount;
  try {
    iframe.contentWindow?.stop?.();
  } catch (e) {}
  try {
    iframe.src = "about:blank";
  } catch (e) {}
  const wrapper = iframe.parentElement;
  if (wrapper) {
    wrapper.style.boxShadow = "";
    wrapper.classList.remove(
      "loaded",
      "active",
      "active-split-left",
      "active-split-right",
      "active-focus",
    );
  }
}

interface WavesSuspendState {
  hiddenPatched?: boolean;
  rafSuspended?: boolean;
}

const SUSPEND_KEY = "__wavesSuspend";

function trySuspendAnimations(win: Window & typeof globalThis): void {
  try {
    (win as any).__wavesSuspendedRAF = win.requestAnimationFrame;
    (win as any).__wavesSuspendedCAF = win.cancelAnimationFrame;
    let pending = 0;
    const id = win.requestAnimationFrame(() => {
      pending--;
    });
    win.cancelAnimationFrame(id);
    (win as any).requestAnimationFrame = () => 0;
    (win as any).cancelAnimationFrame = () => {};
  } catch (e) {}
}

function tryRestoreAnimations(win: Window & typeof globalThis): void {
  try {
    if ((win as any).__wavesSuspendedRAF) {
      win.requestAnimationFrame = (win as any).__wavesSuspendedRAF;
      win.cancelAnimationFrame = (win as any).__wavesSuspendedCAF;
      (win as any).__wavesSuspendedRAF = undefined;
      (win as any).__wavesSuspendedCAF = undefined;
    }
  } catch (e) {}
}

export function reduceIframeMemory(iframe: HTMLIFrameElement): void {
  if (!iframe) return;
  const iframeExt = iframe as HTMLIFrameElement &
    Record<string, WavesSuspendState | undefined>;
  if (iframeExt[SUSPEND_KEY]) return;

  const state: WavesSuspendState = {};

  try {
    const win = iframe.contentWindow as
      | (Window & typeof globalThis)
      | null;
    if (!win) return;

    try {
      win.performance?.clearResourceTimings?.();
    } catch (e) {}

    try {
      iframe.blur();
      win.blur?.();
    } catch (e) {}

    iframe.setAttribute("loading", "lazy");

    let doc: Document | null = null;
    try {
      doc = win.document;
    } catch (e) {
      doc = null;
    }
    if (!doc) {
      iframeExt[SUSPEND_KEY] = state;
      return;
    }

    try {
      Object.defineProperty(doc, "hidden", {
        configurable: true,
        get: () => true,
      });
      Object.defineProperty(doc, "visibilityState", {
        configurable: true,
        get: () => "hidden",
      });
      state.hiddenPatched = true;
      try {
        doc.dispatchEvent(new Event("visibilitychange"));
      } catch (e) {}
    } catch (e) {}

    try {
      trySuspendAnimations(win);
      state.rafSuspended = true;
    } catch (e) {}
  } catch (e) {}

  iframeExt[SUSPEND_KEY] = state;
}

export function restoreIframeMemory(iframe: HTMLIFrameElement): void {
  if (!iframe) return;
  const iframeExt = iframe as HTMLIFrameElement &
    Record<string, WavesSuspendState | undefined>;
  const state = iframeExt[SUSPEND_KEY];
  if (!state) return;
  iframeExt[SUSPEND_KEY] = undefined;

  iframe.removeAttribute("loading");

  let doc: Document | null = null;
  let win: Window | null = null;
  try {
    win = iframe.contentWindow;
    doc = iframe.contentWindow?.document ?? null;
  } catch (e) {
    doc = null;
  }

  if (win && state.rafSuspended) {
    tryRestoreAnimations(win as Window & typeof globalThis);
  }

  if (doc && state.hiddenPatched) {
    try {
      delete (doc as unknown as Record<string, unknown>).hidden;
      delete (doc as unknown as Record<string, unknown>).visibilityState;
    } catch (e) {}
    try {
      doc.dispatchEvent(new Event("visibilitychange"));
    } catch (e) {}
  }
}

function updateTabDetails(iframe: HTMLIFrameElement): void {
  const tabToUpdate = window.WavesApp.tabs!.find(
    (tab) => tab.iframe === iframe,
  );
  if (!tabToUpdate) return;
  const prevTitle = tabToUpdate.title;
  const prevFavicon = tabToUpdate.favicon;
  let isReloading = false;
  try {
    const iframeWindow = iframe.contentWindow!;
    const doc = iframeWindow.document;
    const currentProxiedUrl =
      iframe.dataset.manualUrl || iframeWindow.location.href;
    const realUrl = decodeUrl(currentProxiedUrl);

    const newTitle = (doc.title || "").trim();
    if (!tabToUpdate.fixedTitle) {
      if (newTitle) {
        tabToUpdate.title = newTitle;
      } else if (tabToUpdate.title === "fetching data...") {
        try {
          tabToUpdate.title = new URL(realUrl).hostname || "new tab";
        } catch (e) {
          tabToUpdate.title = "new tab";
        }
      }
    }

    if (
      tabToUpdate.title === "404!!" ||
      tabToUpdate.title === "Scramjet" ||
      tabToUpdate.title === "Error"
    ) {
      const MAX_RELOADS = 120;
      const MIN_INTERVAL_MS = 400;
      let reloadCount = parseInt(iframe.dataset.reloadCount || "0", 10);
      const lastReloadAt = parseInt(iframe.dataset.lastReloadAt || "0", 10);
      const now = Date.now();
      const cooldownReached =
        !lastReloadAt || now - lastReloadAt > MIN_INTERVAL_MS;
      const isActiveTab = document.body.classList.contains("split-view")
        ? tabToUpdate.id === (window.WavesApp as any)?.splitPair?.left ||
          tabToUpdate.id === (window.WavesApp as any)?.splitPair?.right ||
          tabToUpdate.id === (window.WavesApp as any)?.getActiveTab?.()?.id
        : tabToUpdate.id === (window.WavesApp as any)?.getActiveTab?.()?.id;
      if (reloadCount < MAX_RELOADS && cooldownReached && isActiveTab) {
        iframe.dataset.reloadCount = (reloadCount + 1).toString();
        iframe.dataset.lastReloadAt = now.toString();
        isReloading = true;
        iframe.parentElement?.classList.remove("loaded");

        const currentUrl = iframe.dataset.manualUrl || iframe.src;
        navigateIframeTo(iframe, currentUrl);
        return;
      }
    }
    const iconLink = doc.querySelector("link[rel*='icon']");
    if (!tabToUpdate.fixedFavicon) {
      if (iconLink) {
        const decodedFavicon = decodeUrl((iconLink as HTMLLinkElement).href);
        tabToUpdate.favicon = decodedFavicon ? getProxyUrl(decodedFavicon) : null;
      } else {
        try {
          tabToUpdate.favicon = getProxyUrl(
            new URL("favicon.ico", realUrl).href,
          );
        } catch (e) {
          tabToUpdate.favicon = null;
        }
      }
    }
  } catch (e) {
    tabToUpdate.title = prevTitle || "new tab";
    if (!tabToUpdate.fixedFavicon) {
      tabToUpdate.favicon = prevFavicon || null;
    }
  } finally {
    if (!isReloading && window.WavesApp.renderTabs)
      (window.WavesApp.renderTabs as () => void)();
  }
}

function setupIframeContentListeners(
  iframe: HTMLIFrameElement,
  historyManager: NonNullable<WavesTab["historyManager"]>,
  tabId: number | null,
): void {
  try {
    const iframeWindow = iframe.contentWindow;
    const hasManualUrl = !!iframe.dataset.manualUrl;
    const isBlank = iframeWindow?.location?.href === "about:blank";
    if (!iframeWindow || iframeWindow === window || (isBlank && !hasManualUrl))
      return;

    const handleNav = (isReplace = false): void => {
      const newUrlInIframe = iframeWindow.location.href;
      const baseManualUrl = iframe.dataset.manualUrl;
      let finalUrlToPush = newUrlInIframe;
      if (baseManualUrl && newUrlInIframe.startsWith("about:blank")) {
        try {
          const newUrlObj = new URL(newUrlInIframe, window.location.origin);
          const baseManualUrlObj = new URL(baseManualUrl);
          baseManualUrlObj.hash = newUrlObj.hash;
          baseManualUrlObj.search = newUrlObj.search;
          finalUrlToPush = baseManualUrlObj.toString();
        } catch (e) {
          finalUrlToPush = newUrlInIframe;
        }
      }
      if (finalUrlToPush !== "about:blank") {
        const currentHistoryUrl = historyManager.getCurrentUrl?.();
        if (isReplace) {
          historyManager.replace(finalUrlToPush);
        } else if (!currentHistoryUrl || currentHistoryUrl !== finalUrlToPush) {
          historyManager.push(finalUrlToPush);
        } else {
          historyManager.replace(finalUrlToPush);
        }
      }
    };

    if (!(iframeWindow.history.pushState as any).__isPatched) {
      const originalPushState = iframeWindow.history.pushState;
      (iframeWindow as any).history.pushState = function (
        ...args: Parameters<typeof History.prototype.pushState>
      ) {
        originalPushState.apply(this, args);
        handleNav();
      };
      (iframeWindow.history.pushState as any).__isPatched = true;
    }
    if (!(iframeWindow.history.replaceState as any).__isPatched) {
      const originalReplaceState = iframeWindow.history.replaceState;
      (iframeWindow as any).history.replaceState = function (
        ...args: Parameters<typeof History.prototype.replaceState>
      ) {
        originalReplaceState.apply(this, args);
        handleNav(true);
      };
      (iframeWindow.history.replaceState as any).__isPatched = true;
    }

    const beforeUnloadHandler = () => {
      showLoading(tabId ?? undefined);
      window.WavesApp.isLoading = true;
      iframe.parentElement?.classList.remove("loaded");
      const tab = window.WavesApp.tabs!.find((t) => t.id === tabId);
      if (tab) {
        if (!tab.fixedTitle) {
          tab.title = "fetching data...";
        }
        if (!tab.fixedFavicon) {
          tab.favicon = null;
        }
        if (window.WavesApp.renderTabs)
          (window.WavesApp.renderTabs as () => void)();
      }
    };
    (iframeWindow as Window & Record<string, unknown>).__beforeUnloadHandler =
      beforeUnloadHandler;
    iframeWindow.addEventListener("beforeunload", beforeUnloadHandler);

    const domLoadedHandler = () => {
      if (loadingTimeout) clearTimeout(loadingTimeout);

      try {
        const currentUrl = iframeWindow.location.href;
        if (currentUrl && currentUrl !== "about:blank")
          historyManager.replace(currentUrl);
      } catch (e) {}

      updateTabDetails(iframe);
    };
    (iframeWindow as Window & Record<string, unknown>).__domContentLoadedHandler =
      domLoadedHandler;
    iframeWindow.addEventListener("DOMContentLoaded", domLoadedHandler);

    const mouseDownHandler = () => {
      const focusEvent = new CustomEvent("iframe-focus", {
        detail: { tabId },
        bubbles: false,
      });
      iframe.dispatchEvent(focusEvent);
    };
    (iframeWindow as Window & Record<string, unknown>).__wavesFocusHandler =
      mouseDownHandler;
    iframeWindow.addEventListener("mousedown", mouseDownHandler, true);
  } catch (e) {
    console.warn("could not attach listeners to iframe content.");
  }
}

let _searchInputNav: HTMLInputElement | null = null;
let _backIcon: HTMLElement | null = null;
let _forwardIcon: HTMLElement | null = null;
let _lockIcon: HTMLElement | null = null;
let _navElCheckCount = 0;

function getNavEls() {
  _navElCheckCount++;
  const needsRefresh = _navElCheckCount % 100 === 0;
  if (!_searchInputNav || needsRefresh) _searchInputNav = document.getElementById("searchInputt") as HTMLInputElement | null;
  if (!_backIcon || needsRefresh) _backIcon = document.getElementById("backIcon");
  if (!_forwardIcon || needsRefresh) _forwardIcon = document.getElementById("forwardIcon");
  if (!_lockIcon || needsRefresh) _lockIcon = document.getElementById("lockIcon");
}

export function updateHistoryUI(
  activeTab: WavesTab,
  { currentUrl, canGoBack, canGoForward }: HistoryUIState,
): void {
  getNavEls();
  const stillExists =
    activeTab && window.WavesApp?.tabs?.some((tab) => tab.id === activeTab.id);

  if (!activeTab || !activeTab.iframe || !stillExists) {
    if (_searchInputNav) _searchInputNav.value = "";
    if (_backIcon) _backIcon.classList.add("disabled");
    if (_forwardIcon) _forwardIcon.classList.add("disabled");
    if (_lockIcon) _lockIcon.className = "fa-regular fa-magnifying-glass";
    return;
  }

  const { iframe } = activeTab;

  if (_backIcon && _forwardIcon) {
    _backIcon.classList.toggle("disabled", !canGoBack);
    _forwardIcon.classList.toggle("disabled", !canGoForward);
  }

  if (_searchInputNav) {
    let displayUrl: string | null | undefined = currentUrl;
    if (displayUrl === undefined || displayUrl === null) {
      displayUrl = iframe.dataset.manualUrl || iframe.src;
    }

    const decoded = decodeUrl(displayUrl);
    let displayText: string = decoded;

    try {
      const formatter = window.WavesApp && window.WavesApp.getGameDisplayLabel;
      if (typeof formatter === "function") {
        const custom = formatter(decoded);
        if (custom) displayText = custom as string;
      }
    } catch (e) {}

    if (
      displayText === decoded &&
      activeTab.gameDisplayByUrl &&
      typeof activeTab.gameDisplayByUrl === "object"
    ) {
      const normalized = normalizeGameHistoryUrl(decoded);
      const remembered = normalized
        ? (activeTab.gameDisplayByUrl as Record<string, string>)[normalized]
        : null;
      if (remembered) displayText = remembered;
    }

    if (displayText === decoded && activeTab.fixedTitle) {
      const rawTitle = (activeTab.title || "").trim();
      const safeTitle = rawTitle.toLowerCase();
      if (
        safeTitle &&
        safeTitle !== "fetching data..." &&
        safeTitle !== "new tab"
      ) {
        const source = (
          localStorage.getItem("gameSource") || "selenite"
        ).toLowerCase();
        displayText = `game: ${safeTitle} / source: ${source}`;
      }
    }

    if (document.activeElement !== _searchInputNav) {
      _searchInputNav.value =
        displayText === "about:blank" || !displayText ? "" : displayText;
    }

    if (_lockIcon) {
      const real = (decoded || "").trim().toLowerCase();
      const hasProtocol = /^[a-z]+:\/\//i.test(real);

      let newClass = "";
      if (!real || real === "about:blank" || !hasProtocol) {
        newClass = "fa-regular fa-magnifying-glass";
      } else if (real.startsWith("https://")) {
        newClass = "fa-regular fa-lock-keyhole";
      } else {
        newClass = "fa-regular fa-unlock-keyhole";
      }

      if (_lockIcon.className !== newClass) {
        _lockIcon.className = newClass;
      }
    }
  }
}

export function initializeIframe(
  iframe: HTMLIFrameElement,
  historyManager: NonNullable<WavesTab["historyManager"]>,
  tabId: number | null,
): void {
  const iframeExt = iframe as HTMLIFrameElement & Record<string, unknown>;

  const onError = (): void => {
    if (loadingTimeout) clearTimeout(loadingTimeout);
    if (iframeExt.__usableTimeout) {
      clearTimeout(iframeExt.__usableTimeout as ReturnType<typeof setTimeout>);
      iframeExt.__usableTimeout = null;
    }
    hideLoading(tabId ?? undefined);
    window.WavesApp.isLoading = false;
  };

  const onLoad = (): void => {
    if (loadingTimeout) clearTimeout(loadingTimeout);
    if (iframeExt.__usableTimeout) {
      clearTimeout(iframeExt.__usableTimeout as ReturnType<typeof setTimeout>);
      iframeExt.__usableTimeout = null;
    }

    let newUrl: string | undefined;
    try {
      newUrl =
        iframe.dataset.manualUrl ??
        iframe.contentWindow?.location.href ??
        iframe.src;
    } catch (e) {
      newUrl = iframe.dataset.manualUrl ?? iframe.src;
    }

    if (newUrl && newUrl !== "about:blank") historyManager.push(newUrl);

    updateTabDetails(iframe);

    hideLoading(tabId ?? undefined);
    window.WavesApp.isLoading = false;
    iframe.parentElement?.classList.add("loaded");

    setupIframeContentListeners(iframe, historyManager, tabId);
  };

  iframe.addEventListener("error", onError);
  iframe.addEventListener("load", onLoad);
  iframeExt.__wavesInternalHandlers = { onError, onLoad };
}