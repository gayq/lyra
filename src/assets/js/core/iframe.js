import { dom } from '../ui/dom.js';
import { showLoading, hideLoading } from '../ui/ui.js';
import { decodeUrl, getProxyUrl } from './utils.js';

let loadingTimeout = null;
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
        console.warn('Unable to detach iframe window listeners:', e);
    }
}

export function stopIframeLoading(iframe) {
    if (!iframe) return;

    if (loadingTimeout) clearTimeout(loadingTimeout);

    try {
        if (iframe.contentWindow) {
            iframe.contentWindow.stop();
        }
    } catch (e) {
        console.warn('Could not stop iframe loading:', e);
    }

    hideLoading();
    window.WavesApp.isLoading = false;

    iframe.classList.add('loaded');

    updateTabDetails(iframe);
}

export function navigateIframeTo(iframe, url) {
    if (!url || !iframe) return;
    showLoading();
    window.WavesApp.isLoading = true;
    delete iframe.dataset.reloadAttempted;

    iframe.classList.remove('loaded');

    const tab = window.WavesApp.tabs.find(t => t.iframe === iframe);
    if (tab) {
        tab.title = 'Loading...';
        tab.favicon = null;
        if (window.WavesApp.renderTabs) {
            window.WavesApp.renderTabs();
        }
    }

    iframe.dataset.navigationStarted = 'true';

    iframe.removeAttribute('srcdoc'); 
    delete iframe.dataset.manualUrl;
    iframe.src = url;
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
    } catch (e) {}

    try {
        iframe.src = 'about:blank';
    } catch (e) {}

    iframe.classList.remove('loaded', 'active', 'active-split-left', 'active-split-right', 'active-focus');
}

function updateTabDetails(iframe) {
    const tabToUpdate = window.WavesApp.tabs.find(tab => tab.iframe === iframe);
    
    if (!tabToUpdate) return;

    let isReloading = false; 

    try {
        const iframeWindow = iframe.contentWindow;
        const doc = iframeWindow.document;
        const currentProxiedUrl = iframe.dataset.manualUrl || iframeWindow.location.href;
        
        const realUrl = decodeUrl(currentProxiedUrl);
        
        const newTitle = doc.title;
        if (newTitle && newTitle.trim() !== '') {
            tabToUpdate.title = newTitle;
        } else {
            tabToUpdate.title = iframeWindow.location.hostname || 'New Tab';
        }

        if ((tabToUpdate.title === '404!!' || tabToUpdate.title === 'Scramjet' || tabToUpdate.title === 'Error')) {
            let reloadCount = parseInt(iframe.dataset.reloadCount || '0', 10);
            if (reloadCount < 400) {
                try {
                    iframe.dataset.reloadCount = (reloadCount + 1).toString();
                    isReloading = true;
                    iframe.classList.remove('loaded');
                    iframe.contentWindow.location.reload(true);
                    return;
                } catch (e) {
                    console.warn('Could not force reload page:', e);
                }
            }
        }

        const iconLink = doc.querySelector("link[rel*='icon']");
        if (iconLink) {
            const resolvedProxiedIconUrl = iconLink.href;
            const realIconUrl = decodeUrl(resolvedProxiedIconUrl);
            tabToUpdate.favicon = getProxyUrl(realIconUrl);
        } else {
            try {
                const realOrigin = new URL('/', realUrl).href;
                const defaultIconUrl = new URL('favicon.ico', realOrigin).href;
                tabToUpdate.favicon = getProxyUrl(defaultIconUrl);
            } catch (e) {
                tabToUpdate.favicon = null;
            }
        }
    } catch (e) {
        tabToUpdate.title = 'New Tab';
        tabToUpdate.favicon = null;
    } finally {
        if (!isReloading && window.WavesApp.renderTabs) {
            window.WavesApp.renderTabs();
        }
    }
}

function setupIframeContentListeners(iframe, historyManager, tabId) {
    try {
        const iframeWindow = iframe.contentWindow;
        
        const hasManualUrl = !!iframe.dataset.manualUrl;
        const isBlank = iframeWindow?.location?.href === 'about:blank';

        if (!iframeWindow || iframeWindow === window || (isBlank && !hasManualUrl)) {
            return;
        }

        const baseUrl = iframe.dataset.manualUrl || iframeWindow.location.href;

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
                } catch (e) {
                    finalUrlToPush = newUrlInIframe;
                }
            }

            if (finalUrlToPush !== 'about:blank') {
                if (isReplace) {
                    historyManager.replace(finalUrlToPush);
                } else {
                    if (finalUrlToPush !== baseUrl) {
                        historyManager.push(finalUrlToPush);
                    }
                }
            }
        };

        if (!iframeWindow.history.pushState.__isPatched) {
            const originalPushState = iframeWindow.history.pushState;
            iframeWindow.history.pushState = function(...args) {
                originalPushState.apply(this, args);
                handleNav();
            };
            iframeWindow.history.pushState.__isPatched = true;
        }
        if (!iframeWindow.history.replaceState.__isPatched) {
            const originalReplaceState = iframeWindow.history.replaceState;
            iframeWindow.history.replaceState = function(...args) {
                originalReplaceState.apply(this, args);
                handleNav(true);
            };
            iframeWindow.history.replaceState.__isPatched = true;
        }

        iframeWindow.removeEventListener('beforeunload', iframeWindow.__beforeUnloadHandler);
        iframeWindow.__beforeUnloadHandler = () => {
            showLoading();
            window.WavesApp.isLoading = true;
            
            iframe.classList.remove('loaded');

            const tab = window.WavesApp.tabs.find(t => t.id === tabId);
            if (tab) {
                tab.title = 'Loading...';
                tab.favicon = null;
                if (window.WavesApp.renderTabs) {
                    window.WavesApp.renderTabs();
                }
            }
        }
        iframeWindow.addEventListener('beforeunload', iframeWindow.__beforeUnloadHandler);

        iframeWindow.removeEventListener('DOMContentLoaded', iframeWindow.__domContentLoadedHandler);
        iframeWindow.__domContentLoadedHandler = () => {
            if (loadingTimeout) clearTimeout(loadingTimeout);
            hideLoading();
            window.WavesApp.isLoading = false;

            historyManager.push(baseUrl);
            
            updateTabDetails(iframe);
        };
        iframeWindow.addEventListener('DOMContentLoaded', iframeWindow.__domContentLoadedHandler);
        
        iframeWindow.removeEventListener('mousedown', iframeWindow.__wavesFocusHandler, true);
        iframeWindow.__wavesFocusHandler = () => {
            const focusEvent = new CustomEvent('iframe-focus', { 
                detail: { tabId: tabId }, 
                bubbles: false 
            });
            iframe.dispatchEvent(focusEvent);
        };
        iframeWindow.addEventListener('mousedown', iframeWindow.__wavesFocusHandler, true);
        
    } catch (e) {
        console.warn("Could not attach listeners to iframe content. Likely transient state or cross-origin.");
    }
}


export function updateHistoryUI(activeTab, { currentUrl, canGoBack, canGoForward }) {
    const stillExists = activeTab && window.WavesApp?.tabs?.some(tab => tab.id === activeTab.id);

    if (!activeTab || !activeTab.iframe || !stillExists) {
        if (dom.searchInputNav) dom.searchInputNav.value = '';
        if (dom.backBtn) dom.backBtn.classList.add('disabled');
        if (dom.forwardBtn) dom.forwardBtn.classList.add('disabled');
        if (dom.lockIcon) dom.lockIcon.className = 'fa-regular fa-unlock-keyhole';
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
        
        dom.searchInputNav.value = decoded;
        if (dom.lockIcon) {
            const isSecure = decoded && decoded.startsWith('https://');
            dom.lockIcon.className = isSecure ? 'fa-regular fa-lock-keyhole' : 'fa-regular fa-unlock-keyhole';
        }
    }
}

export function initializeIframe(iframe, historyManager, tabId) {
    const onError = () => {
        if (loadingTimeout) clearTimeout(loadingTimeout);
        hideLoading();
        window.WavesApp.isLoading = false;
    };

    const onLoad = () => {
        if (loadingTimeout) clearTimeout(loadingTimeout);

        hideLoading();
        window.WavesApp.isLoading = false;

        iframe.classList.add('loaded');

        const manualUrl = iframe.dataset.manualUrl;
        let newUrl;
        try {
            newUrl = manualUrl ?? iframe.contentWindow?.location.href ?? iframe.src;
        } catch (e) {
            newUrl = manualUrl ?? iframe.src;
        }
        
        if (newUrl !== 'about:blank') {
            historyManager.push(newUrl);
        }

        updateTabDetails(iframe);

        try {
            setupIframeContentListeners(iframe, historyManager, tabId);
        } catch (e) {
        }

        window.WavesApp.updateNavbarDisplay?.();
    };

    iframe.addEventListener('error', onError);
    iframe.addEventListener('load', onLoad);
    iframe.__wavesInternalHandlers = { onError, onLoad };
}
