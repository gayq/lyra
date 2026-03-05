import { dom } from '../ui/dom.js';
import { BANGS, SEARCH_ENGINES } from '../core/config.js';
import { showBrowserView } from '../ui/ui.js';
import { navigateIframeTo, updateHistoryUI } from '../core/iframe.js';

function isBangQuery(query) { return query.trim().startsWith('!'); }

function parseBangQuery(query) {
    const trimmed = query.trim();
    if (!isBangQuery(trimmed)) return null;
    const parts = trimmed.substring(1).split(' ');
    if (parts.length === 0) return null;
    const bang = parts[0].toLowerCase();
    const searchQuery = parts.slice(1).join(' ');
    return { bang, searchQuery };
}

function executeBang(query) {
    const parsed = parseBangQuery(query);
    if (!parsed) return null;
    const { bang, searchQuery } = parsed;
    const bangData = BANGS[bang];
    if (!bangData) return null;
    return bangData.url.includes('{query}')
        ? bangData.url.replace('{query}', encodeURIComponent(searchQuery))
        : bangData.url;
}

function generateSearchUrl(query) {
    query = query.trim();
    const searchEngine = localStorage.getItem('searchEngine') ?? 'duckduckgo';
    const baseUrl = SEARCH_ENGINES[searchEngine] || SEARCH_ENGINES['duckduckgo'];
    if (!query) return searchEngine === 'duckduckgo' ? 'https://duckduckgo.com/?q=&ia=web' : baseUrl;
    if (/^[a-zA-Z]+:\/\//.test(query)) {
        try { new URL(query); return query; } catch { }
    }
    if (/^(localhost|(\d{1,3}\.){3}\d{1,3})(:\d+)?(\/.*)?$/i.test(query)) return `http://${query}`;
    if (!query.includes(' ')) {
        try {
            const urlWithHttps = new URL(`https://${query}`);
            if (urlWithHttps.hostname.includes('.') &&
                urlWithHttps.hostname.split('.').pop().length >= 2 &&
                !/^\d+$/.test(urlWithHttps.hostname.split('.').pop())) {
                return urlWithHttps.toString();
            }
        } catch { }
    }
    const finalUrl = baseUrl + encodeURIComponent(query);
    return searchEngine === 'duckduckgo' ? `${finalUrl}&ia=web` : finalUrl;
}

async function getUrl(url) {
    const selectedBackend = localStorage.getItem("backend") ?? "scramjet";
    if (selectedBackend === 'ultraviolet' && window['__uv$config']?.encodeUrl) {
        return window['__uv$config'].prefix + window['__uv$config'].encodeUrl(url);
    } else if (selectedBackend === 'scramjet') {
        await window.scramjetReady;
        return '/b/s/' + url;
    }
    return url;
}

export async function handleSearch(query, activeTab, gameName) {
    if (!activeTab || !query.trim()) return;
    showBrowserView();
    activeTab.isUrlLoaded = true;
    const searchURL = executeBang(query) || generateSearchUrl(query);
    const isGame = /jsdelivr|googleusercontent|githack|truffled|squall|velara|vsembed|vidsrc\.me|gn-math\.dev/.test(searchURL);
    if (isGame) {
        let processedURL = searchURL;
        if (!processedURL.includes('?') && !processedURL.split('/').pop().includes('.')) {
            processedURL = processedURL.endsWith('/') ? processedURL + 'index.html' : processedURL + '/index.html';
        }
        navigateIframeTo(activeTab.iframe, '/!!/' + processedURL);
    } else {
        const finalUrlToLoad = searchURL.includes('/assets/gs/')
            ? new URL(searchURL, window.location.origin).href
            : await getUrl(searchURL);

        const isProxyUrl = finalUrlToLoad.startsWith('/b/s/') || finalUrlToLoad.startsWith('/b/u/');
        if (isProxyUrl && window.WavesApp?.waitForTransport) {
            try {
                await window.WavesApp.waitForTransport(10000);
            } catch (e) {
                console.error('transport not ready, cannot navigate:', e.message);
                return;
            }
        }

        navigateIframeTo(activeTab.iframe, finalUrlToLoad);
    }
}

export function initializeSearch(getActiveTab) {
    const handleSearchKeyup = async (e) => {
        if (e.key !== 'Enter' || document.activeElement !== e.target) return;
        const input = e.target;
        const suggestions = document.getElementById(input === dom.searchInputMain ? 'suggestions-container' : 'suggestions-container-nav');
        if (suggestions?.style.display === 'block' && suggestions.querySelector('.active')) return;
        await window.WavesApp.handleSearch(input.value.trim());
        if (suggestions) suggestions.style.display = 'none';
        input.blur();
    };

    [dom.searchInputMain, dom.searchInputNav].forEach(input => {
        if (!input) return;

        input.addEventListener('input', () => {
            const activeTab = getActiveTab();
            if (input === dom.searchInputNav && activeTab) {
                updateHistoryUI(activeTab, {
                    currentUrl: input.value,
                    canGoBack: activeTab.historyManager.canGoBack(),
                    canGoForward: activeTab.historyManager.canGoForward()
                });
            }
        });

        input.addEventListener('keyup', handleSearchKeyup);
        if (input === dom.searchInputNav) {
            input.addEventListener('focus', () => {
                const activeTab = getActiveTab();
                if (activeTab?.historyManager) {
                    updateHistoryUI(activeTab, {
                        currentUrl: activeTab.historyManager.getCurrentUrl(),
                        canGoBack: activeTab.historyManager.canGoBack(),
                        canGoForward: activeTab.historyManager.canGoForward()
                    });
                }
            });
        }
    });
}