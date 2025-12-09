import { dom } from '../ui/dom.js';
import { BANGS, SEARCH_ENGINES } from '../core/config.js';
import { showLoading, hideLoading, showBrowserView } from '../ui/ui.js';
import { navigateIframeTo, updateHistoryUI } from '../core/iframe.js';

function isBangQuery(query) {
    return query.trim().startsWith('!');
}

function parseBangQuery(query) {
    const trimmed = query.trim();
    if (!isBangQuery(trimmed)) return null;
    const parts = trimmed.substring(1).split(' ');
    if (parts.length === 0) return null;
    const bang = parts[0].toLowerCase();
    if (!bang) return null;
    const searchQuery = parts.slice(1).join(' ');
    return { bang, searchQuery };
}

function executeBang(query) {
    const parsed = parseBangQuery(query);
    if (!parsed) return null;
    const { bang, searchQuery } = parsed;
    const bangData = BANGS[bang];
    if (!bangData) return null;
    if (bangData.url.includes('{query}')) {
        return bangData.url.replace('{query}', encodeURIComponent(searchQuery));
    } else {
        return bangData.url;
    }
}

function generateSearchUrl(query) {
    query = query.trim();
    const searchEngine = localStorage.getItem('searchEngine') ?? 'DuckDuckGo';
    const baseUrl = SEARCH_ENGINES[searchEngine] || SEARCH_ENGINES['DuckDuckGo'];

    if (!query) {
        return searchEngine === 'DuckDuckGo' ? 'https://duckduckgo.com/?q=&ia=web' : baseUrl;
    }
    if (/^[a-zA-Z]+:\/\//.test(query)) {
        try { new URL(query); return query; } catch {}
    }
    if (/^(localhost|(\d{1,3}\.){3}\d{1,3})(:\d+)?(\/.*)?$/i.test(query)) {
        return `http://${query}`;
    }
    if (!query.includes(' ')) {
        try {
            const urlWithHttps = new URL(`https://${query}`);
            if (
                urlWithHttps.hostname.includes('.') &&
                !urlWithHttps.hostname.endsWith('.') &&
                urlWithHttps.hostname !== '.' &&
                urlWithHttps.hostname.split('.').pop().length >= 2 &&
                !/^\d+$/.test(urlWithHttps.hostname.split('.').pop())
            ) {
                return urlWithHttps.toString();
            }
        } catch {}
    }
    const encodedQuery = encodeURIComponent(query);
    const finalUrl = baseUrl + encodedQuery;
    return searchEngine === 'DuckDuckGo' ? `${finalUrl}&ia=web` : finalUrl;
}

async function getUrl(url) {
    const selectedBackend = localStorage.getItem("backend") ?? "scramjet";
    if (selectedBackend === 'ultraviolet' && window['__uv$config']?.encodeUrl) {
        return window['__uv$config'].prefix + window['__uv$config'].encodeUrl(url);
    } else if (selectedBackend === 'scramjet') {
        try {
            await window.scramjetReady;
            return '/b/s/' + url;
        } catch (error) {
            console.error("Scramjet initialization failed:", error);
            throw new Error("Scramjet is not ready. Please try another backend.");
        }
    }
    return url;
}

export async function handleSearch(query, activeTab, gameName) {
    if (!activeTab) {
        showToast('error', 'No active tab found!', 'error');
        return;
    }
    if (!query.trim()) {
        showToast('error', 'Please enter something in the Search Bar!', 'warning');
        return;
    }

    showBrowserView();
    activeTab.isUrlLoaded = true;

    const bangUrl = executeBang(query);
    let searchURL = bangUrl || generateSearchUrl(query);

    const isGame = searchURL.startsWith("https://cdn.jsdelivr.net/gh/gn-math/html@main/") || 
                   searchURL.startsWith("https://googleusercontent.b-cdn.net/") ||
                   searchURL.startsWith("https://rawcdn.githack.com/") ||
                   searchURL.startsWith("https://selenite.cc/") ||
                   searchURL.startsWith("https://truffled.lol/") ||
                   searchURL.startsWith("https://velara.cc/") ||
                   searchURL.startsWith("https://maddox05.github.io/") ||
                   searchURL.startsWith("https://classroomlesson.github.io/");

    if (isGame) {
        try {
            let processedURL = searchURL;
            const path = new URL(searchURL).pathname;
            const lastSegment = path.split('/').pop();
            const isFile = lastSegment.includes('.');

            if (!isFile) {
                if (!processedURL.endsWith('/')) {
                    processedURL += '/';
                }
                processedURL += 'index.html';
            }

            const pedUrl = '/!!/' + processedURL;
            
            navigateIframeTo(activeTab.iframe, pedUrl);

            activeTab.iframe.addEventListener('load', () => {
            }, { once: true });

            if (activeTab.historyManager && typeof activeTab.historyManager.add === 'function') {
                activeTab.historyManager.push(searchURL);
            }

            updateHistoryUI(activeTab, {
                currentUrl: searchURL,
                canGoBack: activeTab.historyManager.canGoBack(),
                canGoForward: activeTab.historyManager.canGoForward()
            });

        } catch (error) {
            showToast('error', error.message || 'Failed to load game content.', 'error');
        }
    } else {
        try {
            if (!gameName) {
                showLoading();
            } else {
                activeTab.iframe.addEventListener('load', () => {
                }, { once: true });
                
                setTimeout(() => {
                }, 10000);
            }

            let finalUrlToLoad;
            if (searchURL.includes('/assets/gs/')) {
                finalUrlToLoad = new URL(searchURL, window.location.origin).href;
            } else {
                finalUrlToLoad = await getUrl(searchURL);
            }
            
            navigateIframeTo(activeTab.iframe, finalUrlToLoad);

            updateHistoryUI(activeTab, {
                currentUrl: finalUrlToLoad,
                canGoBack: activeTab.historyManager.canGoBack(),
                canGoForward: activeTab.historyManager.canGoForward()
            });
        } catch (error) {
            showToast('error', error.message || 'Failed to generate a valid URL. Please try again.', 'error');
        }
    }
}

export function initializeSearch(getActiveTab) {
    const handleSearchKeyup = async (e) => {
        const input = e.target;
        if (e.key !== 'Enter' || document.activeElement !== input) return;
        const suggestionsContainerId = (input === dom.searchInputMain) ? 'suggestions-container' : 'suggestions-container-nav';
        const suggestionsContainer = document.getElementById(suggestionsContainerId);
        const isSuggestionsVisible = suggestionsContainer && suggestionsContainer.style.display === 'block';

        if (isSuggestionsVisible && suggestionsContainer.querySelector('.active')) return;
        
        const queryValue = input.value.trim();
        await window.WavesApp.handleSearch(queryValue);
        if (suggestionsContainer) suggestionsContainer.style.display = 'none';
        input.blur();
    };

    [dom.searchInputMain, dom.searchInputNav].forEach(input => {
        if (!input) return;
        input.addEventListener('keyup', handleSearchKeyup);
        if (input === dom.searchInputNav) {
            input.addEventListener('focus', () => {
                const activeTab = getActiveTab();
                if (activeTab && activeTab.historyManager) {
                     updateHistoryUI(activeTab, {
                        currentUrl: activeTab.historyManager.getCurrentUrl(),
                        canGoBack: activeTab.historyManager.canGoBack(),
                        canGoForward: activeTab.historyManager.canGoForward()
                    })
                }
            });
        }
    });
}