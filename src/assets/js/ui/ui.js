import { dom } from '../ui/dom.js';
import { navigateIframeTo, stopIframeLoading } from '../core/iframe.js';

let isLoading = false;
let originalTitle = '';
let erudaLoaded = false;
let loadingTimeoutId = null;

function injectEruda(getActiveTab) {
  const activeTab = getActiveTab();
  if (!activeTab || !activeTab.iframe) {
    return;
  }
  const iframe = activeTab.iframe;

  if (!iframe.contentDocument || !iframe.contentWindow) {
    return;
  }
  if (iframe.contentDocument.getElementById('eruda')) {
    initializeEruda(getActiveTab);
    return;
  }

  loadingTimeoutId = setTimeout(() => {
    const existingScript = iframe.contentDocument.getElementById('eruda');
    if (existingScript) existingScript.remove();
  }, 15000);

  const script = iframe.contentDocument.createElement('script');
  script.id = 'eruda';

  script.src = '/!!/https://cdn.jsdelivr.net/npm/eruda';

  script.async = true;
  script.onload = () => {
    clearTimeout(loadingTimeoutId);
    setTimeout(() => {
      initializeEruda(getActiveTab);
    }, 0);
  };
  script.onerror = (e) => {
    clearTimeout(loadingTimeoutId);
    console.error('eruda failed to load', e);
    script.remove();
  };

  iframe.contentDocument.head.appendChild(script);
}

function initializeEruda(getActiveTab) {
  const activeTab = getActiveTab();
  if (!activeTab || !activeTab.iframe) {
    return;
  }
  const iframe = activeTab.iframe;

  try {
    const ew = iframe.contentWindow;
    if (!ew.eruda) {
      console.error('eruda object undefined.');
      return;
    }
    ew.eruda.init();
    ew.eruda.show();
    erudaLoaded = true;
  } catch (err) {
    console.error('error initializing eruda:', err);
  }
}

function toggleEruda(getActiveTab) {
  const activeTab = getActiveTab();
  if (!activeTab || !activeTab.iframe) {
    return;
  }
  const iframe = activeTab.iframe;

  if (!iframe.contentWindow) {
    return;
  }
  try {
    if (erudaLoaded && iframe.contentWindow.eruda) {
      iframe.contentWindow.eruda.destroy();
      erudaLoaded = false;
    } else {
      injectEruda(getActiveTab);
    }
  } catch (err) {
    console.error('error toggling eruda:', err);
  }
}

function setRefreshButtonState(loading) {
  isLoading = !!loading;
  if (dom.refreshBtnIcon) {
    dom.refreshBtnIcon.classList.remove('fa-rotate-right', 'fa-xmark');
    if (loading) {
      dom.refreshBtnIcon.classList.add('fa-xmark');
    } else {
      dom.refreshBtnIcon.classList.add('fa-rotate-right');
    }
  }
}

export function syncRefreshButtonWithActiveTab() {
  const activeTab = window.WavesApp?.getActiveTab?.();
  const isLoading = !!activeTab?.isLoading;
  setRefreshButtonState(isLoading);

  const isSplitView = document.body.classList.contains('split-view');
  const splitPair = window.WavesApp?.splitPair || { left: null, right: null };
  const visibleTabIds = isSplitView ? [splitPair.left, splitPair.right] : [activeTab?.id];

  const tabs = window.WavesApp?.tabs || [];
  tabs.forEach(tab => {
    if (tab.isLoading && visibleTabIds.includes(tab.id)) {
      showIframeLoading(tab.id);
    } else {
      hideIframeLoading(tab.id);
    }
  });
}

export function showLoading(tabId = null) {
  const tabs = window.WavesApp?.tabs || [];
  const target = tabId ? tabs.find(t => t.id === tabId) : window.WavesApp?.getActiveTab?.();
  if (target) target.isLoading = true;

  const resolvedTabId = tabId || window.WavesApp?.getActiveTab?.()?.id;
  const activeId = window.WavesApp?.getActiveTab?.()?.id ?? null;
  const isSplitView = document.body.classList.contains('split-view');
  const splitPair = window.WavesApp?.splitPair;
  const isInSplit = isSplitView && splitPair && (resolvedTabId === splitPair.left || resolvedTabId === splitPair.right);

  if (!isInSplit && (!activeId || (tabId && activeId !== tabId))) return;

  if (!tabId || tabId === activeId) {
    if (dom.searchInputNav) {
      dom.searchInputNav.placeholder = "fetching url...";
    }
    setRefreshButtonState(true);
  }

  showIframeLoading(resolvedTabId);
}

function positionOverlayForTab(overlay, tabId) {
  const container = dom.iframeContainer;
  if (!container) return;

  const tabs = window.WavesApp?.tabs || [];
  const tab = tabs.find(t => t.id === tabId);
  if (!tab || !tab.iframe) {
    overlay.style.left = '0';
    overlay.style.top = '0';
    overlay.style.width = '100%';
    overlay.style.height = '100%';
    return;
  }

  const isSplitView = document.body.classList.contains('split-view');
  if (!isSplitView) {
    overlay.style.left = '0';
    overlay.style.top = '0';
    overlay.style.width = '100%';
    overlay.style.height = '100%';
    return;
  }

  const containerRect = container.getBoundingClientRect();
  const iframeRect = tab.iframe.getBoundingClientRect();

  overlay.style.left = (iframeRect.left - containerRect.left) + 'px';
  overlay.style.top = (iframeRect.top - containerRect.top) + 'px';
  overlay.style.width = iframeRect.width + 'px';
  overlay.style.height = iframeRect.height + 'px';
}

export function showIframeLoading(tabId = null) {
  const container = dom.iframeContainer;
  if (!container) return;

  const overlayId = tabId ? `iframe-loading-${tabId}` : 'iframe-loading-default';

  let overlay = container.querySelector(`[data-loading-id="${overlayId}"]`);
  if (overlay) {
    overlay.classList.add('visible');
    if (tabId) positionOverlayForTab(overlay, tabId);
    return;
  }

  overlay = document.createElement('div');
  overlay.className = 'iframe-loading visible';
  overlay.dataset.loadingId = overlayId;

  const cat = document.createElement('div');
  cat.className = 'iframe-loading-cat';

  const text = document.createElement('div');
  text.className = 'iframe-loading-text';
  text.textContent = 'loading...';

  overlay.appendChild(cat);
  overlay.appendChild(text);
  container.appendChild(overlay);

  if (tabId) positionOverlayForTab(overlay, tabId);
}

export function hideIframeLoading(tabId = null) {
  const container = dom.iframeContainer;
  if (!container) return;

  if (tabId) {
    const overlayId = `iframe-loading-${tabId}`;
    const overlay = container.querySelector(`[data-loading-id="${overlayId}"]`);
    if (overlay) overlay.classList.remove('visible');
  } else {
    const overlays = container.querySelectorAll('.iframe-loading');
    overlays.forEach(o => o.classList.remove('visible'));
  }
}

export function hideLoading(tabId = null) {
  const tabs = window.WavesApp?.tabs || [];
  const target = tabId ? tabs.find(t => t.id === tabId) : null;
  if (target) target.isLoading = false;

  const activeId = window.WavesApp?.getActiveTab?.()?.id ?? null;
  const isSplitView = document.body.classList.contains('split-view');
  const splitPair = window.WavesApp?.splitPair;
  const isInSplit = isSplitView && splitPair && (tabId === splitPair?.left || tabId === splitPair?.right);

  hideIframeLoading(tabId);

  if (!isInSplit && tabId && activeId && tabId !== activeId) return;

  if (!tabId || tabId === activeId) {
    if (dom.searchInputNav) {
      dom.searchInputNav.placeholder = "search or enter address";
    }
    document.title = originalTitle;
    setRefreshButtonState(false);
  }
}

function setupOnekoAnimation() {
  const onekoEl = document.getElementById('oneko');
  if (onekoEl) {
    const sleepingSpriteFrames = [
      [-2, 0],
      [-2, -1]
    ];
    let currentFrameIndex = 0;
    let lastUpdate = 0;
    const interval = 400;

    const animate = (timestamp) => {
      if (!onekoEl.isConnected) return;

      if (onekoEl.offsetParent !== null) {
        if (timestamp - lastUpdate >= interval) {
          const sprite = sleepingSpriteFrames[currentFrameIndex % sleepingSpriteFrames.length];
          onekoEl.style.backgroundPosition = `${sprite[0] * 32}px ${sprite[1] * 32}px`;
          currentFrameIndex++;
          lastUpdate = timestamp;
        }
      }
      requestAnimationFrame(animate);
    };

    requestAnimationFrame(animate);
  }
}

export function showBrowserView() {
  document.body.classList.add('browser-view');

  const gamesPage = document.getElementById('games-page');
  if (gamesPage && document.body.classList.contains('games-view')) {
    const gameGrid = gamesPage.querySelector('.game-grid');
    if (gameGrid) {
      gameGrid.innerHTML = '';
    }
    const gameSearchInput = gamesPage.querySelector('#gameSearchInput');
    if (gameSearchInput) {
      gameSearchInput.value = '';
    }
  }

}

export function showHomeView() {
  document.body.classList.remove('browser-view');
}

export function initializeUI(getActiveTab) {
  originalTitle = document.title;

  const animationStyle = document.createElement('style');
  animationStyle.textContent = `.bookmarks-disabled{opacity:.5;transition:opacity .3s ease}`;
  document.head.appendChild(animationStyle);

  setupOnekoAnimation();

  const erudaBtn = document.getElementById('erudaBtn');
  if (erudaBtn) {
    erudaBtn.addEventListener('click', (e) => {
      e.preventDefault();
      toggleEruda(getActiveTab);
    });
  }

  dom.backBtn.addEventListener('click', async () => {
    const activeTab = getActiveTab();
    if (!activeTab) return;
    const urlToGo = activeTab.historyManager.back();

    if (urlToGo) {
      activeTab._historyNavigating = true;
      activeTab._historyTarget = urlToGo;
      navigateIframeTo(activeTab.iframe, urlToGo);
    }
  });

  dom.forwardBtn.addEventListener('click', async () => {
    const activeTab = getActiveTab();
    if (!activeTab) return;
    const urlToGo = activeTab.historyManager.forward();

    if (urlToGo) {
      activeTab._historyNavigating = true;
      activeTab._historyTarget = urlToGo;
      navigateIframeTo(activeTab.iframe, urlToGo);
    }
  });

  dom.refreshBtn.addEventListener('click', async () => {
    const activeTab = getActiveTab();
    if (!activeTab) return;

    if (isLoading) {
      stopIframeLoading(activeTab.iframe);
    } else {
      const manualUrl = activeTab.iframe.dataset.manualUrl;

      if (manualUrl) {
        if (window.WavesApp && typeof window.WavesApp.handleSearch === 'function') {
          await window.WavesApp.handleSearch(manualUrl, activeTab);
        } else {
        }
      } else if (activeTab.iframe.contentWindow && activeTab.iframe.src && activeTab.iframe.src !== 'about-blank') {
        showLoading(activeTab.id);

        activeTab.iframe.classList.remove('loaded');
        if (!activeTab.fixedTitle) {
          activeTab.title = 'fetching data...';
        }
        if (!activeTab.fixedFavicon) {
          activeTab.favicon = null;
        }
        if (window.WavesApp.renderTabs) {
          window.WavesApp.renderTabs();
        }

        try {
          activeTab.iframe.contentWindow.location.reload();
        } catch (e) {
          console.warn("failed to reload iframe, possibly cross-origin:", e.message);
          navigateIframeTo(activeTab.iframe, activeTab.iframe.src);
        }
      }
    }
  });

  dom.fullscreenBtn.addEventListener('click', () => {
    const activeTab = getActiveTab();
    if (!activeTab) return;
    if (activeTab.iframe.requestFullscreen) activeTab.iframe.requestFullscreen();
    else if (activeTab.iframe.mozRequestFullScreen) activeTab.iframe.mozRequestFullScreen();
    else if (activeTab.iframe.webkitRequestFullscreen) activeTab.iframe.webkitRequestFullscreen();
    else if (activeTab.iframe.msRequestFullscreen) activeTab.iframe.msRequestFullscreen();
  });

  if (dom.homeBtn) {
    dom.homeBtn.addEventListener('click', (e) => {
      e.preventDefault();
      if (window.WavesApp && typeof window.WavesApp.resetSession === 'function') {
        window.WavesApp.resetSession();
      } else {
        showHomeView();
      }
    });
  }
}