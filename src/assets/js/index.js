import { dom } from './ui/dom.js';
import { HistoryManager } from './core/history.js';
import { initializeUI, hideLoadingScreen, showHomeView, showBrowserView } from './ui/ui.js';
import { initializeIframe, updateHistoryUI } from './core/iframe.js';
import { initializeSearch, handleSearch as performSearch } from './search/search.js';
import { initializeBookmarks } from './features/bookmarks.js';

function handleServiceWorkerMessage(event) {
    const { data } = event;
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
    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.addEventListener('message', handleServiceWorkerMessage);
    }

    window.WavesApp = window.WavesApp || {};
    window.WavesApp.isLoading = false;

     if (document.getElementById('new-tab-modal')) {
        document.getElementById('new-tab-modal').style.display = '';
    }

    let tabs = [];
    window.WavesApp.tabs = tabs;
    
    let activeTabId = null;
    let splitPair = { left: null, right: null };
    let isPickingSplitTab = false;

    let allGames = window.WavesApp.allGames || [];
    window.WavesApp.allGames = allGames;
    
    let newTabUnifiedWrapper = null;
    let newTabResultsContainer = null;

    const ZONES_URL = "https://cdn.jsdelivr.net/gh/gn-math/assets@latest/zones.json";
    const HTML_URL = "https://cdn.jsdelivr.net/gh/gn-math/html@main";

    function loadNewTabGamesData() {
        if (allGames.length > 0) return Promise.resolve(allGames);
        
        return fetch(ZONES_URL)
            .then(res => {
                if (!res.ok) {
                    throw new Error(`Network response was not ok: ${res.statusText}`);
                }
                return res.json();
            })
            .then(data => {
                const loadedGames = data
                    .map(zone => {
                        const isExternal = zone.url.startsWith('http');
                        return {
                            id: zone.id,
                            name: zone.name,
                            gameUrl: isExternal ? zone.url : zone.url.replace("{HTML_URL}", HTML_URL),
                            isExternal: isExternal
                        };
                    })
                    .filter(game => !game.name.startsWith('[!]') && !game.name.startsWith('Chat Bot'));
                
                loadedGames.sort((a, b) => a.name.localeCompare(b.name));
                
                allGames.splice(0, allGames.length, ...loadedGames); 
                window.WavesApp.allGames = allGames;
                
                return allGames;
            })
            .catch(err => {
                console.error('Failed to load new tab game data:', err);
            });
    }

    const toggleSidebarBtn = document.getElementById('toggle-sidebar-btn');
    if(toggleSidebarBtn) {
        toggleSidebarBtn.addEventListener('click', (e) => {
            e.preventDefault();
            document.body.classList.toggle('sidebar-hidden'); 
        });
    }

    function getActiveTab() {
        return tabs.find(tab => tab.id === activeTabId);
    }
    
    window.WavesApp.getActiveTab = getActiveTab;

    function createIframe() {
        const iframe = document.createElement('iframe');
        iframe.className = 'iframe';
        iframe.loading = 'lazy';
        iframe.allow = 'fullscreen';
        iframe.referrerPolicy = 'no-referrer';
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
            const isSplitLeft = (isSplitViewActive && tab.id === splitPair.left) || (isPicking && tab.id === splitPair.left);
            const isSplitRight = isSplitViewActive && tab.id === splitPair.right;
            const isSingleActive = !isSplitViewActive && !isPicking && tab.id === activeTabId;

            tab.iframe.classList.toggle('active-split-left', isSplitLeft);
            tab.iframe.classList.toggle('active-split-right', isSplitRight);
            tab.iframe.classList.toggle('active', isSingleActive);
            
            tab.iframe.classList.toggle('active-focus', (isSplitViewActive || isPicking) && tab.id === activeTabId);

            if (isSplitLeft) leftIframe = tab.iframe;
            if (isSplitRight) rightIframe = tab.iframe;

            if (!isSplitViewActive && !isPicking) {
                tab.iframe.style.width = null;
                tab.iframe.style.flexBasis = null;
                tab.iframe.style.flexGrow = null;
            }
        });
        
        if ((isSplitViewActive || isPicking) && leftIframe) {
            
            const containerStyle = window.getComputedStyle(dom.iframeContainer);
            const gap = parseFloat(containerStyle.gap) || 0;

            let leftBasis = leftIframe.style.flexBasis;
            if (!leftBasis || leftBasis === 'auto' || leftBasis === '0px') {
                leftBasis = `calc(50% - ${gap / 2}px)`;
            }
            
            leftIframe.style.flexGrow = '0';
            leftIframe.style.flexBasis = leftBasis;
            
            if(rightIframe) {
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


    function createTabElement(tab) {
        const tabEl = document.createElement('div');
        tabEl.className = 'tab';
        tabEl.dataset.tabId = tab.id;

        const iconEl = document.createElement('img');
        iconEl.className = 'tab-icon';
        const defaultIcon = 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"><path fill="%23818181" d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1h-2v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z"/></svg>';
        iconEl.src = tab.favicon || defaultIcon;
        iconEl.onerror = () => { iconEl.src = defaultIcon; };

        const titleEl = document.createElement('span');
        titleEl.className = 'tab-title';
        titleEl.textContent = tab.title;

        const closeBtn = document.createElement('button');
        closeBtn.className = 'tab-close';
        closeBtn.innerHTML = '<i class="fa-regular fa-times"></i>';

        tabEl.appendChild(iconEl);
        tabEl.appendChild(titleEl);
        tabEl.appendChild(closeBtn);

        return tabEl;
    }

    function renderTabs() {
        const fragment = document.createDocumentFragment();
        
        const isSplitPairDefined = splitPair.left !== null && splitPair.right !== null;
        const isSplitLayoutActive = document.body.classList.contains('split-view');

        tabs.forEach(tab => {
            const tabEl = createTabElement(tab);

            if (isSplitPairDefined && (tab.id === splitPair.left || tab.id === splitPair.right)) {
                tabEl.classList.add('split-pair');
                if (tab.id === splitPair.left) tabEl.classList.add('split-pair-left');
                if (tab.id === splitPair.right) tabEl.classList.add('split-pair-right');
            }

            if (isSplitLayoutActive) {
                if (tab.id === splitPair.left) {
                    tabEl.classList.add('active');
                    tabEl.classList.add('split-active-left');
                } else if (tab.id === splitPair.right) {
                    tabEl.classList.add('active');
                    tabEl.classList.add('split-active-right');
                }
            } else if (tab.id === activeTabId) {
                tabEl.classList.add('active');
            }

            fragment.appendChild(tabEl);
        });

        dom.tabsContainer.innerHTML = '';
        dom.tabsContainer.appendChild(fragment);
    }

    window.WavesApp.renderTabs = renderTabs;

    function addTab(url = null, title = 'New Tab') {
        const newTabId = Date.now();
        const iframe = createIframe();
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
            scrollX: 0,
            scrollY: 0,
            _iframeLoadHandler: null,
            _iframeFocusHandler: null
        };

        const iframeLoadHandler = () => {
            try {
                const doc = newTab.iframe.contentDocument;
                if (doc) {
                    const newTitle = doc.title;
                    if (newTitle && newTitle.trim() !== '') {
                        newTab.title = newTitle;
                    } else {
                        newTab.title = newTab.iframe.contentWindow.location.hostname || 'Untitled';
                    }
                    
                    const faviconLink = doc.querySelector('link[rel="icon"], link[rel="shortcut icon"]');
                    newTab.favicon = faviconLink ? faviconLink.href : null;

                    renderTabs();

                    const isSplitModalVisible = dom.newTabModal.classList.contains('is-visible');
                    const isSplitMode = dom.newTabInput.dataset.mode === 'splitSelect';
                    if (isSplitModalVisible && isSplitMode) {
                        updateSplitSelectResults();
                    }
                }
            } catch (e) {
                console.warn('Could not access iframe content to update tab title', e);
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

        newTab._iframeLoadHandler = iframeLoadHandler;
        newTab._iframeFocusHandler = iframeFocusHandler;

        iframe.addEventListener('load', iframeLoadHandler);
        iframe.addEventListener('waves-iframe-focus', iframeFocusHandler);

        tabs.push(newTab);
        
        initializeIframe(iframe, historyManager, newTab.id);
        
        if (url) {
            performSearch(url, newTab);
        }
        
        switchTab(newTabId);
        
        hideTabSelectionModal(); 
        
        return newTab;
    }

    function switchTab(tabId) {
        if (isPickingSplitTab) {
            if (tabId === splitPair.left) return;
            
            splitPair.right = tabId;
            isPickingSplitTab = false;
            activeTabId = splitPair.left;
            hideTabSelectionModal();
        
        } else {
            activeTabId = tabId;
        }

        const oldActiveTab = tabs.find(t => t.id !== activeTabId);
        if (oldActiveTab && oldActiveTab.iframe.contentWindow) {
            try {
                oldActiveTab.scrollX = oldActiveTab.iframe.contentWindow.scrollX;
                oldActiveTab.scrollY = oldActiveTab.iframe.contentWindow.scrollY;
            } catch (e) {
            }
        }

        const activeTab = getActiveTab();
        if (activeTab) {
             const isSplitViewActive = splitPair.left !== null && 
                                     splitPair.right !== null && 
                                     (activeTabId === splitPair.left || activeTabId === splitPair.right);

            if (activeTab.isUrlLoaded || isSplitViewActive) {
                showBrowserView();
            } else {
                showHomeView();
            }
            
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
        const tabIndex = tabs.findIndex(tab => tab.id === tabId);
        if (tabIndex === -1) return;

        const [closedTab] = tabs.splice(tabIndex, 1);

        if (closedTab.iframe) {
            closedTab.iframe.removeEventListener('load', closedTab._iframeLoadHandler);
            closedTab.iframe.removeEventListener('waves-iframe-focus', closedTab._iframeFocusHandler);
            closedTab.iframe.remove();
        }

        if (closedTab.historyManager) {
            closedTab.historyManager.onUpdate = null;
        }

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
            addTab(null, 'New Tab');
        } else if (activeTabId === null) {
            switchTab(tabs[0].id);
        } else {
            updateIframeView();
        }
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
        if (!newTabUnifiedWrapper) {
            newTabUnifiedWrapper = document.createElement('div');
            newTabUnifiedWrapper.className = 'new-tab-unified-wrapper';
    
            const newTabSearchContainer = document.createElement('div');
            newTabSearchContainer.className = 'new-tab-search-container';
    
            const icon = document.createElement('i');
            icon.className = 'fa-regular fa-magnifying-glass';
            newTabSearchContainer.appendChild(icon);
    
            newTabSearchContainer.appendChild(dom.newTabInput);
            
            newTabResultsContainer = document.createElement('div');
            newTabResultsContainer.className = 'new-tab-results-container';
    
            newTabUnifiedWrapper.appendChild(newTabSearchContainer);
            newTabUnifiedWrapper.appendChild(newTabResultsContainer);
    
            dom.newTabModal.appendChild(newTabUnifiedWrapper);

            newTabResultsContainer.addEventListener('click', (e) => {
                const item = e.target.closest('.new-tab-result-item');
                if (!item) return;
    
                const mode = dom.newTabInput.dataset.mode;
                const { action, url, title, tabId } = item.dataset;
                
                if (mode === 'newTab') {
                    if (action === 'search' || action === 'game') {
                        handleNewTabAction(url, title);
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
        dom.newTabModal.classList.add('is-visible');
        dom.newTabInput.focus();
        
        if (newTabResultsContainer) {
            newTabResultsContainer.innerHTML = '';
            newTabResultsContainer.style.display = 'none'; 
        }
        
        if (newTabUnifiedWrapper) {
            newTabUnifiedWrapper.classList.remove('has-results');
        }

        dom.newTabInput.dataset.mode = mode;

        if (mode === 'newTab') {
            dom.newTabInput.placeholder = "Search or enter address";
            loadNewTabGamesData();
            updateNewTabResults();
        } else if (mode === 'splitSelect') {
            dom.newTabInput.placeholder = "Select a tab to split with...";
            updateSplitSelectResults();
        }

        window.addEventListener('click', outsideClickListener);
        window.addEventListener('blur', onWindowBlur);
    }

    function hideTabSelectionModal() {
        if (!dom.newTabModal.classList.contains('is-visible')) return;

        window.removeEventListener('click', outsideClickListener);
        window.removeEventListener('blur', onWindowBlur);

        dom.newTabModal.classList.remove('is-visible');
        
        dom.newTabInput.value = '';
        dom.newTabInput.dataset.mode = '';
        
        if (newTabResultsContainer) {
            newTabResultsContainer.innerHTML = '';
            newTabResultsContainer.style.display = 'none';
        }
        
        if (newTabUnifiedWrapper) {
            newTabUnifiedWrapper.classList.remove('has-results');
        }
    }

    function handleNewTabAction(url, title) {
        if (url) {
            addTab(url, title);
        }
        hideTabSelectionModal();
    }

    function updateNewTabResults() {
        const query = dom.newTabInput.value.trim();
        const lowerCaseQuery = query.toLowerCase();
        newTabResultsContainer.innerHTML = '';

        if (!query) {
            newTabUnifiedWrapper.classList.remove('has-results');
            newTabResultsContainer.style.display = 'none';
            return;
        }

        const currentSearchEngine = localStorage.getItem('searchEngine') || 'DuckDuckGo';

        newTabUnifiedWrapper.classList.add('has-results');
        newTabResultsContainer.style.display = 'block';

        const searchEl = document.createElement('div');
        searchEl.className = 'new-tab-result-item';
        searchEl.innerHTML = `<i class="fa-regular fa-magnifying-glass"></i> ${query} - Search with ${currentSearchEngine}`;
        searchEl.dataset.action = 'search';
        searchEl.dataset.url = query;
        searchEl.dataset.title = 'Loading...';
        newTabResultsContainer.appendChild(searchEl);
        
        const filteredGames = allGames.filter(g => (g.name || '').toLowerCase().includes(lowerCaseQuery)).slice(0, 4);

        filteredGames.forEach(game => {
            const gameEl = document.createElement('div');
            gameEl.className = 'new-tab-result-item';
            gameEl.innerHTML = `<i class="fa-solid fa-gamepad"></i> <span>${game.name}</span>`;
            gameEl.dataset.action = 'game';
            gameEl.dataset.url = game.gameUrl;
            gameEl.dataset.title = game.name;
            newTabResultsContainer.appendChild(gameEl);
        });
    }

    function updateSplitSelectResults() {
        const query = dom.newTabInput.value.trim().toLowerCase();
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


    window.WavesApp.handleSearch = async (query) => {
        const activeTab = getActiveTab();
        if (activeTab) {
            await performSearch(query, activeTab);
        }
    };
    
    initializeUI(getActiveTab);
    initializeSearch(getActiveTab);
    initializeBookmarks();
    initializeNewTabModal();
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
    
    dom.newTabInput.addEventListener('keyup', (e) => {
        const mode = dom.newTabInput.dataset.mode;

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
                    handleNewTabAction(dom.newTabInput.value.trim(), 'Loading...');
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


    addTab(null, 'Loading...');
    updateSplitButtonState();

    window.addEventListener('load', () => {
        const activeTab = getActiveTab();
        if (activeTab && !activeTab.isUrlLoaded) {
            hideLoadingScreen();
            window.WavesApp.isLoading = false;
            showHomeView();
            if (dom.searchInputMain) dom.searchInputMain.disabled = false;
        }
    });
});