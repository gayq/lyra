import { showHomeView } from '../ui/ui.js';
import { attachSearchLight } from '../core/load.js';

export function initializeGame() {
  const wrapper = document.querySelector('.wrapper');
  const mainContainer = document.querySelector('.main-container');
  const gameIcon = document.getElementById('choi');
  const brand = document.getElementById('brand');
  const brandingContainer = document.getElementById('branding-container');
  const overlay = document.getElementById('overlay');

  if (!wrapper || !gameIcon) return;

  const iconEl = gameIcon.querySelector('i');
  const defaultIconClass = iconEl?.className || 'fa-solid fa-gamepad-modern';
  const homeIconClass = 'fa-solid fa-magnifying-glass';

  const SOURCE_CONFIG = {
    gnMath: {
      zones: "/!!/https://cdn.jsdelivr.net/gh/gn-math/assets@main/zones.json",
      covers: "https://cdn.jsdelivr.net/gh/gn-math/covers@main",
      html: "https://cdn.jsdelivr.net/gh/gn-math/html@main"
    },
    selenite: {
      games: "/!!/https://selenite.cc/resources/games.json",
      assets: "https://selenite.cc/resources/semag"
    },
    truffled: {
      games: "/!!/https://truffled.lol/js/json/g.json",
      assets: "https://truffled.lol"
    },
    velara: {
      games: "/!!/https://velara.cc/json/gg.json",
      assets: "https://velara.cc"
    },
    duckMath: {
      games: "/!!/https://cdn.jsdelivr.net/gh/duckmath/duckmath.github.io@main/backup_classes.json"
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
          <i class="fa-regular fa-magnifying-glass games-search-icon"></i>
          <input type="text" id="gameSearchInput" placeholder="Search games..." autocomplete="off">
        </div>
      </div>
      <div class="game-grid-container">
        <div class="game-grid"></div>
        <div class="game-grid-sentinel" aria-hidden="true"></div>
        <p class="no-results-message">Fetching games...</p>
      </div>
    `;

    if (mainContainer) {
      mainContainer.insertAdjacentElement('afterend', gamesPage);
    } else {
      wrapper.prepend(gamesPage);
    }
  }

  const gamesTopbar = gamesPage.querySelector('.games-topbar');
  const gameGrid = gamesPage.querySelector('.game-grid');
  const gameSearchInput = gamesPage.querySelector('#gameSearchInput');
  const noResultsEl = gamesPage.querySelector('.no-results-message');
  const gameGridContainer = gamesPage.querySelector('.game-grid-container');
  const gameGridSentinel = gamesPage.querySelector('.game-grid-sentinel');
  const refreshBtn = gamesPage.querySelector('#games-refresh-btn');
  const gamesSearchBar = gamesPage.querySelector('.games-search-bar');

  attachSearchLight(gamesSearchBar);

  const DURATION = 60;
  let allGames = [];
  let currentFilteredGames = [];
  let currentVisibleCount = 0;
  let gameDataLoaded = false;
  let gameDataPromise = null;
  let gameRendered = false;
  let gameFadeTimer = null;
  const SKELETON_COUNT = 12;
  const MAX_VISIBLE_GAMES = 120;
  const SCROLL_THRESHOLD = 350;
  let loadingMoreGames = false;
  let sentinelObserver = null;

  const getSourceKey = () => localStorage.getItem('gameSource') || 'GN-Math';
  const getCacheKey = () => `xin_game_cache_${getSourceKey()}`;

  function setIconAsHome(isHome) {
    if (!iconEl) return;
    iconEl.className = isHome ? homeIconClass : defaultIconClass;
  }

  function dismissOverlays() {
    if (window.toggleSettingsMenu && document.getElementById('settings-menu')?.classList.contains('open')) {
      window.toggleSettingsMenu();
    }
    if (window.xinUpdater && typeof window.xinUpdater.hideSuccess === 'function' && document.getElementById('updateSuccess')?.style.display === 'block') {
      window.xinUpdater.hideSuccess(true);
    }
    if (window.SharePromoter && typeof window.SharePromoter.hideSharePrompt === 'function' && document.getElementById('sharePrompt')?.style.display === 'block') {
      window.SharePromoter.hideSharePrompt(true);
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
    const count = allGames.length || 0;
    gameSearchInput.placeholder = `Search through ${count} games...`;
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
    media.className = 'game-image skeleton';
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
    const fragment = document.createDocumentFragment();
    gameGrid.innerHTML = '';
    for (let i = 0; i < SKELETON_COUNT; i++) {
      fragment.appendChild(createSkeletonCard());
    }
    gameGrid.appendChild(fragment);
    gameGrid.style.display = 'grid';
    if (noResultsEl) noResultsEl.style.display = 'none';
  }

  function createGameCard(game) {
    const card = document.createElement('article');
    card.className = 'game-card';
    card.dataset.gameUrl = game.gameUrl;
    card.dataset.isExternal = game.isExternal;
    card.dataset.gameName = game.name.toLowerCase();
    card.dataset.gameTitle = game.name;
    card.dataset.gameAuthor = (game.author || '').toLowerCase();
    card.dataset.featured = game.featured ? 'true' : 'false';

    const media = document.createElement('div');
    media.className = 'game-image skeleton';

    const img = document.createElement('img');
    img.alt = `${game.name} artwork`;
    img.loading = 'lazy';
    img.src = game.coverUrl;
    img.onload = () => media.classList.remove('skeleton');
    img.onerror = () => media.classList.remove('skeleton');
    media.appendChild(img);

    const info = document.createElement('div');
    info.className = 'game-info';

    const title = document.createElement('h1');
    title.textContent = game.name;
    info.appendChild(title);

    card.appendChild(media);
    card.appendChild(info);

    return card;
  }

  function renderGameCards(games) {
    if (!gameGrid) return;
    gameGrid.innerHTML = '';
    const fragment = document.createDocumentFragment();
    games.forEach(game => fragment.appendChild(createGameCard(game)));
    gameGrid.appendChild(fragment);
    gameGrid.style.display = games.length ? 'grid' : 'none';
  }

  function renderGames() {
    if (gameRendered || !gameDataLoaded || !gameGrid) return;
    currentFilteredGames = [...allGames];
    currentVisibleCount = MAX_VISIBLE_GAMES;
    renderGameCards(currentFilteredGames.slice(0, currentVisibleCount));
    gameRendered = true;
  }

  function filterAndDisplayGames() {
    if (!gameDataLoaded || !gameGrid) return;

    const query = (gameSearchInput?.value || '').toLowerCase().trim();
    const filteredGames = allGames.filter(game => {
      const matchesName = game.name.toLowerCase().includes(query);
      const matchesAuthor = (game.author || '').toLowerCase().includes(query);
      return !query || matchesName || matchesAuthor;
    });

    const resultsFound = filteredGames.length;
    if (resultsFound === 0) {
      setStatus('Zero games match were found :(');
      updateCountLabel(0);
      return;
    }

    if (noResultsEl) {
      noResultsEl.style.display = 'none';
    }

    currentFilteredGames = filteredGames;
    currentVisibleCount = MAX_VISIBLE_GAMES;
    const visibleGames = currentFilteredGames.slice(0, currentVisibleCount);
    renderGameCards(visibleGames);
    updateCountLabel(resultsFound);
  }

  function loadMoreGames() {
    if (loadingMoreGames || currentFilteredGames.length <= currentVisibleCount) return;
    loadingMoreGames = true;
    const remaining = currentFilteredGames.length - currentVisibleCount;
    currentVisibleCount += Math.min(MAX_VISIBLE_GAMES, remaining);
    const visibleGames = currentFilteredGames.slice(0, currentVisibleCount);
    renderGameCards(visibleGames);
    requestAnimationFrame(() => {
      loadingMoreGames = false;
    });
  }

  function handleScroll() {
    if (!document.body.classList.contains('games-view')) return;
    if (!gameDataLoaded || currentFilteredGames.length <= currentVisibleCount) return;

    const candidates = new Set([
      document.scrollingElement || document.documentElement,
      document.body,
      wrapper,
      gameGridContainer
    ]);
    for (const candidate of candidates) {
      if (!candidate) continue;
      const scrollTop = candidate.scrollTop || 0;
      const scrollHeight = candidate.scrollHeight || 0;
      const clientHeight = candidate.clientHeight || window.innerHeight;
      if (scrollHeight <= clientHeight) continue;
      if (scrollHeight - (scrollTop + clientHeight) <= SCROLL_THRESHOLD) {
        loadMoreGames();
        break;
      }
    }
  }

  function observeGridSentinel() {
    if (!gameGridSentinel) return;
    if (sentinelObserver) {
      sentinelObserver.disconnect();
    }

    const root = gameGridContainer || null;
    sentinelObserver = new IntersectionObserver((entries) => {
      if (!document.body.classList.contains('games-view')) return;
      if (!gameDataLoaded || currentFilteredGames.length <= currentVisibleCount) return;
      if (gameGridContainer) {
        const overflow = gameGridContainer.scrollHeight - gameGridContainer.clientHeight;
        if (overflow <= 0) return;
      }
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          loadMoreGames();
        }
      });
    }, {
      root,
      rootMargin: `0px 0px ${SCROLL_THRESHOLD}px 0px`,
      threshold: 0
    });

    sentinelObserver.observe(gameGridSentinel);
  }

  function getGameData() {
    if (!gameDataPromise) {
      const source = getSourceKey();
      const cacheKey = getCacheKey();

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
          console.warn('Unable to cache games', e);
        }
        return data;
      };

      if (source === 'Selenite') {
        gameDataPromise = fetch(SOURCE_CONFIG.selenite.games)
          .then(res => res.ok ? res.json() : Promise.reject(res.statusText))
          .then(data => {
            allGames = data.map(game => ({
              id: game.directory,
              name: game.name,
              author: 'Selenite',
              coverUrl: `/!!/${SOURCE_CONFIG.selenite.assets}/${game.directory}/${game.image}`,
              gameUrl: `${SOURCE_CONFIG.selenite.assets}/${game.directory}/`,
              isExternal: false,
              featured: game.tags && game.tags.includes('top')
            })).sort((a, b) => a.name.localeCompare(b.name));
            return saveToCache(allGames);
          });
      } else if (source === 'Truffled') {
        gameDataPromise = fetch(SOURCE_CONFIG.truffled.games)
          .then(res => res.ok ? res.json() : Promise.reject(res.statusText))
          .then(data => {
            const games = data.games || [];
            allGames = games.map(game => {
              let finalUrl = game.url.startsWith('http') ? game.url : SOURCE_CONFIG.truffled.assets + (game.url.startsWith('/') ? '' : '/') + game.url;
              let finalCover = game.thumbnail.startsWith('http') ? game.thumbnail : SOURCE_CONFIG.truffled.assets + (game.thumbnail.startsWith('/') ? '' : '/') + game.thumbnail;
              return {
                id: game.name,
                name: game.name,
                author: 'Truffled',
                coverUrl: `/!!/${finalCover}`,
                gameUrl: finalUrl,
                isExternal: false,
                featured: false
              };
            }).sort((a, b) => a.name.localeCompare(b.name));
            return saveToCache(allGames);
          });
      } else if (source === 'Velara') {
        gameDataPromise = fetch(SOURCE_CONFIG.velara.games)
          .then(res => res.ok ? res.json() : Promise.reject(res.statusText))
          .then(data => {
            allGames = data
              .filter(g => g.name !== '!!DMCA' && g.name !== '!!Game Request')
              .map(game => {
                let finalUrl = game.link;
                if (finalUrl && !finalUrl.startsWith('http')) finalUrl = SOURCE_CONFIG.velara.assets + (finalUrl.startsWith('/') ? '' : '/') + finalUrl;
                else if (game.grdmca) finalUrl = game.grdmca;

                return {
                  id: game.name,
                  name: game.name,
                  author: 'Velara',
                  coverUrl: `/!!/${SOURCE_CONFIG.velara.assets}/assets/game-imgs/${game.imgpath}`,
                  gameUrl: finalUrl,
                  isExternal: !game.link && !!game.grdmca,
                  featured: false
                };
              }).sort((a, b) => a.name.localeCompare(b.name));
            return saveToCache(allGames);
          });
      } else if (source === 'DuckMath') {
        gameDataPromise = fetch(SOURCE_CONFIG.duckMath.games)
          .then(res => res.ok ? res.json() : Promise.reject(res.statusText))
          .then(data => {
            allGames = data.map(game => ({
              id: game.id,
              name: game.title.replace(/-/g, ' ').replace(/\b\w/g, l => l.toUpperCase()),
              author: game.developer_name || 'DuckMath',
              coverUrl: `/!!/${game.icon}`,
              gameUrl: game.link,
              isExternal: false,
              featured: game.is_featured || false
            })).sort((a, b) => a.name.localeCompare(b.name));
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
                coverUrl: zone.cover.replace('{COVER_URL}', SOURCE_CONFIG.gnMath.covers),
                gameUrl: isExternal ? zone.url : zone.url.replace('{HTML_URL}', SOURCE_CONFIG.gnMath.html),
                isExternal: isExternal,
                featured: zone.featured || false
              };
            })
              .filter(game => !game.name.startsWith('[!]') && !game.name.startsWith('Chat Bot'))
              .sort((a, b) => (a.featured === b.featured) ? a.name.localeCompare(b.name) : (a.featured ? -1 : 1));
            return saveToCache(allGames);
          });
      }

      gameDataPromise.catch(err => {
        console.error('Game fetch failed:', err);
        gameDataPromise = null;
      });
    }
    return gameDataPromise;
  }

  function resetGameData(showMessage) {
    gameDataLoaded = false;
    gameRendered = false;
    gameDataPromise = null;
    allGames = [];
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

  function showGamesPage() {
    if (gameFadeTimer) {
      clearTimeout(gameFadeTimer);
      gameFadeTimer = null;
    }
    showHomeView();
    dismissOverlays();
    if (overlay) overlay.classList.remove('fade-out');
    document.body.classList.add('games-view');
    gamesPage.classList.add('is-visible');
    gamesPage.classList.remove('is-active');
    requestAnimationFrame(() => {
      gamesPage.classList.add('is-active');
    });
    gamesPage.setAttribute('aria-hidden', 'false');
    setIconAsHome(true);
    localStorage.setItem('wavesUserOpenedGameMenu', 'true');

    if (gameDataLoaded && gameRendered) {
      filterAndDisplayGames();
      return;
    }

    if (noResultsEl) {
      noResultsEl.textContent = 'Fetching games...';
    }
    showSkeletonLoading();

    getGameData()
      .then(() => {
        renderGames();
        filterAndDisplayGames();
      })
      .catch(() => setStatus('Error fetching games.'));
  }

  function hideGamesPage() {
    if (!document.body.classList.contains('games-view')) return;
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
      if (gameSearchInput) {
        gameSearchInput.value = '';
      }
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
        renderGames();
        filterAndDisplayGames();
      });
    }
  });

  if (gameSearchInput) {
    gameSearchInput.addEventListener('input', filterAndDisplayGames);
  }


  if (refreshBtn) {
    refreshBtn.addEventListener('click', () => {
      resetGameData(true);
      showSkeletonLoading();
      getGameData()
        .then(() => {
          renderGames();
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
          window.WavesApp.handleSearch(gameUrl, gameTitle);
        }
      }
    });
  }

  const scrollTargets = new Set([window, document, wrapper, gameGridContainer]);
  scrollTargets.forEach(target => {
    if (!target || typeof target.addEventListener !== 'function') return;
    target.addEventListener('scroll', handleScroll, { passive: true });
  });
  window.addEventListener('resize', handleScroll, { passive: true });
  observeGridSentinel();

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
