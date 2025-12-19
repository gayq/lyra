import { dom } from '../ui/dom.js';
import { toggleButtonAnimation } from '../core/utils.js';
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
  script.src = 'https://cdn.jsdelivr.net/npm/eruda';
  script.async = true;
  script.onload = () => {
    clearTimeout(loadingTimeoutId);
    initializeEruda(getActiveTab);
  };
  script.onerror = () => {
    clearTimeout(loadingTimeoutId);
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
      console.error('Eruda object undefined.');
      return;
    }
    ew.eruda.init();
    ew.eruda.show();
    erudaLoaded = true;
  } catch (err) {
    console.error('Error initializing Eruda:', err);
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
    console.error('Error toggling Eruda:', err);
  }
}

export function showLoading() {
  if (isLoading) return;
  isLoading = true;

  if (dom.refreshBtnIcon) {
    dom.refreshBtnIcon.classList.remove('fa-rotate-right');
    dom.refreshBtn.classList.remove('spin-animation');
    dom.refreshBtnIcon.classList.add('fa-xmark');
  }
}

export function hideLoading() {
  if (!isLoading) return;

  document.title = originalTitle;
  isLoading = false;
  if (dom.erudaLoadingScreen) dom.erudaLoadingScreen.style.display = 'none';
  if (dom.refreshBtnIcon) {
    dom.refreshBtnIcon.classList.remove('fa-xmark');
    dom.refreshBtnIcon.classList.add('fa-rotate-right');
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
}

export function showHomeView() {
  document.body.classList.remove('browser-view');
}

export function initializeUI(getActiveTab) {
  originalTitle = document.title;

  const animationStyle = document.createElement('style');
  animationStyle.textContent = `@keyframes slideLeft{0%{transform:translateX(0) scale(1)}50%{transform:translateX(-5px) scale(.95)}100%{transform:translateX(0) scale(1)}}@keyframes slideRight{0%{transform:translateX(0) scale(1)}50%{transform:translateX(5px) scale(.95)}100%{transform:translateX(0) scale(1)}}.button-animate-back{animation:slideLeft .2s ease-in-out}.button-animate-forward{animation:slideRight .2s ease-in-out}@keyframes spin-refresh{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}.spin-animation{animation:spin-refresh .4s ease-in-out}.spin{animation:spinAnimation .3s linear}@keyframes spinAnimation{0%{transform:rotate(0)}100%{transform:rotate(360deg)}}.spin{animation:spin .6s linear infinite;backface-visibility:hidden;perspective:1000px;will-change:transform}@keyframes spin{0%{transform:translateY(-50%) translateZ(0) rotate(0)}100%{transform:translateY(-50%) translateZ(0) rotate(360deg)}}.bookmarks-disabled{opacity:.5;transition:opacity .3s ease}`;
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
    toggleButtonAnimation(dom.backBtn, 'button-animate-back');
    const urlToGo = activeTab.historyManager.back();

    if (urlToGo) {
      if (urlToGo.startsWith("https://cdn.jsdelivr.net/gh/gn-math/html@main/")) {
        await window.WavesApp.handleSearch(urlToGo, activeTab);
      } else {
        navigateIframeTo(activeTab.iframe, urlToGo);
      }
    }
  });

  dom.forwardBtn.addEventListener('click', async () => {
    const activeTab = getActiveTab();
    if (!activeTab) return;
    toggleButtonAnimation(dom.forwardBtn, 'button-animate-forward');
    const urlToGo = activeTab.historyManager.forward();

    if (urlToGo) {
      if (urlToGo.startsWith("https://cdn.jsdelivr.net/gh/gn-math/html@main/")) {
        await window.WavesApp.handleSearch(urlToGo, activeTab);
      } else {
        navigateIframeTo(activeTab.iframe, urlToGo);
      }
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
          console.warn('Cannot refresh game: handleSearch is not available.');
        }
      } else if (activeTab.iframe.contentWindow && activeTab.iframe.src && activeTab.iframe.src !== 'about-blank') {
        showLoading();

        activeTab.iframe.classList.remove('loaded');
        activeTab.title = 'Loading...';
        activeTab.favicon = null;
        if (window.WavesApp.renderTabs) {
             window.WavesApp.renderTabs();
        }

        try {
          activeTab.iframe.contentWindow.location.reload();
        } catch (e) {
          console.warn("Failed to reload iframe, possibly cross-origin:", e.message);
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
}