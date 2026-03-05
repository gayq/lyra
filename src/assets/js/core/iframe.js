import { dom } from '../ui/dom.js';
import { showLoading, hideLoading } from '../ui/ui.js';
import { decodeUrl, getProxyUrl } from './utils.js';

let loadingTimeout = null;

function getTabIdFromIframe(iframe) {
    if (!iframe) return null;
    const val = iframe.dataset?.tabId;
    if (!val) return null;
    const num = parseInt(val, 10);
    return Number.isNaN(num) ? null : num;
}

function detachContentWindowListeners(iframe) {
    try {
        const iframeWindow = iframe.contentWindow;
        if (!iframeWindow) return;
        if (iframeWindow.__beforeUnloadHandler) {
            iframeWindow.removeEventListener('beforeunload', iframeWindow.__beforeUnloadHandler);
            iframeWindow.__beforeUnloadHandler = null;
        }
        if (iframeWindow.__domContentLoadedHandler) {
            iframeWindow.removeEventListener('DOMContentLoaded', iframeWindow.__domContentLoadedHandler);
            iframeWindow.__domContentLoadedHandler = null;
        }
        if (iframeWindow.__wavesFocusHandler) {
            iframeWindow.removeEventListener('mousedown', iframeWindow.__wavesFocusHandler, true);
            iframeWindow.__wavesFocusHandler = null;
        }
    } catch (e) {
        console.warn('unable to detach iframe window listeners:', e);
    }
}

export function stopIframeLoading(iframe) {
    if (!iframe) return;
    const tabId = getTabIdFromIframe(iframe);

    if (loadingTimeout) clearTimeout(loadingTimeout);
    if (iframe.__usableTimeout) {
        clearTimeout(iframe.__usableTimeout);
        iframe.__usableTimeout = null;
    }

    try {
        if (iframe.contentWindow) iframe.contentWindow.stop();
    } catch (e) {
        console.warn('could not stop iframe loading:', e);
    }

    updateTabDetails(iframe);

    hideLoading(tabId);
    window.WavesApp.isLoading = false;
    iframe.classList.add('loaded');

    const tab = window.WavesApp?.tabs?.find(tab => tab.iframe === iframe);
    let currentUrl = iframe.dataset.manualUrl;
    if (!currentUrl) {
        try {
            currentUrl = iframe.contentWindow?.location?.href;
        } catch (e) {
            currentUrl = null;
        }
    }
    if (!currentUrl) currentUrl = iframe.src;

    if (tab && currentUrl && currentUrl !== 'about:blank') {
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

export function navigateIframeTo(iframe, url) {
    if (!url || !iframe) return;
    const tab = window.WavesApp.tabs.find(t => t.iframe === iframe);
    showLoading(tab?.id || getTabIdFromIframe(iframe));
    window.WavesApp.isLoading = true;
    delete iframe.dataset.reloadAttempted;
    iframe.classList.remove('loaded');

    if (tab) {
        if (!tab.fixedTitle) {
            tab.title = 'fetching data...';
        }
        if (!tab.fixedFavicon) {
            tab.favicon = null;
        }
        if (window.WavesApp.renderTabs) window.WavesApp.renderTabs();
    }

    iframe.dataset.navigationStarted = 'true';
    iframe.removeAttribute('srcdoc');
    delete iframe.dataset.manualUrl;

    if (iframe.__usableTimeout) {
        clearTimeout(iframe.__usableTimeout);
        iframe.__usableTimeout = null;
    }

    const isProxyUrl = url.startsWith('/b/s/') || url.startsWith('/b/u/');
    if (isProxyUrl && window.WavesApp?.waitForTransport) {
        window.WavesApp.waitForTransport(8000).then(() => {
            iframe.src = url;
        }).catch((e) => {
            console.error('navigateIframeTo: transport not ready, navigating anyway:', e.message);
            iframe.src = url;
        });
    } else {
        iframe.src = url;
    }
}

export function cleanupIframe(iframe) {
    if (!iframe) return;
    const handlers = iframe.__wavesInternalHandlers;
    if (handlers) {
        iframe.removeEventListener('error', handlers.onError);
        iframe.removeEventListener('load', handlers.onLoad);
        iframe.__wavesInternalHandlers = null;
    }
    detachContentWindowListeners(iframe);
    iframe.removeAttribute('srcdoc');
    iframe.removeAttribute('data-navigation-started');
    iframe.removeAttribute('data-reload-attempted');
    iframe.removeAttribute('data-manual-url');
    delete iframe.dataset.reloadCount;
    iframe.style.boxShadow = '';
    try {
        iframe.contentWindow?.stop?.();
    } catch (e) { }
    try {
        iframe.src = 'about:blank';
    } catch (e) { }
    iframe.classList.remove('loaded', 'active', 'active-split-left', 'active-split-right', 'active-focus');
}

export function reduceIframeMemory(iframe) {
    if (!iframe) return;
    try {
        const win = iframe.contentWindow;
        if (win && win.performance?.clearResourceTimings) {
            win.performance.clearResourceTimings();
        }
    } catch (e) { }
}

export function restoreIframeActivity(iframe) { return; }

function updateTabDetails(iframe) {
    const tabToUpdate = window.WavesApp.tabs.find(tab => tab.iframe === iframe);
    if (!tabToUpdate) return;
    const prevTitle = tabToUpdate.title;
    const prevFavicon = tabToUpdate.favicon;
    let isReloading = false;
    try {
        const iframeWindow = iframe.contentWindow;
        const doc = iframeWindow.document;
        const currentProxiedUrl = iframe.dataset.manualUrl || iframeWindow.location.href;
        const realUrl = decodeUrl(currentProxiedUrl);

        const newTitle = (doc.title || '').trim();
        if (!tabToUpdate.fixedTitle) {
            if (newTitle) {
                tabToUpdate.title = newTitle;
            } else if (tabToUpdate.title === 'fetching data...') {
                try {
                    tabToUpdate.title = new URL(realUrl).hostname || 'new tab';
                } catch (e) {
                    tabToUpdate.title = 'new tab';
                }
            }
        }

        if ((tabToUpdate.title === '404!!' || tabToUpdate.title === 'Scramjet' || tabToUpdate.title === 'Error')) {
            const MAX_RELOADS = 120;
            const MIN_INTERVAL_MS = 400;
            let reloadCount = parseInt(iframe.dataset.reloadCount || '0', 10);
            const lastReloadAt = parseInt(iframe.dataset.lastReloadAt || '0', 10);
            const now = Date.now();
            const cooldownReached = !lastReloadAt || (now - lastReloadAt) > MIN_INTERVAL_MS;
            const isActiveTab = document.body.classList.contains('split-view')
                ? (tabToUpdate.id === window.WavesApp?.splitPair?.left || tabToUpdate.id === window.WavesApp?.splitPair?.right || tabToUpdate.id === window.WavesApp?.getActiveTab?.()?.id)
                : (tabToUpdate.id === window.WavesApp?.getActiveTab?.()?.id);
            if (reloadCount < MAX_RELOADS && cooldownReached && isActiveTab) {
                iframe.dataset.reloadCount = (reloadCount + 1).toString();
                iframe.dataset.lastReloadAt = now.toString();
                isReloading = true;
                iframe.classList.remove('loaded');

                const currentUrl = iframe.dataset.manualUrl || iframe.src;
                navigateIframeTo(iframe, currentUrl);
                return;
            }
        }
        const iconLink = doc.querySelector("link[rel*='icon']");
        if (!tabToUpdate.fixedFavicon) {
            if (iconLink) {
                tabToUpdate.favicon = getProxyUrl(decodeUrl(iconLink.href));
            } else {
                try {
                    const realOrigin = new URL('/', realUrl).href;
                    tabToUpdate.favicon = getProxyUrl(new URL('favicon.ico', realOrigin).href);
                } catch (e) { tabToUpdate.favicon = null; }
            }
        }
    } catch (e) {
        tabToUpdate.title = prevTitle || 'new tab';
        if (!tabToUpdate.fixedFavicon) {
            tabToUpdate.favicon = prevFavicon || null;
        }
    } finally {
        if (!isReloading && window.WavesApp.renderTabs) window.WavesApp.renderTabs();
    }
}

function setupIframeContentListeners(iframe, historyManager, tabId) {
    try {
        const iframeWindow = iframe.contentWindow;
        const hasManualUrl = !!iframe.dataset.manualUrl;
        const isBlank = iframeWindow?.location?.href === 'about:blank';
        if (!iframeWindow || iframeWindow === window || (isBlank && !hasManualUrl)) return;

        const handleNav = (isReplace = false) => {
            const newUrlInIframe = iframeWindow.location.href;
            const baseManualUrl = iframe.dataset.manualUrl;
            let finalUrlToPush = newUrlInIframe;
            if (baseManualUrl && newUrlInIframe.startsWith('about:blank')) {
                try {
                    const newUrlObj = new URL(newUrlInIframe, window.location.origin);
                    const baseManualUrlObj = new URL(baseManualUrl);
                    baseManualUrlObj.hash = newUrlObj.hash;
                    baseManualUrlObj.search = newUrlObj.search;
                    finalUrlToPush = baseManualUrlObj.toString();
                } catch (e) { finalUrlToPush = newUrlInIframe; }
            }
            if (finalUrlToPush !== 'about:blank') {
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

        if (!iframeWindow.history.pushState.__isPatched) {
            const originalPushState = iframeWindow.history.pushState;
            iframeWindow.history.pushState = function (...args) {
                originalPushState.apply(this, args);
                handleNav();
            };
            iframeWindow.history.pushState.__isPatched = true;
        }
        if (!iframeWindow.history.replaceState.__isPatched) {
            const originalReplaceState = iframeWindow.history.replaceState;
            iframeWindow.history.replaceState = function (...args) {
                originalReplaceState.apply(this, args);
                handleNav(true);
            };
            iframeWindow.history.replaceState.__isPatched = true;
        }

        iframeWindow.addEventListener('beforeunload', () => {
            showLoading(tabId);
            window.WavesApp.isLoading = true;
            iframe.classList.remove('loaded');
            const tab = window.WavesApp.tabs.find(t => t.id === tabId);
            if (tab) {
                if (!tab.fixedTitle) {
                    tab.title = 'fetching data...';
                }
                if (!tab.fixedFavicon) {
                    tab.favicon = null;
                }
                if (window.WavesApp.renderTabs) window.WavesApp.renderTabs();
            }
        });

        iframeWindow.addEventListener('DOMContentLoaded', () => {
            if (loadingTimeout) clearTimeout(loadingTimeout);

            try {
                const currentUrl = iframeWindow.location.href;
                if (currentUrl && currentUrl !== 'about:blank') historyManager.replace(currentUrl);
            } catch (e) { }

            updateTabDetails(iframe);
        });

        iframeWindow.addEventListener('mousedown', () => {
            const focusEvent = new CustomEvent('iframe-focus', { detail: { tabId }, bubbles: false });
            iframe.dispatchEvent(focusEvent);
        }, true);
    } catch (e) { console.warn("could not attach listeners to iframe content."); }
}

export function updateHistoryUI(activeTab, { currentUrl, canGoBack, canGoForward }) {
    const stillExists = activeTab && window.WavesApp?.tabs?.some(tab => tab.id === activeTab.id);

    if (!activeTab || !activeTab.iframe || !stillExists) {
        if (dom.searchInputNav) dom.searchInputNav.value = '';
        if (dom.backBtn) dom.backBtn.classList.add('disabled');
        if (dom.forwardBtn) dom.forwardBtn.classList.add('disabled');
        if (dom.lockIcon) dom.lockIcon.className = 'fa-regular fa-magnifying-glass';
        return;
    }

    const { iframe } = activeTab;

    if (dom.backBtn && dom.forwardBtn) {
        dom.backBtn.classList.toggle('disabled', !canGoBack);
        dom.forwardBtn.classList.toggle('disabled', !canGoForward);
    }

    if (dom.searchInputNav) {
        const displayUrl = iframe.dataset.manualUrl || currentUrl || iframe.src;
        const decoded = decodeUrl(displayUrl);

        if (document.activeElement !== dom.searchInputNav) {
            dom.searchInputNav.value = (decoded === 'about:blank' || !decoded) ? '' : decoded;
        }

        if (dom.lockIcon) {
            const inputValue = dom.searchInputNav.value.trim().toLowerCase();
            const hasProtocol = /^[a-z]+:\/\//i.test(inputValue);

            if (!inputValue || inputValue === 'about:blank' || !hasProtocol) {
                dom.lockIcon.className = 'fa-regular fa-magnifying-glass';
            } else if (inputValue.startsWith('https://')) {
                dom.lockIcon.className = 'fa-regular fa-lock-keyhole';
            } else {
                dom.lockIcon.className = 'fa-regular fa-unlock-keyhole';
            }
        }
    }
}

export function initializeIframe(iframe, historyManager, tabId) {
    const onError = () => {
        if (loadingTimeout) clearTimeout(loadingTimeout);
        if (iframe.__usableTimeout) {
            clearTimeout(iframe.__usableTimeout);
            iframe.__usableTimeout = null;
        }
        hideLoading(tabId);
        window.WavesApp.isLoading = false;
    };

    const onLoad = () => {
        if (loadingTimeout) clearTimeout(loadingTimeout);
        if (iframe.__usableTimeout) {
            clearTimeout(iframe.__usableTimeout);
            iframe.__usableTimeout = null;
        }

        let newUrl;
        try {
            newUrl = iframe.dataset.manualUrl ?? iframe.contentWindow?.location.href ?? iframe.src;
        } catch (e) { newUrl = iframe.dataset.manualUrl ?? iframe.src; }

        if (newUrl && newUrl !== 'about:blank') historyManager.push(newUrl);

        updateTabDetails(iframe);

        hideLoading(tabId);
        window.WavesApp.isLoading = false;
        iframe.classList.add('loaded');

        setupIframeContentListeners(iframe, historyManager, tabId);
    };

    iframe.addEventListener('error', onError);
    iframe.addEventListener('load', onLoad);
    iframe.__wavesInternalHandlers = { onError, onLoad };
}