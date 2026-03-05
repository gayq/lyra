import { dom } from './ui/dom.js';
import { HistoryManager } from './core/history.js';
import { initializeUI, hideLoading, showHomeView, showBrowserView, syncRefreshButtonWithActiveTab } from './ui/ui.js';
import { initializeIframe, updateHistoryUI, cleanupIframe, reduceIframeMemory, restoreIframeActivity } from './core/iframe.js';
import { initializeSearch, handleSearch as performSearch } from './search/search.js';
import { initializeBookmarks } from './features/bookmarks.js';
import { initializeNotifications } from './features/notifications.js';
import { initializeLayout, initializeFall } from './core/layout.js';
import { initializeLoad } from './core/load.js';
import { initializeGame } from './features/games.js';
import './features/cloudsync.js';
import { getProxyUrl } from './core/utils.js';

const clientTabMap = new Map();
const tabMemory = new Map();
const lastOpenTabRequest = { url: null, ts: 0 };

const mDecode = (str) => {
    if (!str) return null;
    const key = "wb!";
    try {
        const d = atob(str);
        let x = '';
        for (let i = 0; i < d.length; i++) {
            x += String.fromCharCode(d.charCodeAt(i) ^ key.charCodeAt(i % key.length));
        }
        return decodeURIComponent(x);
    } catch (e) { return str; }
};

function clearHistoryNavigation(tab, incomingUrl) {
    if (!tab || !tab._historyNavigating) return;
    if (!tab._historyTarget || tab._historyTarget === incomingUrl) {
        tab._historyNavigating = false;
        tab._historyTarget = null;
    }
}

function updateMemoryDisplay() {
    const valueEl = dom.memoryUsageValue;
    if (!valueEl) return;

    const tabs = window.WavesApp?.tabs || [];
    let total = 0;
    let hasData = false;

    for (const tab of tabs) {
        const snap = tabMemory.get(tab.id);
        if (snap && typeof snap.usedJSHeapSize === 'number') {
            total += snap.usedJSHeapSize;
            hasData = true;
        }
    }

    if (!hasData) {
        valueEl.textContent = '--';
        return;
    }

    const mb = total / 1048576;
    const precision = mb >= 100 ? 0 : 1;
    valueEl.textContent = `${mb.toFixed(precision)} MB`;
}

function handleServiceWorkerMessage(event) {
    const { data } = event;
    if (data && data.type === 'open-new-tab') {
        const targetUrl = data.decodedUrl || data.url || null;
        if (!targetUrl) return;

        const now = Date.now();
        if (lastOpenTabRequest.url === targetUrl && (now - lastOpenTabRequest.ts) < 750) {
            return;
        }
        lastOpenTabRequest.url = targetUrl;
        lastOpenTabRequest.ts = now;

        const openFn = window.WavesApp?.openNewTabFromServiceWorker;
        if (typeof openFn === 'function' && targetUrl) {
            const openerTabId = data.tabId ? parseInt(data.tabId, 10) : null;
            openFn(targetUrl, {
                openerTabId,
                title: data.title || targetUrl
            });
        }
        return;
    }
    if (data && data.type === 'page-meta') {
        const isEncoded = !!data.encoded;

        const incomingUrl = isEncoded ? mDecode(data.url) : (data.url || data.href || data.decodedUrl || null);
        const incomingDecodedUrl = isEncoded ? mDecode(data.decodedUrl) : (data.decodedUrl || data.url || data.href || null);
        const incomingTitle = isEncoded ? mDecode(data.title) : (typeof data.title === 'string' ? data.title : '');
        const incomingFavicon = isEncoded ? mDecode(data.favicon) : (data.favicon || data.rawFavicon || null);
        const incomingRawFavicon = isEncoded ? mDecode(data.rawFavicon) : (data.rawFavicon || data.favicon || null);

        const tabs = window.WavesApp?.tabs || [];
        const targetTabId = data.tabId ? parseInt(data.tabId, 10) : null;
        let targetTab = null;

        if (targetTabId) {
            targetTab = tabs.find(tab => tab.id === targetTabId) || null;
            if (targetTab && data.clientId) {
                clientTabMap.set(data.clientId, targetTab.id);
            }
        }

        if (!targetTab && data.clientId && clientTabMap.has(data.clientId)) {
            const mappedId = clientTabMap.get(data.clientId);
            targetTab = tabs.find(tab => tab.id === mappedId) || null;
        }

        if (!targetTab && data.isTopFrame && incomingDecodedUrl) {
            const match = tabs.find(tab => tab.historyManager?.getCurrentUrl?.() === incomingDecodedUrl);
            if (match) {
                targetTab = match;
                if (data.clientId) clientTabMap.set(data.clientId, match.id);
            }
        }

        if (!targetTab && data.isTopFrame && incomingDecodedUrl) {
            try {
                const incomingHost = new URL(incomingDecodedUrl).host;
                const hostMatch = tabs.find(tab => {
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
            } catch (e) { }
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

        if (typeof incomingTitle === 'string' && !targetTab.fixedTitle) {
            if (incomingTitle.trim() !== '') {
                targetTab.title = incomingTitle;
            }
        }

        if (data.memory && typeof data.memory.usedJSHeapSize === 'number') {
            tabMemory.set(targetTab.id, data.memory);
        }

        const faviconUrl = incomingFavicon ?? incomingRawFavicon ?? null;
        if (faviconUrl && !targetTab.fixedFavicon) {
            const proxiedFavicon = faviconUrl.startsWith('/!!/') ? faviconUrl : getProxyUrl(faviconUrl);
            targetTab.favicon = proxiedFavicon;
        }

        if (window.WavesApp.renderTabs) {
            window.WavesApp.renderTabs();
        }

        if (targetTab.historyManager) {
            updateHistoryUI(targetTab, {
                currentUrl: targetTab.historyManager.getCurrentUrl(),
                canGoBack: targetTab.historyManager.canGoBack(),
                canGoForward: targetTab.historyManager.canGoForward(),
            });
        }
        updateMemoryDisplay();
        return;
    }
    if (data && data.type === 'url-update' && data.url) {
        const activeTab = window.WavesApp.getActiveTab();

        if (activeTab && activeTab.historyManager) {
            activeTab.historyManager.push(data.url);

            if (!activeTab.isUrlLoaded) {
                activeTab.isUrlLoaded = true;
                showBrowserView();
            }
        }
    }
}

document.addEventListener('DOMContentLoaded', () => {
    initializeLayout();
    dom.init();
    initializeFall();
    initializeLoad();
    initializeGame();

    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.addEventListener('message', handleServiceWorkerMessage);
    }
    window.addEventListener('message', handleServiceWorkerMessage);
    window.WavesApp = window.WavesApp || {};
    window.WavesApp.isLoading = false;

    if (dom.newTabModal) {
        dom.newTabModal.style.display = '';
    }

    let tabs = [];
    window.WavesApp.tabs = tabs;

    let activeTabId = null;
    let splitPair = { left: null, right: null };
    window.WavesApp.splitPair = splitPair;
    let isPickingSplitTab = false;

    let allGames = window.WavesApp.allGames || [];
    window.WavesApp.allGames = allGames;

    let newTabUnifiedWrapper = null;
    let newTabResultsContainer = null;
    let newTabInputEl = document.createElement('input');
    newTabInputEl.type = 'text';
    newTabInputEl.id = 'newTabInput';
    newTabInputEl.placeholder = 'search or enter address';
    newTabInputEl.autocomplete = 'off';

    const SOURCE_CONFIG = {
        gnMath: {
            zones: "https://cdn.jsdelivr.net/gh/gn-math/assets@main/zones.json",
            html: "https://cdn.jsdelivr.net/gh/gn-math/html@main",
            covers: "https://cdn.jsdelivr.net/gh/gn-math/covers@main"
        },
        squall: {
            games: "https://squall.cc/games/games.json",
            assets: "https://squall.cc"
        },
        truffled: {
            games: "https://truffled.lol/js/json/g.json",
            assets: "https://truffled.lol"
        },
        velara: {
            games: "https://velara.cc/json/gg.json",
            assets: "https://velara.cc"
        }
    };

    function loadNewTabGameData() {
        if (allGames.length > 0) return Promise.resolve(allGames);

        const source = localStorage.getItem('gameSource') || 'gn-math';
        let fetchPromise;

        if (source === 'truffled') {
            fetchPromise = fetch(`/!!/${SOURCE_CONFIG.truffled.games}`)
                .then(res => res.ok ? res.json() : Promise.reject(res.statusText))
                .then(data => (data.games || []).map(game => {
                    let finalUrl = game.url.startsWith('http') ? game.url : SOURCE_CONFIG.truffled.assets + (game.url.startsWith('/') ? '' : '/') + game.url;
                    let finalCover = game.thumbnail ? (game.thumbnail.startsWith('http') ? game.thumbnail : SOURCE_CONFIG.truffled.assets + (game.thumbnail.startsWith('/') ? '' : '/') + game.thumbnail) : '';
                    return {
                        name: game.name,
                        gameUrl: finalUrl,
                        isExternal: false,
                        coverUrl: finalCover ? `/!!/${finalCover}` : null
                    };
                }));
        } else if (source === 'velara') {
            fetchPromise = fetch(`/!!/${SOURCE_CONFIG.velara.games}`)
                .then(res => res.ok ? res.json() : Promise.reject(res.statusText))
                .then(data => data
                    .filter(g => g.name !== '!!DMCA' && g.name !== '!!Game Request')
                    .map(game => {
                        let finalUrl = game.link;
                        if (finalUrl && !finalUrl.startsWith('http')) finalUrl = SOURCE_CONFIG.velara.assets + (finalUrl.startsWith('/') ? '' : '/') + finalUrl;
                        else if (game.grdmca) finalUrl = game.grdmca;

                        return {
                            name: game.name,
                            gameUrl: finalUrl,
                            isExternal: !game.link && !!game.grdmca,
                            coverUrl: game.image ? `/!!/${SOURCE_CONFIG.velara.assets}/${game.image}` : null
                        };
                    }));
        } else if (source === 'squall') {
            fetchPromise = fetch(`/!!/${SOURCE_CONFIG.squall.games}`)
                .then(res => res.ok ? res.json() : Promise.reject(res.statusText))
                .then(data => data.map(game => {
                    let finalUrl = game.link.startsWith('http') ? game.link : SOURCE_CONFIG.squall.assets + '/games/' + (game.link.startsWith('/') ? game.link.substring(1) : game.link);
                    let finalCover = game.cover.startsWith('http') ? game.cover : SOURCE_CONFIG.squall.assets + '/games/' + (game.cover.startsWith('/') ? game.cover.substring(1) : game.cover);
                    return {
                        name: game.name,
                        gameUrl: finalUrl,
                        isExternal: false,
                        coverUrl: finalCover ? `/!!/${finalCover}` : null
                    };
                }));
        } else {
            fetchPromise = fetch(`/!!/${SOURCE_CONFIG.gnMath.zones}`)
                .then(res => {
                    if (!res.ok) throw new Error(`network response was not ok: ${res.statusText}`);
                    return res.json();
                })
                .then(data => data
                    .map(zone => {
                        const isExternal = zone.url.startsWith('http');
                        return {
                            id: zone.id,
                            name: zone.name,
                            gameUrl: isExternal ? zone.url : `https://gn-math.dev/?id=${zone.id}`,
                            isExternal: isExternal,
                            coverUrl: zone.cover ? `/!!/${zone.cover.replace('{COVER_URL}', SOURCE_CONFIG.gnMath.covers)}` : null
                        };
                    })
                    .filter(game => !game.name.startsWith('[!]') && !game.name.startsWith('Chat Bot'))
                );
        }

        return fetchPromise
            .then(loadedGames => {
                loadedGames.sort((a, b) => a.name.localeCompare(b.name));
                allGames.splice(0, allGames.length, ...loadedGames);
                window.WavesApp.allGames = allGames;
                return allGames;
            })
            .catch(err => {
                console.error('failed to load new tab game data:', err);
                return [];
            });
    }

    document.addEventListener('gameSourceUpdated', () => {
        allGames.length = 0;
    });

    const toggleSidebarBtn = document.getElementById('toggle-sidebar-btn');
    if (toggleSidebarBtn) {
        toggleSidebarBtn.addEventListener('click', (e) => {
            e.preventDefault();
            document.body.classList.toggle('sidebar-hidden');
            const isHidden = document.body.classList.contains('sidebar-hidden');
            localStorage.setItem('sidebarHidden', isHidden);
        });
    }

    if (localStorage.getItem('sidebarHidden') === 'true') {
        document.body.classList.add('sidebar-hidden');
    }

    function getActiveTab() {
        return tabs.find(tab => tab.id === activeTabId);
    }

    window.WavesApp.getActiveTab = getActiveTab;

    function createIframe() {
        const iframe = document.createElement('iframe');
        iframe.className = 'iframe';
        iframe.loading = 'lazy';
        iframe.allow = 'fullscreen; camera; microphone; display-capture; clipboard-read; clipboard-write; autoplay;';
        iframe.referrerPolicy = 'no-referrer';
        iframe.tabIndex = -1;
        dom.iframeContainer.appendChild(iframe);
        return iframe;
    }

    function updateSplitButtonState() {
        if (dom.splitViewBtn) {
            const isSplitPairDefined = splitPair.left !== null && splitPair.right !== null;
            const isPicking = isPickingSplitTab;

            dom.splitViewBtn.classList.toggle('active', isSplitPairDefined || isPicking);

            dom.splitViewBtn.disabled = tabs.length <= 1 && !isSplitPairDefined && !isPicking;

            dom.splitViewBtn.classList.toggle('disabled', dom.splitViewBtn.disabled);
        }
    }

    function updateIframeView() {
        const isSplitPairDefined = splitPair.left !== null &&
            splitPair.right !== null &&
            tabs.some(t => t.id === splitPair.left) &&
            tabs.some(t => t.id === splitPair.right);

        if (!isSplitPairDefined && !isPickingSplitTab) {
            splitPair.left = null;
            splitPair.right = null;
        }

        const isSplitViewActive = isSplitPairDefined && (activeTabId === splitPair.left || activeTabId === splitPair.right);

        const isPicking = isPickingSplitTab;

        if (isSplitViewActive) {
            isPickingSplitTab = false;
        }

        document.body.classList.toggle('split-view', isSplitViewActive);
        document.body.classList.toggle('is-picking-split', isPicking);

        let leftIframe = null;
        let rightIframe = null;

        tabs.forEach(tab => {
            tab.iframe.classList.remove('active-focus');

            const isSplitLeft = (isSplitViewActive && tab.id === splitPair.left) || (isPicking && tab.id === splitPair.left);
            const isSplitRight = isSplitViewActive && tab.id === splitPair.right;
            const isSingleActive = !isSplitViewActive && !isPicking && tab.id === activeTabId;

            tab.iframe.classList.toggle('active-split-left', isSplitLeft);
            tab.iframe.classList.toggle('active-split-right', isSplitRight);
            tab.iframe.classList.toggle('active', isSingleActive);

            const isActiveFocus = (isSplitViewActive || isPicking) && tab.id === activeTabId;
            if (isActiveFocus) tab.iframe.classList.add('active-focus');

            if (isSplitViewActive || isPicking) {
                tab.iframe.style.boxShadow = isActiveFocus ? '0 0 0 1px #ffffff80' : 'none';
            } else {
                tab.iframe.style.boxShadow = '';
            }

            if (isSplitLeft) leftIframe = tab.iframe;
            if (isSplitRight) rightIframe = tab.iframe;

            if (!isSplitViewActive && !isPicking) {
                tab.iframe.style.width = null;
                tab.iframe.style.flexBasis = null;
                tab.iframe.style.flexGrow = null;
            }
        });

        if ((isSplitViewActive || isPicking) && leftIframe) {
            const gap = 0;

            let leftBasis = leftIframe.style.flexBasis;
            if (!leftBasis || leftBasis === 'auto' || leftBasis === '0px') {
                leftBasis = `calc(50% - ${gap / 2}px)`;
            }

            leftIframe.style.flexGrow = '0';
            leftIframe.style.flexBasis = leftBasis;

            if (rightIframe) {
                rightIframe.style.flexGrow = '1';
                rightIframe.style.flexBasis = '0';
            }
        }

        const activeTab = getActiveTab();
        if (activeTab) {
            updateHistoryUI(activeTab, {
                currentUrl: activeTab.historyManager.getCurrentUrl(),
                canGoBack: activeTab.historyManager.canGoBack(),
                canGoForward: activeTab.historyManager.canGoForward(),
            });
        }

        renderTabs();
        updateSplitButtonState();
    }


    const DEFAULT_FAVICON = 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path fill="%23818181" d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1h-2v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z"/></svg>';

    const applyIconSrc = (iconEl, iconContainer, nextSrc) => {
        const safeSrc = nextSrc || DEFAULT_FAVICON;
        iconEl.dataset.src = nextSrc || '';
        iconContainer.classList.add('skeleton');

        if (!iconEl.__wavesIconHandlersAttached) {
            iconEl.onload = () => iconContainer.classList.remove('skeleton');
            iconEl.onerror = () => {
                iconContainer.classList.remove('skeleton');
                iconEl.src = DEFAULT_FAVICON;
                iconEl.dataset.src = '';
            };
            iconEl.__wavesIconHandlersAttached = true;
        }

        iconEl.src = safeSrc;
    };

    function createTabElement(tab) {
        const tabEl = document.createElement('div');
        tabEl.className = 'tab';
        tabEl.dataset.tabId = tab.id;

        const iconContainer = document.createElement('div');
        iconContainer.className = 'tab-icon';

        const iconEl = document.createElement('img');
        iconEl.loading = 'eager';
        iconEl.decoding = 'async';
        applyIconSrc(iconEl, iconContainer, tab.favicon);

        iconContainer.appendChild(iconEl);

        const titleEl = document.createElement('span');
        titleEl.className = 'tab-title';
        titleEl.textContent = tab.title;

        const closeBtn = document.createElement('button');
        closeBtn.className = 'tab-close';
        closeBtn.innerHTML = '<i class="fa-regular fa-times"></i>';

        if (tabs.length <= 1) {
            closeBtn.style.display = 'none';
        }

        tabEl.appendChild(iconContainer);
        tabEl.appendChild(titleEl);
        tabEl.appendChild(closeBtn);

        return tabEl;
    }

    let _renderRaf = 0;
    function renderTabs() {
        if (_renderRaf) return;
        _renderRaf = requestAnimationFrame(_renderTabsNow);
    }
    function _renderTabsNow() {
        _renderRaf = 0;
        const container = dom.tabsContainer;
        const existing = new Map();
        for (let n = container.firstElementChild; n; n = n.nextElementSibling) {
            const id = parseInt(n.dataset.tabId || '0', 10);
            if (!isNaN(id)) existing.set(id, n);
        }

        const isSplitPairDefined = splitPair.left !== null && splitPair.right !== null;
        const isSplitLayoutActive = document.body.classList.contains('split-view');
        const showClose = tabs.length > 1;
        let prev = null;

        for (let i = 0; i < tabs.length; i++) {
            const tab = tabs[i];
            let tabEl = existing.get(tab.id);
            if (!tabEl) {
                tabEl = createTabElement(tab);
            } else {
                existing.delete(tab.id);
                const titleEl = tabEl.querySelector('.tab-title');
                if (titleEl && titleEl.textContent !== tab.title) {
                    titleEl.textContent = tab.title;
                }
                const iconEl = tabEl.querySelector('img');
                if (iconEl) {
                    const currentSrc = iconEl.dataset.src || '';
                    const nextSrc = tab.favicon || '';
                    if (currentSrc !== nextSrc) {
                        applyIconSrc(iconEl, tabEl.querySelector('.tab-icon'), nextSrc);
                    }
                }
                tabEl.className = 'tab';
            }

            if (isSplitPairDefined && (tab.id === splitPair.left || tab.id === splitPair.right)) {
                tabEl.classList.add('split-pair');
                if (tab.id === splitPair.left) tabEl.classList.add('split-pair-left');
                if (tab.id === splitPair.right) tabEl.classList.add('split-pair-right');
            }

            if (isSplitLayoutActive) {
                if (tab.id === splitPair.left) {
                    tabEl.classList.add('active', 'split-active-left');
                } else if (tab.id === splitPair.right) {
                    tabEl.classList.add('active', 'split-active-right');
                }
            } else if (tab.id === activeTabId) {
                tabEl.classList.add('active');
            }

            const closeBtn = tabEl.querySelector('.tab-close');
            if (closeBtn) closeBtn.style.display = showClose ? '' : 'none';

            const expected = prev ? prev.nextElementSibling : container.firstElementChild;
            if (tabEl !== expected) {
                container.insertBefore(tabEl, expected);
            }
            prev = tabEl;
        }

        for (const [, node] of existing) node.remove();
    }

    window.WavesApp.renderTabs = renderTabs;

    window.WavesApp.openNewTabFromServiceWorker = (url, options = {}) => {
        if (!url) return null;
        const tab = addTab(url, options.title || 'fetching data...');
        if (tab && options.openerTabId) {
            tab.openerTabId = options.openerTabId;
        }
        return tab;
    };

    function addTab(url = null, title = 'new tab') {
        const newTabId = Date.now();
        const iframe = createIframe();
        iframe.dataset.tabId = newTabId;
        iframe.name = newTabId.toString();

        const historyManager = new HistoryManager({
            onUpdate: (history) => {
                const activeTab = getActiveTab();
                if (activeTab?.id === newTabId &&
                    !document.body.classList.contains('split-view')) {
                    updateHistoryUI(activeTab, history);
                } else if (activeTab?.id === splitPair.left &&
                    document.body.classList.contains('split-view')) {
                    updateHistoryUI(activeTab, history);
                }
            }
        });

        const newTab = {
            id: newTabId,
            title: title,
            favicon: null,
            iframe: iframe,
            historyManager: historyManager,
            isUrlLoaded: !!url,
            isLoading: false,
            scrollX: 0,
            scrollY: 0,
            openerTabId: null,
            _iframeLoadHandler: null,
            _iframeFocusHandler: null
        };

        const iframeLoadHandler = () => {
            try {
                const doc = newTab.iframe.contentDocument;
                if (doc) {
                    if (!newTab.fixedTitle) {
                        const newTitle = doc.title;
                        if (newTitle && newTitle.trim() !== '') {
                            newTab.title = newTitle;
                        } else {
                            newTab.title = newTab.iframe.contentWindow.location.hostname || 'untitled';
                        }
                    }

                    if (!newTab.fixedFavicon) {
                        const faviconLink = doc.querySelector('link[rel="icon"], link[rel="shortcut icon"]');
                        newTab.favicon = faviconLink ? faviconLink.href : null;
                    }

                    renderTabs();

                    const isSplitModalVisible = dom.newTabModal.classList.contains('is-visible');
                    const isSplitMode = newTabInputEl.dataset.mode === 'splitSelect';
                    if (isSplitModalVisible && isSplitMode) {
                        updateSplitSelectResults();
                    }
                }
            } catch (e) {
                console.warn('could not access iframe content to update tab title', e);
            }
        };

        const iframeFocusHandler = (e) => {
            const clickedTabId = e.detail.tabId;

            if (document.body.classList.contains('split-view')) {
                const isSplitTab = (clickedTabId === splitPair.left || clickedTabId === splitPair.right);
                const isNotActive = (clickedTabId !== activeTabId);

                if (isSplitTab && isNotActive) {
                    switchTab(clickedTabId);
                }
            }
        };

        const iframeElementFocusHandler = (evt) => {
            const isSplitView = document.body.classList.contains('split-view');
            const isSplitTab = newTabId === splitPair.left || newTabId === splitPair.right;

            if (evt?.type === 'mouseenter' && (!isSplitView || activeTabId === newTabId)) {
                return;
            }

            if (evt?.type === 'pointerdown') {
                try {
                    iframe.focus({ preventScroll: true });
                } catch (e) { }
            }

            if (isSplitView && isSplitTab && activeTabId !== newTabId) {
                switchTab(newTabId);
                return;
            }

            const focusEvent = new CustomEvent('iframe-focus', {
                detail: { tabId: newTabId },
                bubbles: false
            });
            iframe.dispatchEvent(focusEvent);
        };

        newTab._iframeLoadHandler = iframeLoadHandler;
        newTab._iframeFocusHandler = iframeFocusHandler;
        newTab._iframeElementFocusHandler = iframeElementFocusHandler;

        iframe.addEventListener('load', iframeLoadHandler);
        iframe.addEventListener('iframe-focus', iframeFocusHandler);
        iframe.addEventListener('focus', iframeElementFocusHandler);
        iframe.addEventListener('pointerdown', iframeElementFocusHandler);
        iframe.addEventListener('mouseenter', iframeElementFocusHandler);

        tabs.push(newTab);

        initializeIframe(iframe, historyManager, newTab.id);

        if (url) {
            performSearch(url, newTab);
        }

        switchTab(newTabId);

        hideTabSelectionModal();

        updateMemoryDisplay();
        return newTab;
    }

    function switchTab(tabId) {
        const previousActiveId = activeTabId;
        if (isPickingSplitTab) {
            if (tabId === splitPair.left) return;

            splitPair.right = tabId;
            isPickingSplitTab = false;
            activeTabId = splitPair.left;
            hideTabSelectionModal();

        } else {
            activeTabId = tabId;
        }

        const oldActiveTab = tabs.find(t => t.id === previousActiveId);
        if (oldActiveTab && oldActiveTab.iframe.contentWindow) {
            try {
                oldActiveTab.scrollX = oldActiveTab.iframe.contentWindow.scrollX;
                oldActiveTab.scrollY = oldActiveTab.iframe.contentWindow.scrollY;
                reduceIframeMemory(oldActiveTab.iframe);
            } catch (e) {
            }
        }

        const activeTab = getActiveTab();
        if (activeTab) {
            if (dom.searchInputNav) {
                dom.searchInputNav.placeholder = activeTab.isLoading
                    ? "fetching url..."
                    : "search or enter address";
            }

            const isSplitViewActive = splitPair.left !== null &&
                splitPair.right !== null &&
                (activeTabId === splitPair.left || activeTabId === splitPair.right);

            if (activeTab.isUrlLoaded || isSplitViewActive) {
                showBrowserView();
            } else {
                showHomeView();
            }
            syncRefreshButtonWithActiveTab();

            if (activeTab.iframe.contentWindow) {
                try {
                    setTimeout(() => {
                        activeTab.iframe.contentWindow.scrollTo(activeTab.scrollX, activeTab.scrollY);
                    }, 0);
                } catch (e) {
                }
            }
        } else {
            showHomeView();
        }

        updateIframeView();
    }

    function closeTab(tabId) {
        if (tabs.length <= 1) return;

        const tabIndex = tabs.findIndex(tab => tab.id === tabId);
        if (tabIndex === -1) return;

        const [closedTab] = tabs.splice(tabIndex, 1);

        if (closedTab.iframe) {
            closedTab.iframe.removeEventListener('load', closedTab._iframeLoadHandler);
            closedTab.iframe.removeEventListener('iframe-focus', closedTab._iframeFocusHandler);
            closedTab.iframe.removeEventListener('focus', closedTab._iframeElementFocusHandler);
            closedTab.iframe.removeEventListener('pointerdown', closedTab._iframeElementFocusHandler);
            closedTab.iframe.removeEventListener('mouseenter', closedTab._iframeElementFocusHandler);
            cleanupIframe(closedTab.iframe);
            closedTab.iframe.remove();
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

        const wasInSplitPair = tabId === splitPair.left || tabId === splitPair.right;

        if (wasInSplitPair) {
            splitPair.left = null;
            splitPair.right = null;
            isPickingSplitTab = false;
        }

        if (activeTabId === tabId) {
            activeTabId = null;
            if (tabs.length > 0) {
                activeTabId = tabs[Math.max(0, tabIndex - 1)].id;
            }
        }

        if (tabs.length === 0) {
            addTab(null, 'new tab');
        } else if (activeTabId === null) {
            switchTab(tabs[0].id);
        } else {
            updateIframeView();
        }
        updateMemoryDisplay();
    }

    function onWindowBlur() {
        if (document.activeElement && document.activeElement.tagName === 'IFRAME') {
            hideTabSelectionModal();
            if (isPickingSplitTab) {
                isPickingSplitTab = false;
                updateIframeView();
            }
        }
    }

    function outsideClickListener(event) {
        if (!dom.newTabModal.contains(event.target) &&
            !dom.addTabBtn.contains(event.target) &&
            !(dom.splitViewBtn && dom.splitViewBtn.contains(event.target))
        ) {
            hideTabSelectionModal();
            if (isPickingSplitTab) {
                isPickingSplitTab = false;
                updateIframeView();
            }
        }
    }

    function initializeNewTabModal() {
        if (!newTabUnifiedWrapper && dom.newTabModal) {
            newTabUnifiedWrapper = document.createElement('div');
            newTabUnifiedWrapper.className = 'new-tab-unified-wrapper';

            const newTabSearchContainer = document.createElement('div');
            newTabSearchContainer.className = 'new-tab-search-container';

            const icon = document.createElement('i');
            icon.className = 'fa-regular fa-magnifying-glass';
            newTabSearchContainer.appendChild(icon);

            newTabSearchContainer.appendChild(newTabInputEl);

            newTabResultsContainer = document.createElement('div');
            newTabResultsContainer.className = 'new-tab-results-container';

            newTabUnifiedWrapper.appendChild(newTabSearchContainer);
            newTabUnifiedWrapper.appendChild(newTabResultsContainer);

            dom.newTabModal.appendChild(newTabUnifiedWrapper);

            newTabResultsContainer.addEventListener('click', (e) => {
                const item = e.target.closest('.new-tab-result-item');
                if (!item) return;

                const mode = newTabInputEl.dataset.mode;
                const { action, url, title, tabId, icon } = item.dataset;

                if (mode === 'newTab') {
                    if (action === 'search') {
                        handleNewTabAction(url, title);
                    } else if (action === 'game') {
                        handleNewTabAction(url, title, true, icon);
                    }
                } else if (mode === 'splitSelect') {
                    if (action === 'select-tab' && tabId) {
                        hideTabSelectionModal();
                        switchTab(parseInt(tabId, 10));
                    }
                }
            });
        }
    }

    function showTabSelectionModal(mode = 'newTab') {
        initializeNewTabModal();
        dom.newTabModal.classList.add('is-visible');
        newTabInputEl.focus();

        if (newTabResultsContainer) {
            newTabResultsContainer.innerHTML = '';
            newTabResultsContainer.style.display = 'none';
        }

        if (newTabUnifiedWrapper) {
            newTabUnifiedWrapper.classList.remove('has-results');
        }

        newTabInputEl.dataset.mode = mode;

        if (mode === 'newTab') {
            newTabInputEl.placeholder = "search or enter address";
            loadNewTabGameData();
            updateNewTabResults();
        } else if (mode === 'splitSelect') {
            newTabInputEl.placeholder = "select a tab to split with...";
            updateSplitSelectResults();
        }

        window.addEventListener('click', outsideClickListener);
        window.addEventListener('blur', onWindowBlur);
    }

    function hideTabSelectionModal() {
        if (!dom.newTabModal || !dom.newTabModal.classList.contains('is-visible')) return;

        window.removeEventListener('click', outsideClickListener);
        window.removeEventListener('blur', onWindowBlur);

        dom.newTabModal.classList.remove('is-visible');

        newTabInputEl.value = '';
        newTabInputEl.dataset.mode = '';

        if (newTabResultsContainer) {
            newTabResultsContainer.innerHTML = '';
            newTabResultsContainer.style.display = 'none';
        }

        if (newTabUnifiedWrapper) {
            newTabUnifiedWrapper.classList.remove('has-results');
        }
    }

    function handleNewTabAction(url, title, isGame = false, icon = null) {
        if (url) {
            const tab = addTab(url, title);
            if (isGame && tab) {
                tab.fixedTitle = true;
                tab.title = title;
                if (icon) {
                    tab.fixedFavicon = true;
                    tab.favicon = icon;
                }
                if (window.WavesApp.renderTabs) {
                    window.WavesApp.renderTabs();
                }
            }
        }
        hideTabSelectionModal();
    }

    function updateNewTabResults() {
        const query = newTabInputEl.value.trim();
        const lowerCaseQuery = query.toLowerCase();
        newTabResultsContainer.innerHTML = '';

        if (!query) {
            newTabUnifiedWrapper.classList.remove('has-results');
            newTabResultsContainer.style.display = 'none';
            return;
        }

        const currentSearchEngine = localStorage.getItem('searchEngine') || 'duckduckgo';

        newTabUnifiedWrapper.classList.add('has-results');
        newTabResultsContainer.style.display = 'block';

        const searchEl = document.createElement('div');
        searchEl.className = 'new-tab-result-item';
        searchEl.innerHTML = `<i class="fa-regular fa-magnifying-glass"></i> ${query} - Search with ${currentSearchEngine}`;
        searchEl.dataset.action = 'search';
        searchEl.dataset.url = query;
        searchEl.dataset.title = 'fetching data...';
        newTabResultsContainer.appendChild(searchEl);

        const filteredGames = allGames.filter(g => (g.name || '').toLowerCase().includes(lowerCaseQuery)).slice(0, 4);

        filteredGames.forEach(game => {
            const gameEl = document.createElement('div');
            gameEl.className = 'new-tab-result-item';
            gameEl.innerHTML = `<i class="fa-solid fa-gamepad-modern"></i> <span>${game.name}</span>`;
            gameEl.dataset.action = 'game';
            gameEl.dataset.url = game.gameUrl;
            gameEl.dataset.title = game.name;
            if (game.coverUrl) {
                gameEl.dataset.icon = game.coverUrl;
            }
            newTabResultsContainer.appendChild(gameEl);
        });
    }

    function updateSplitSelectResults() {
        const query = newTabInputEl.value.trim().toLowerCase();
        newTabResultsContainer.innerHTML = '';

        const tabsToSearch = tabs.filter(t => t.id !== splitPair.left);

        const filteredTabs = tabsToSearch.filter(t =>
            (t.title || '').toLowerCase().includes(query)
        );

        if (filteredTabs.length === 0) {
            newTabUnifiedWrapper.classList.remove('has-results');
            newTabResultsContainer.style.display = 'none';
            return;
        }

        newTabUnifiedWrapper.classList.add('has-results');
        newTabResultsContainer.style.display = 'block';

        filteredTabs.forEach(tab => {
            const tabEl = document.createElement('div');
            tabEl.className = 'new-tab-result-item';
            tabEl.innerHTML = `<i class="fa-regular fa-window-maximize"></i> <span>${tab.title}</span>`;
            tabEl.dataset.action = 'select-tab';
            tabEl.dataset.tabId = tab.id;
            newTabResultsContainer.appendChild(tabEl);
        });
    }

    function initializeSplitResize() {
        const handleWidth = 10;

        const onMouseMove = (e) => {
            const containerRect = dom.iframeContainer.getBoundingClientRect();
            if (!containerRect) return;

            let newLeftWidth = e.clientX - containerRect.left;

            const containerStyle = window.getComputedStyle(dom.iframeContainer);
            const gap = parseFloat(containerStyle.gap) || 0;

            const totalWidthWithoutGap = containerRect.width - gap;
            let percent = (newLeftWidth / totalWidthWithoutGap) * 100;

            percent = Math.max(20, Math.min(80, percent));

            const leftIframe = document.querySelector('.iframe.active-split-left');
            if (leftIframe) {
                leftIframe.style.flexBasis = percent + '%';
            }
        };

        const onMouseUp = () => {
            document.body.classList.remove('is-resizing');
            document.removeEventListener('mousemove', onMouseMove);
            document.removeEventListener('mouseup', onMouseUp);
        };

        dom.iframeContainer.addEventListener('mousemove', (e) => {
            if (document.body.classList.contains('is-resizing')) return;
            if (!document.body.classList.contains('split-view')) {
                dom.iframeContainer.style.cursor = 'default';
                return;
            }

            const leftIframe = document.querySelector('.iframe.active-split-left');
            if (!leftIframe) {
                dom.iframeContainer.style.cursor = 'default';
                return;
            }

            const leftIframeRect = leftIframe.getBoundingClientRect();
            const handleGripLeft = leftIframeRect.right - (handleWidth / 2);
            const handleGripRight = leftIframeRect.right + (handleWidth / 2);

            if (e.clientX >= handleGripLeft && e.clientX <= handleGripRight) {
                dom.iframeContainer.style.cursor = 'col-resize';
            } else {
                dom.iframeContainer.style.cursor = 'default';
            }
        });

        dom.iframeContainer.addEventListener('mousedown', (e) => {
            if (!document.body.classList.contains('split-view')) return;

            const leftIframe = document.querySelector('.iframe.active-split-left');
            if (!leftIframe) return;

            const leftIframeRect = leftIframe.getBoundingClientRect();
            const handleGripLeft = leftIframeRect.right - (handleWidth / 2);
            const handleGripRight = leftIframeRect.right + (handleWidth / 2);

            let canDrag = false;

            if (e.clientX >= handleGripLeft && e.clientX <= handleGripRight) {
                canDrag = true;
            }

            if (canDrag) {
                e.preventDefault();
                document.body.classList.add('is-resizing');
                document.addEventListener('mousemove', onMouseMove);
                document.addEventListener('mouseup', onMouseUp);
            }
        });
    }

    function toggleSplitView() {
        const isSplitPairDefined = splitPair.left !== null && splitPair.right !== null;
        if (tabs.length <= 1 && !isPickingSplitTab && !isSplitPairDefined) return;

        if (isPickingSplitTab) {
            isPickingSplitTab = false;
            hideTabSelectionModal();
        } else if (isSplitPairDefined) {
            splitPair.left = null;
            splitPair.right = null;
        } else {
            isPickingSplitTab = true;
            splitPair.left = activeTabId;
            showTabSelectionModal('splitSelect');
        }

        updateIframeView();
    }

    window.WavesApp.resetSession = () => {
        const tabsCopy = [...tabs];
        for (const tab of tabsCopy) {
            if (tab.iframe) {
                tab.iframe.removeEventListener('load', tab._iframeLoadHandler);
                tab.iframe.removeEventListener('iframe-focus', tab._iframeFocusHandler);
                tab.iframe.removeEventListener('focus', tab._iframeElementFocusHandler);
                tab.iframe.removeEventListener('pointerdown', tab._iframeElementFocusHandler);
                tab.iframe.removeEventListener('mouseenter', tab._iframeElementFocusHandler);
                cleanupIframe(tab.iframe);
                tab.iframe.remove();
            }
            if (tab.historyManager?.destroy) {
                tab.historyManager.destroy();
            }
        }

        tabs.length = 0;
        tabMemory.clear();
        activeTabId = null;
        splitPair.left = null;
        splitPair.right = null;
        isPickingSplitTab = false;

        dom.iframeContainer.innerHTML = '';
        document.body.classList.remove('split-view', 'is-picking-split', 'is-resizing');

        addTab(null, 'new tab');
        renderTabs();
        updateSplitButtonState();
        updateMemoryDisplay();
        showHomeView();
    };

    window.WavesApp.handleSearch = async (query, gameName, gameIcon) => {
        const activeTab = getActiveTab();
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
                renderTabs();
            } else {
                activeTab.fixedTitle = false;
                activeTab.fixedFavicon = false;
            }
            await performSearch(query, activeTab, gameName);
        }
    };

    initializeUI(getActiveTab);
    initializeSearch(getActiveTab);
    initializeBookmarks();
    initializeNotifications();
    initializeSplitResize();

    if (dom.splitViewBtn) {
        dom.splitViewBtn.addEventListener('click', (e) => {
            e.preventDefault();
            toggleSplitView();
        });
    }

    dom.tabsContainer.addEventListener('click', (e) => {
        const tabEl = e.target.closest('.tab');
        if (!tabEl) return;

        const tabIdStr = tabEl.dataset.tabId;
        if (!tabIdStr) return;

        const tabId = parseInt(tabIdStr, 10);
        if (isNaN(tabId)) return;

        if (e.target.closest('.tab-close')) {
            e.stopPropagation();
            closeTab(tabId);
        } else {
            if (isPickingSplitTab) {
                isPickingSplitTab = false;
                hideTabSelectionModal();
                switchTab(tabId);
            } else {
                switchTab(tabId);
            }
        }
    });

    dom.addTabBtn.addEventListener('click', () => showTabSelectionModal('newTab'));

    newTabInputEl.addEventListener('keyup', (e) => {
        const mode = newTabInputEl.dataset.mode;

        if (e.key === 'Escape') {
            hideTabSelectionModal();
            if (isPickingSplitTab) {
                isPickingSplitTab = false;
                updateIframeView();
            }
            return;
        }

        if (mode === 'newTab') {
            if (e.key === 'Enter') {
                const firstResult = newTabResultsContainer.querySelector('.new-tab-result-item');
                if (firstResult) {
                    firstResult.click();
                } else {
                    handleNewTabAction(newTabInputEl.value.trim(), 'fetching data...');
                }
            } else {
                updateNewTabResults();
            }
        } else if (mode === 'splitSelect') {
            if (e.key === 'Enter') {
                const firstResult = newTabResultsContainer.querySelector('.new-tab-result-item');
                if (firstResult) {
                    firstResult.click();
                }
            } else {
                updateSplitSelectResults();
            }
        }
    });

    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && dom.newTabModal.classList.contains('is-visible')) {
            hideTabSelectionModal();
            if (isPickingSplitTab) {
                isPickingSplitTab = false;
                updateIframeView();
            }
        }
    });

    addTab(null, 'fetching data...');
    updateIframeView();
    updateSplitButtonState();
    updateMemoryDisplay();
    requestAnimationFrame(() => {
        const activeTab = getActiveTab();
        if (activeTab && !activeTab.isUrlLoaded) {
            hideLoading();
            window.WavesApp.isLoading = false;
            showHomeView();
            if (dom.searchInputMain) dom.searchInputMain.disabled = false;
        }
    });
});