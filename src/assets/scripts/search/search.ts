import { BANGS, SEARCH_ENGINES } from "../core/config.js";
import { useEffect } from "preact/hooks";
import { showBrowserView } from "../state/store.js";
import { navigateIframeTo, updateHistoryUI } from "../core/iframe.js";
import { getProxyUrl } from "../core/utils.js";

interface TabLike {
  iframe: HTMLIFrameElement;
  isUrlLoaded: boolean;
  historyManager: {
    getCurrentUrl(): string;
    canGoBack(): boolean;
    canGoForward(): boolean;
  };
}

interface SearchInputBindingsOptions {
  inputId: string;
  suggestionsId?: string | null;
  activeTab?: TabLike | null;
  syncHistory?: boolean;
}

function isBangQuery(query: string): boolean {
  return query.trim().startsWith("!");
}

function parseBangQuery(
  query: string,
): { bang: string; searchQuery: string } | null {
  const trimmed = query.trim();
  if (!isBangQuery(trimmed)) return null;
  const parts = trimmed.substring(1).split(" ");
  if (parts.length === 0) return null;
  const bang = parts[0]!.toLowerCase();
  const searchQuery = parts.slice(1).join(" ");
  return { bang, searchQuery };
}

function executeBang(query: string): string | null {
  const parsed = parseBangQuery(query);
  if (!parsed) return null;
  const { bang, searchQuery } = parsed;
  const bangData = (BANGS as Record<string, { url: string }>)[bang];
  if (!bangData) return null;
  return bangData.url.includes("{query}")
    ? bangData.url.replace("{query}", encodeURIComponent(searchQuery))
    : bangData.url;
}

function generateSearchUrl(query: string): string {
  query = query.trim();
  const searchEngine = localStorage.getItem("searchEngine") ?? "duckduckgo";
  const baseUrl =
    (SEARCH_ENGINES as Record<string, string>)[searchEngine] ||
    (SEARCH_ENGINES as Record<string, string>)["duckduckgo"]!;
  if (!query)
    return searchEngine === "duckduckgo"
      ? "https://duckduckgo.com/?q=&ia=web"
      : baseUrl;
  if (/^[a-zA-Z]+:\/\//.test(query)) {
    try {
      new URL(query);
      return query;
    } catch {}
  }
  if (/^(localhost|(\d{1,3}\.){3}\d{1,3})(:\d+)?(\/.*)?$/i.test(query))
    return `http://${query}`;
  if (!query.includes(" ")) {
    try {
      const urlWithHttps = new URL(`https://${query}`);
      const parts = urlWithHttps.hostname.split(".");
      if (
        urlWithHttps.hostname.includes(".") &&
        (parts[parts.length - 1]?.length ?? 0) >= 2 &&
        !/^\d+$/.test(parts[parts.length - 1] ?? "")
      ) {
        return urlWithHttps.toString();
      }
    } catch {}
  }
  const finalUrl = baseUrl + encodeURIComponent(query);
  return searchEngine === "duckduckgo" ? `${finalUrl}&ia=web` : finalUrl;
}

async function getUrl(url: string): Promise<string> {
  const selectedBackend = localStorage.getItem("backend") ?? "scramjet";
  if (
    selectedBackend === "ultraviolet" &&
    (window as any)["__uv$config"]?.encodeUrl
  ) {
    return (
      (window as any)["__uv$config"].prefix +
      (window as any)["__uv$config"].encodeUrl(url)
    );
  } else if (selectedBackend === "scramjet") {
    await (window as any).scramjetReady;
    return "/b/s/r/" + url;
  }
  return url;
}

export async function handleSearch(
  query: string,
  activeTab: TabLike,
  _gameName?: string,
): Promise<void> {
  if (!activeTab || !query.trim()) return;
  showBrowserView();
  activeTab.isUrlLoaded = true;
  const searchURL = executeBang(query) || generateSearchUrl(query);
  const isGame =
    /jsdelivr|googleusercontent|githack|selenite|edunet|velara|vsembed|vidsrc\.me|gn-math\.dev|luminsdk|truffled/.test(
      searchURL,
    );
  if (isGame) {
    let processedURL = searchURL;
    if (
      !processedURL.includes("?") &&
      !processedURL.split("/").pop()!.includes(".")
    ) {
      processedURL = processedURL.endsWith("/")
        ? processedURL + "index.html"
        : processedURL + "/index.html";
    }
    navigateIframeTo(activeTab.iframe, getProxyUrl(processedURL));
  } else {
    const finalUrlToLoad = searchURL.includes("/assets/gs/")
      ? new URL(searchURL, window.location.origin).href
      : await getUrl(searchURL);

    const isProxyUrl =
      finalUrlToLoad.startsWith("/b/s/") || finalUrlToLoad.startsWith("/b/u/");
    if (isProxyUrl && (window as any).WavesApp?.waitForTransport) {
      let transportReady = false;
      try {
        await (window as any).WavesApp.waitForTransport(10000);
        transportReady = true;
      } catch (e: unknown) {
        console.warn(
          "transport not ready on first attempt, triggering recovery...",
          (e as Error).message,
        );
        if ((window as any).wavesConnection?.recoverOnWake) {
          try {
            await (window as any).wavesConnection.recoverOnWake();
            await (window as any).WavesApp.waitForTransport(8000);
            transportReady = true;
          } catch (retryErr: unknown) {
            console.error(
              "transport not ready after recovery, cannot navigate:",
              (retryErr as Error).message,
            );
          }
        }
      }
    }
    navigateIframeTo(activeTab.iframe, finalUrlToLoad);
  }
}

export function useSearchInputBindings({
  inputId,
  suggestionsId,
  activeTab = null,
  syncHistory = false,
}: SearchInputBindingsOptions): void {
  useEffect(() => {
    const input = document.getElementById(inputId) as HTMLInputElement | null;
    if (!input) return;

    const onInput = () => {
      if (!syncHistory || !activeTab?.historyManager) return;
      updateHistoryUI(activeTab as any, {
        currentUrl: input.value,
        canGoBack: activeTab.historyManager.canGoBack(),
        canGoForward: activeTab.historyManager.canGoForward(),
      });
    };

    const onFocus = () => {
      if (!syncHistory || !activeTab?.historyManager) return;
      updateHistoryUI(activeTab as any, {
        currentUrl: activeTab.historyManager.getCurrentUrl(),
        canGoBack: activeTab.historyManager.canGoBack(),
        canGoForward: activeTab.historyManager.canGoForward(),
      });
    };

    const onKeyup = async (e: KeyboardEvent) => {
      if (e.key !== "Enter" || document.activeElement !== input) return;
      const suggestions = suggestionsId
        ? document.getElementById(suggestionsId)
        : null;
      if (
        suggestions?.style.display === "block" &&
        suggestions.querySelector(".active")
      ) {
        return;
      }
      await (window as any).WavesApp?.handleSearch?.(input.value.trim());
      if (suggestions) suggestions.style.display = "none";
      input.blur();
    };

    input.addEventListener("input", onInput);
    input.addEventListener("focus", onFocus);
    input.addEventListener("keyup", onKeyup);

    return () => {
      input.removeEventListener("input", onInput);
      input.removeEventListener("focus", onFocus);
      input.removeEventListener("keyup", onKeyup);
    };
  }, [inputId, suggestionsId, activeTab, syncHistory]);
}