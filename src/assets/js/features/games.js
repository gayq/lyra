import { showHomeView } from '../ui/ui.js';
import { attachSearchLight } from '../core/load.js';

export function initializeGame() {
  const yay = document.querySelector('.yay');
  const mainContainer = document.querySelector('.main-container');
  const gameIcon = document.getElementById('choi');
  const brand = document.getElementById('brand');
  const brandingContainer = document.getElementById('branding-container');
  const overlay = document.getElementById('overlay');

  if (!yay || !gameIcon) return;

  const iconEl = gameIcon.querySelector('i');
  const defaultIconClass = iconEl?.className || 'fa-solid fa-gamepad-modern';
  const homeIconClass = 'fa-solid fa-magnifying-glass';

  const SOURCE_CONFIG = {
    selenite: {
      games: "/!!/https://selenite.cc/resources/games.json",
      assets: "https://selenite.cc/resources/semag/"
    },
    gnMath: {
      zones: "/!!/https://cdn.jsdelivr.net/gh/gn-math/assets@main/zones.json",
      covers: "https://cdn.jsdelivr.net/gh/gn-math/covers@main"
    },
    velara: {
      games: "/!!/https://velara.cc/data/games.json",
      assets: "https://velara.cc"
    },
    edurocks: {
      games: "/!!/https://www.edurocks.org/gxxes.json",
      assets: "https://www.edurocks.org"
    }
  };

  let gamesPage = document.getElementById('games-page');
  if (!gamesPage) {
    gamesPage = document.createElement('section');
    gamesPage.id = 'games-page';
    gamesPage.className = 'games-page';
    gamesPage.setAttribute('aria-hidden', 'true');
    gamesPage.innerHTML = `
      <div class="games-topbar">
        <div class="search-bar games-search-bar">
          <div class="light"></div>
          <div class="light-border"></div>
          <div class="light-inset-bg"></div>
          <i class="fa-light fa-magnifying-glass games-search-icon"></i>
          <input type="text" id="gameSearchInput" placeholder="fetching games..." autocomplete="off">
        </div>
      </div>
      <div class="game-grid-container">
        <div class="game-grid"></div>
        <p class="no-results">--</p>
      </div>
    `;

    if (mainContainer) {
      mainContainer.insertAdjacentElement('afterend', gamesPage);
    } else {
      yay.prepend(gamesPage);
    }
  }

  const gameGrid = gamesPage.querySelector('.game-grid');
  const gameSearchInput = gamesPage.querySelector('#gameSearchInput');
  const noResultsEl = gamesPage.querySelector('.no-results');
  const refreshBtn = gamesPage.querySelector('#games-refresh-btn');
  const gamesSearchBar = gamesPage.querySelector('.games-search-bar');

  attachSearchLight(gamesSearchBar);

  const scrollTarget = yay || window;

  scrollTarget.addEventListener('scroll', () => {
    const currentScroll = yay ? yay.scrollTop : window.scrollY;

    if (currentScroll > 10) {
      gamesSearchBar.classList.add('is-sticky');
    } else {
      gamesSearchBar.classList.remove('is-sticky');
    }
  }, { passive: true });

  const DURATION = 60;

  let allGames = [];
  let gameDataLoaded = false;
  let gameDataPromise = null;
  let gameRendered = false;
  let gameFadeTimer = null;
  const SKELETON_COUNT = 12;
  let _filterTimer = 0;
  let _lastFilterQuery = null;
  let savedScrollPosition = 0;
  let cardTemplate = null;
  let currentRenderAbortController = null;
  let currentRenderedGames = [];
  let cardObserver = null;

  const getSourceKey = () => {
    const source = localStorage.getItem('gameSource') || 'selenite';
    if (!['selenite', 'gn-math', 'edurocks', 'velara'].includes(source)) {
      return 'selenite';
    }
    return source;
  };
  const getCacheKey = () => `waves-game-cache${getSourceKey()}`;

  function setIconAsHome(isHome) {
    if (!iconEl) return;
    iconEl.className = isHome ? homeIconClass : defaultIconClass;
  }

  function dismissOverlays() {
    if (window.toggleSettingsMenu && document.getElementById('settings-menu')?.classList.contains('open')) {
      window.toggleSettingsMenu();
    }
    if (window.wavesUpdater && typeof window.wavesUpdater.hideSuccess === 'function' && document.getElementById('updateSuccess')?.style.display === 'block') {
      window.wavesUpdater.hideSuccess(true);
    }
    if (window.SharePromoter && typeof window.SharePromoter.hideWarningPrompt === 'function' && document.getElementById('warningPrompt')?.style.display === 'block') {
      window.SharePromoter.hideWarningPrompt(true);
    }
    if (window.hideBookmarkPrompt && document.getElementById('bookmark-prompt')?.style.display === 'block') {
      window.hideBookmarkPrompt(true);
    }
  }

  function updateCountLabel(count = null) {
    if (!gameDataLoaded) {
      return;
    }
  }

  function updateGamePlaceholder() {
    if (!gameSearchInput) return;

    if (!gameDataLoaded) {
      gameSearchInput.placeholder = `fetching games...`;
      return;
    }

    const count = allGames.length || 0;
    gameSearchInput.placeholder = `search through ${count} games... ٩(^ᗜ^ )و ´-`;
    updateCountLabel(count);
  }

  function setStatus(message) {
    if (noResultsEl) {
      noResultsEl.textContent = message;
      noResultsEl.style.display = 'block';
    }
    if (gameGrid) {
      gameGrid.style.display = 'none';
      gameGrid.innerHTML = '';
    }
  }

  function createSkeletonCard() {
    const card = document.createElement('article');
    card.className = 'game-card skeleton-card';

    const media = document.createElement('div');
    media.className = 'game-cover skeleton';
    card.appendChild(media);

    const info = document.createElement('div');
    info.className = 'game-info';

    const title = document.createElement('div');
    const meta = document.createElement('div');
    info.appendChild(title);
    info.appendChild(meta);

    card.appendChild(info);
    return card;
  }

  function showSkeletonLoading() {
    if (!gameGrid) return;
    if (gameGrid.children.length > 0 && !gameGrid.querySelector('.skeleton-card')) return;

    const fragment = document.createDocumentFragment();
    gameGrid.innerHTML = '';
    for (let i = 0; i < SKELETON_COUNT; i++) {
      fragment.appendChild(createSkeletonCard());
    }
    gameGrid.appendChild(fragment);
    gameGrid.style.display = 'grid';
    if (noResultsEl) noResultsEl.style.display = 'none';
  }

  function handleImageLoad(e) {
    const img = e.target;
    const media = img.parentElement;
    if (media) media.classList.remove('skeleton');
  }

  function handleImageError(e) {
    const img = e.target;
    const media = img.parentElement;
    if (media) {
      media.classList.remove('skeleton');
      media.classList.add('no-cover');
    }
  }

  function hydrateCard(card, game) {
    if (!game || card.hasChildNodes()) return;

    card.dataset.gameUrl = game.gameUrl;
    card.dataset.isExternal = game.isExternal;
    card.dataset.gameTitle = game.name;
    card.dataset.gameIcon = game.coverUrl;

    const media = document.createElement('div');
    media.className = 'game-cover skeleton';

    const img = document.createElement('img');
    img.loading = 'lazy';
    img.decoding = 'async';
    img.alt = game.name;
    img.src = game.coverUrl;
    img.onload = handleImageLoad;
    img.onerror = handleImageError;

    media.appendChild(img);

    const info = document.createElement('div');
    info.className = 'game-info';

    const title = document.createElement('h1');
    title.textContent = game.name;

    info.appendChild(title);

    card.appendChild(media);
    card.appendChild(info);
  }

  function renderGameCards(games) {
    if (!gameGrid) return;

    if (currentRenderAbortController) {
      currentRenderAbortController.abort();
    }
    const abortController = new AbortController();
    currentRenderAbortController = abortController;

    if (!cardObserver) {
      cardObserver = new IntersectionObserver((entries, observer) => {
        entries.forEach(entry => {
          if (entry.isIntersecting) {
            const card = entry.target;
            observer.unobserve(card);
            const idx = parseInt(card.dataset.idx, 10);
            if (!isNaN(idx) && currentRenderedGames[idx]) {
              hydrateCard(card, currentRenderedGames[idx]);
            }
          }
        });
      }, {
        root: yay || null,
        rootMargin: '400px'
      });
    }

    currentRenderedGames = games;
    cardObserver.disconnect();
    gameGrid.innerHTML = '';
    gameGrid.style.display = games.length ? 'grid' : 'none';
    gameRendered = true;

    if (!games.length) return;

    const CHUNK_SIZE = 150;
    let index = 0;

    function renderChunk() {
      if (abortController.signal.aborted) return;

      const fragment = document.createDocumentFragment();
      const end = Math.min(index + CHUNK_SIZE, games.length);

      for (let i = index; i < end; i++) {
        const game = games[i];
        const card = document.createElement('article');
        card.className = 'game-card';
        card.dataset.idx = i;

        card.dataset.gameUrl = game.gameUrl;
        card.dataset.isExternal = game.isExternal;
        card.dataset.gameTitle = game.name;
        card.dataset.gameIcon = game.coverUrl;

        if (i < 60) {
          hydrateCard(card, game);
        }

        fragment.appendChild(card);
      }

      gameGrid.appendChild(fragment);

      const children = gameGrid.children;
      for (let i = index; i < end; i++) {
        if (i >= 60) {
          cardObserver.observe(children[i]);
        }
      }

      index = end;

      if (index < games.length) {
        requestAnimationFrame(renderChunk);
      } else {
        currentRenderAbortController = null;
      }
    }

    renderChunk();
  }

  function filterAndDisplayGames() {
    if (!gameDataLoaded || !gameGrid) return;

    const query = (gameSearchInput?.value || '').toLowerCase().trim();

    if (query === _lastFilterQuery && gameRendered) return;
    _lastFilterQuery = query;

    if (query) {
      savedScrollPosition = 0;
    }

    let filteredGames = allGames;
    if (query) {
      filteredGames = allGames.filter(g => {
        const name = g._nameLc || '';
        const author = g._authorLc || '';
        return name.includes(query) || author.includes(query);
      });
    }

    if (filteredGames.length === 0) {
      if (currentRenderAbortController) {
        currentRenderAbortController.abort();
      }
      setStatus('zero games match were found :(');
      updateCountLabel(0);
      return;
    }

    if (noResultsEl) noResultsEl.style.display = 'none';
    updateCountLabel(filteredGames.length);

    if (yay) yay.scrollTop = 0;

    renderGameCards(filteredGames);
  }

  function getGameData() {
    if (!gameDataPromise) {
      const source = getSourceKey();
      const cacheKey = getCacheKey();

      updateGamePlaceholder();

      try {
        const cachedData = sessionStorage.getItem(cacheKey);
        if (cachedData) {
          allGames = JSON.parse(cachedData);
          gameDataLoaded = true;
          updateGamePlaceholder();
          return Promise.resolve(allGames);
        }
      } catch {
        sessionStorage.removeItem(cacheKey);
      }

      const saveToCache = (data) => {
        gameDataLoaded = true;
        updateGamePlaceholder();
        try {
          sessionStorage.setItem(cacheKey, JSON.stringify(data));
        } catch (e) {
          console.warn('unable to cache games', e);
        }
        return data;
      };

      if (source === 'velara') {
        gameDataPromise = fetch(SOURCE_CONFIG.velara.games)
          .then(res => res.ok ? res.json() : Promise.reject(res.statusText))
          .then(data => {
            allGames = data
              .filter(g =>
                g &&
                g.title &&
                g.title !== '!!DMCA' &&
                g.title !== '!!Game Request' &&
                !g.title.includes('[!]') &&
                !(g.location && g.location.includes('astra'))
              )
              .map(game => {
                let finalUrl = game.location;
                if (finalUrl && !finalUrl.startsWith('http')) {
                  finalUrl = SOURCE_CONFIG.velara.assets + (finalUrl.startsWith('/') ? '' : '/') + finalUrl;
                }

                return {
                  id: game.title,
                  name: game.title,
                  coverUrl: `/!cover!/${SOURCE_CONFIG.velara.assets}/${game.image}`,
                  gameUrl: finalUrl,
                  isExternal: !game.location && !!game.grdmca,
                  featured: false,
                  sourceKey: 'velara'
                };
              })
              .sort((a, b) => (a.name || "").localeCompare(b.name || ""));

            allGames.forEach(g => {
              g._nameLc = (g.name || "").toLowerCase();
              g._authorLc = (g.author || '').toLowerCase();
            });
            return saveToCache(allGames);
          });
      } else if (source === 'selenite') {
        gameDataPromise = fetch(SOURCE_CONFIG.selenite.games)
          .then(res => res.ok ? res.json() : Promise.reject(res.statusText))
          .then(data => {
            const games = Array.isArray(data) ? data : [];
            allGames = games
              .filter(game => game && game.name && game.directory)
              .map(game => {
              const gamePath = String(game.directory).replace(/^\/+/, '');
              const imagePath = String(game.image || '').replace(/^\/+/, '');
              const finalUrl = `${SOURCE_CONFIG.selenite.assets}${gamePath}`;
              const finalCover =  imagePath
                ? `${SOURCE_CONFIG.selenite.assets}${gamePath}/${imagePath}`
                : '';
              return {
                id: game.name,
                name: game.name,
                coverUrl: finalCover ? `/!cover!/${finalCover}` : '',
                gameUrl: finalUrl,
                isExternal: false,
                featured: false,
                sourceKey: 'selenite'
              };
            })
              .sort((a, b) => (a.name || "").localeCompare(b.name || ""));
            allGames.forEach(g => { g._nameLc = (g.name || "").toLowerCase(); g._authorLc = (g.author || '').toLowerCase(); });
            return saveToCache(allGames);
          });
      } else if (source === 'edurocks') {
        gameDataPromise = fetch(SOURCE_CONFIG.edurocks.games)
          .then(res => res.ok ? res.json() : Promise.reject(res.statusText))
          .then(data => {
            allGames = data.map(game => {
              let finalUrl = game.url.startsWith('http') ? game.url : SOURCE_CONFIG.edurocks.assets + '/' + game.url.replace(/^\.\//, '');
              let finalCover = game.img.startsWith('http') ? game.img : SOURCE_CONFIG.edurocks.assets + '/' + game.img.replace(/^\.\//, '');
              
              return {
                id: game.id || game.legacyId || game.name,
                name: game.name,
                coverUrl: `/!cover!/${finalCover}`,
                gameUrl: finalUrl,
                isExternal: false,
                featured: false,
                sourceKey: 'edurocks'
              };
            })
              .filter(game => !game.name.includes('[!]'))
              .sort((a, b) => (a.name || "").localeCompare(b.name || ""));
            
            allGames.forEach(g => { g._nameLc = (g.name || "").toLowerCase(); g._authorLc = ''; });
            return saveToCache(allGames);
          });
      } else {
        gameDataPromise = fetch(SOURCE_CONFIG.gnMath.zones)
          .then(res => res.ok ? res.json() : Promise.reject(res.statusText))
          .then(data => {
            allGames = data.map(zone => {
              const isExternal = zone.url.startsWith('http');
              return {
                id: zone.id,
                name: zone.name,
                author: zone.author,
                coverUrl: `/!cover!/${zone.cover.replace('{COVER_URL}', SOURCE_CONFIG.gnMath.covers)}`,
                gameUrl: isExternal ? zone.url : `https://gn-math.dev/?id=${zone.id}`,
                isExternal: isExternal,
                featured: zone.featured || false,
                sourceKey: 'gn-math'
              };
            })
              .filter(game => !game.name.includes('[!]') && !game.name.startsWith('Chat Bot'))
              .sort((a, b) => (a.featured === b.featured) ? a.name.localeCompare(b.name) : (a.featured ? -1 : 1));
            allGames.forEach(g => { g._nameLc = g.name.toLowerCase(); g._authorLc = (g.author || '').toLowerCase(); });
            return saveToCache(allGames);
          });
      }

      gameDataPromise.catch(err => {
        console.error('game fetch failed:', err);
        gameDataPromise = null;
      });
    }
    return gameDataPromise;
  }

  function resetGameData(showMessage) {
    if (currentRenderAbortController) {
      currentRenderAbortController.abort();
      currentRenderAbortController = null;
    }
    gameDataLoaded = false;
    gameRendered = false;
    gameDataPromise = null;
    allGames = [];
    savedScrollPosition = 0;
    cardTemplate = null;
    if (gameGrid) gameGrid.innerHTML = '';
    if (showMessage && noResultsEl) {
      noResultsEl.textContent = 'Refreshing games...';
      noResultsEl.style.display = 'block';
    } else if (noResultsEl) {
      noResultsEl.style.display = 'none';
    }
    try {
      sessionStorage.removeItem(getCacheKey());
    } catch { }
  }

  window.WavesApp = window.WavesApp || {};
  const normalizeGameMatchUrl = (candidate) => {
    if (!candidate || typeof candidate !== 'string') return null;
    try {
      const parsed = new URL(candidate);
      if (parsed.hostname && parsed.hostname.includes('gn-math.dev')) {
        const rawId = parsed.searchParams.get('id');
        if (rawId) {
          const decodedId = decodeURIComponent(String(rawId)).trim();
          const cleanId = decodedId.split(/[?&#]/)[0].trim();
          if (cleanId) {
            return `${parsed.protocol}//${parsed.host}/?id=${encodeURIComponent(cleanId)}`;
          }
        }
      }
      let pathname = parsed.pathname || '/';
      pathname = pathname.replace(/\/+$/, '');
      if (!pathname) pathname = '/';
      pathname = pathname.replace(/\/index\.(html?|php)$/i, '');
      if (!pathname) pathname = '/';
      return `${parsed.protocol}//${parsed.host}${pathname}${parsed.search}`;
    } catch (e) {
      return candidate.trim().replace(/\/+$/, '').toLowerCase();
    }
  };

  window.WavesApp.getGameDisplayLabel = function (realUrl) {
    try {
      if (!realUrl || !allGames || !allGames.length) return null;
      let match = allGames.find(g => g.gameUrl === realUrl);

      if (!match) {
        const normalizedRealUrl = normalizeGameMatchUrl(realUrl);
        if (normalizedRealUrl) {
          match = allGames.find(g => normalizeGameMatchUrl(g.gameUrl) === normalizedRealUrl);
        }
      }

      if (!match) {
        try {
          const u = new URL(realUrl);
          if (u.hostname && u.hostname.includes('gn-math.dev')) {
            let id = u.searchParams.get('id');
            if (id) {
              const rawId = String(id).trim();
              const decodedId = decodeURIComponent(rawId);
              match = allGames.find(g =>
                g.sourceKey === 'gn-math' &&
                (String(g.id) === rawId || String(g.id) === decodedId)
              );

              if (!match) {
                const numericMatch = rawId.match(/\d+/);
                if (numericMatch) {
                  const numericId = numericMatch[0];
                  match = allGames.find(g => g.sourceKey === 'gn-math' && String(g.id) === String(numericId));
                }
              }
            }
          }
        } catch (e) {
        }
      }

      if (!match) return null;
      const source = (match.sourceKey || localStorage.getItem('gameSource') || 'selenite').toLowerCase();
      const rawName = match.name || match.id || realUrl;
      const name = String(rawName).toLowerCase();
      return `game: ${name} / source: ${source}`;
    } catch (e) {
      return null;
    }
  };

  function showGamesPage() {
    if (gameFadeTimer) {
      clearTimeout(gameFadeTimer);
      gameFadeTimer = null;
    }

    if (document.body.classList.contains('watch-view') && window.hideWatchMenu) {
      window.hideWatchMenu();
    }

    showHomeView();
    dismissOverlays();
    if (overlay) overlay.classList.remove('fade-out');
    document.body.classList.add('games-view');
    gamesPage.classList.add('is-visible');
    gamesPage.classList.remove('is-active');

    const isAlreadyRendered = gameDataLoaded && gameGrid && gameGrid.children.length > 0;

    requestAnimationFrame(() => {
      gamesPage.classList.add('is-active');

      if (yay) {
        yay.scrollTop = savedScrollPosition;
      } else {
        window.scrollTo(0, savedScrollPosition);
      }
    });

    gamesPage.setAttribute('aria-hidden', 'false');
    setIconAsHome(true);
    localStorage.setItem('wavesUserOpenedGameMenu', 'true');

    if (isAlreadyRendered) return;

    showSkeletonLoading();

    gameRendered = false;

    getGameData()
      .then(() => {
        _lastFilterQuery = null;
        filterAndDisplayGames();
      })
      .catch(() => setStatus('failed to fetch games .‸. (this is an issue with the source)'));
  }

  function hideGamesPage() {
    if (!document.body.classList.contains('games-view')) return;

    if (yay) {
      savedScrollPosition = yay.scrollTop;
    } else {
      savedScrollPosition = window.scrollY || document.documentElement.scrollTop;
    }

    if (gameFadeTimer) {
      clearTimeout(gameFadeTimer);
    }
    gamesPage.classList.remove('is-active');
    gameFadeTimer = setTimeout(() => {
      gamesPage.classList.remove('is-visible');
      document.body.classList.remove('games-view');
      gamesPage.setAttribute('aria-hidden', 'true');
      setIconAsHome(false);
      if (overlay) overlay.classList.remove('show');
      gameFadeTimer = null;
    }, DURATION);
  }

  function toggleGamesPage() {
    if (document.body.classList.contains('games-view')) {
      hideGamesPage();
    } else {
      showGamesPage();
    }
  }

  document.addEventListener('gameSourceUpdated', () => {
    resetGameData(true);
    if (document.body.classList.contains('games-view')) {
      showSkeletonLoading();
      getGameData().then(() => {
        _lastFilterQuery = null;
        filterAndDisplayGames();
      });
    }
  });

  if (gameSearchInput) {
    gameSearchInput.addEventListener('input', () => {
      clearTimeout(_filterTimer);
      _filterTimer = setTimeout(filterAndDisplayGames, 120);
    });
  }

  if (refreshBtn) {
    refreshBtn.addEventListener('click', () => {
      resetGameData(true);
      showSkeletonLoading();
      getGameData()
        .then(() => {
          _lastFilterQuery = null;
          filterAndDisplayGames();
        })
        .catch(() => setStatus('Error refreshing games.'));
    });
  }

  if (gameGrid) {
    gameGrid.addEventListener('click', (e) => {
      const card = e.target.closest('.game-card');
      if (card && card.dataset.gameUrl) {
        const gameUrl = card.dataset.gameUrl;
        const isExternal = card.dataset.isExternal === 'true';

        if (isExternal) {
          window.open(gameUrl, '_blank');
        } else if (window.WavesApp?.handleSearch) {
          hideGamesPage();
          const gameTitle = card.dataset.gameTitle || card.dataset.gameName;
          const gameIcon = card.dataset.gameIcon;
          window.WavesApp.handleSearch(gameUrl, gameTitle, gameIcon);
        }
      }
    });
  }

  gameIcon.addEventListener('click', e => {
    e.preventDefault();
    toggleGamesPage();
  });

  const brandToggleTarget = brandingContainer || brand;
  if (brandToggleTarget) {
    brandToggleTarget.addEventListener('click', e => {
      e.preventDefault();
      if (document.body.classList.contains('games-view')) {
        hideGamesPage();
      }
    });
  }

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && document.body.classList.contains('games-view')) {
      hideGamesPage();
    }
  }, true);

  window.showGameMenu = showGamesPage;
  window.hideGameMenu = hideGamesPage;
  window.toggleGameMenu = toggleGamesPage;
}