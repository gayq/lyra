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

    gnMath: {
      zones: "/!!/https://cdn.jsdelivr.net/gh/gn-math/assets@main/zones.json",
      covers: "https://cdn.jsdelivr.net/gh/gn-math/covers@main"
    },
    squall: {
      games: "/!!/https://squall.cc/games/games.json",
      assets: "https://squall.cc"
    },
    truffled: {
      games: "/!!/https://truffled.lol/js/json/g.json",
      assets: "https://truffled.lol"
    },
    velara: {
      games: "/!!/https://velara.cc/data/games.json",
      assets: "https://velara.cc"
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
          <input type="text" id="gameSearchInput" placeholder="fetching..." autocomplete="off">
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

  const getSourceKey = () => localStorage.getItem('gameSource') || 'gn-math';
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
    gameSearchInput.placeholder = `search through ${count} games...`;
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

  function getCardTemplate() {
    if (cardTemplate) return cardTemplate;

    const card = document.createElement('article');
    card.className = 'game-card';

    const media = document.createElement('div');
    media.className = 'game-cover skeleton';

    const img = document.createElement('img');
    img.loading = 'lazy';
    img.decoding = 'async';
    media.appendChild(img);

    const info = document.createElement('div');
    info.className = 'game-info';

    const title = document.createElement('h1');
    info.appendChild(title);

    card.appendChild(media);
    card.appendChild(info);

    cardTemplate = card;
    return cardTemplate;
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

  function createGameCard(game) {
    const card = getCardTemplate().cloneNode(true);

    card.dataset.gameUrl = game.gameUrl;
    card.dataset.isExternal = game.isExternal;
    card.dataset.gameName = game.name.toLowerCase();
    card.dataset.gameTitle = game.name;
    card.dataset.gameAuthor = (game.author || '').toLowerCase();
    card.dataset.featured = game.featured ? 'true' : 'false';
    card.dataset.gameIcon = game.coverUrl;

    const media = card.firstChild;
    const img = media.firstChild;
    const info = card.lastChild;
    const title = info.firstChild;

    img.alt = game.name;
    img.src = game.coverUrl;

    img.onload = handleImageLoad;
    img.onerror = handleImageError;

    title.textContent = game.name;

    return card;
  }

  function renderGameCards(games) {
    if (!gameGrid) return;

    const fragment = document.createDocumentFragment();
    const count = games.length;

    for (let i = 0; i < count; i++) {
      fragment.appendChild(createGameCard(games[i]));
    }

    gameGrid.innerHTML = '';
    gameGrid.appendChild(fragment);

    gameGrid.style.display = games.length ? 'grid' : 'none';
  }

  function renderGames() {
    if (gameRendered || !gameDataLoaded || !gameGrid) return;
    renderGameCards(allGames);
    gameRendered = true;
    _lastFilterQuery = null;
  }

  function filterAndDisplayGames() {
    if (!gameDataLoaded || !gameGrid) return;

    const query = (gameSearchInput?.value || '').toLowerCase().trim();

    if (query === _lastFilterQuery) return;
    _lastFilterQuery = query;

    if (query) {
      savedScrollPosition = 0;
    }

    const cards = gameGrid.children;
    const cardCount = cards.length;

    if (!cardCount) {
      renderGameCards(allGames);
    }

    if (!query) {
      if (noResultsEl) noResultsEl.style.display = 'none';
      for (let i = 0; i < cardCount; i++) {
        cards[i].style.display = '';
      }
      gameGrid.style.display = 'grid';
      updateCountLabel(allGames.length);
      return;
    }

    let visibleCount = 0;
    for (let i = 0; i < cardCount; i++) {
      const card = cards[i];
      const name = card.dataset.gameName || '';
      const author = card.dataset.gameAuthor || '';
      const match = name.includes(query) || author.includes(query);
      card.style.display = match ? '' : 'none';
      if (match) visibleCount++;
    }

    if (visibleCount === 0) {
      setStatus('zero games match were found :(');
      updateCountLabel(0);
      return;
    }

    if (noResultsEl) noResultsEl.style.display = 'none';
    gameGrid.style.display = 'grid';
    updateCountLabel(visibleCount);

    if (yay) yay.scrollTop = 0;
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

      if (source === 'truffled') {
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
                coverUrl: `/!!/${finalCover}`,
                gameUrl: finalUrl,
                isExternal: false,
                featured: false
              };
            }).sort((a, b) => a.name.localeCompare(b.name));
            allGames.forEach(g => { g._nameLc = g.name.toLowerCase(); g._authorLc = (g.author || '').toLowerCase(); });
            return saveToCache(allGames);
          });
      } else if (source === 'velara') {
        gameDataPromise = fetch(SOURCE_CONFIG.velara.games)
          .then(res => res.ok ? res.json() : Promise.reject(res.statusText))
          .then(data => {
            allGames = data
              .filter(g =>
                g &&
                g.title &&
                g.title !== '!!DMCA' &&
                g.title !== '!!Game Request' &&
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
                  coverUrl: `/!!/${SOURCE_CONFIG.velara.assets}/${game.image}`,
                  gameUrl: finalUrl,
                  isExternal: !game.location && !!game.grdmca,
                  featured: false
                };
              })
              .sort((a, b) => (a.name || "").localeCompare(b.name || ""));

            allGames.forEach(g => {
              g._nameLc = (g.name || "").toLowerCase();
              g._authorLc = (g.author || '').toLowerCase();
            });
            return saveToCache(allGames);
          });
      } else if (source === 'squall') {
        gameDataPromise = fetch(SOURCE_CONFIG.squall.games)
          .then(res => res.ok ? res.json() : Promise.reject(res.statusText))
          .then(data => {
            allGames = data.map(game => {
              let finalUrl = game.link.startsWith('http') ? game.link : SOURCE_CONFIG.squall.assets + '/games/' + (game.link.startsWith('/') ? game.link.substring(1) : game.link);
              let finalCover = game.cover.startsWith('http') ? game.cover : SOURCE_CONFIG.squall.assets + '/games/' + (game.cover.startsWith('/') ? game.cover.substring(1) : game.cover);
              return {
                id: game.name,
                name: game.name,
                coverUrl: `/!!/${finalCover}`,
                gameUrl: finalUrl,
                isExternal: false,
                featured: false
              };
            }).sort((a, b) => (a.name || "").localeCompare(b.name || ""));
            allGames.forEach(g => { g._nameLc = (g.name || "").toLowerCase(); g._authorLc = (g.author || '').toLowerCase(); });
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
                coverUrl: `/!!/${zone.cover.replace('{COVER_URL}', SOURCE_CONFIG.gnMath.covers)}`,
                gameUrl: isExternal ? zone.url : `https://gn-math.dev/?id=${zone.id}`,
                isExternal: isExternal,
                featured: zone.featured || false
              };
            })
              .filter(game => !game.name.startsWith('[!]') && !game.name.startsWith('Chat Bot'))
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
        renderGames();
        filterAndDisplayGames();
      })
      .catch(() => setStatus('failed to fetch games :('));
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
        renderGames();
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