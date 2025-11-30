export function initializeGame() {
  let gameMenu = document.getElementById('game-menu');
  if (!gameMenu) {
    gameMenu = document.createElement('div');
    gameMenu.id = 'game-menu';
    gameMenu.className = 'game-menu';
    document.body.appendChild(gameMenu);

    gameMenu.innerHTML = `
            <div class="game-menu-content">
                <div class="game-menu-header">
                    <h2>Games</h2>
                </div>
                <i style="position: absolute; top: 72px; z-index: 9999; margin-left: 3px; transform: translateY(-50%); font-size: 18px; color: #ffffff1f; pointer-events: none;" class="fa-regular fa-magnifying-glass"></i>
                <div class="game-search-bar" style="position:relative;">
                    <input type="text" id="gameSearchInput" placeholder="Search for games..." autocomplete="off">
                </div>
                <div class="game-grid-container">
                    <div class="game-grid"></div>
                    <div id="gameSentinel" class="game-sentinel"></div>
                </div>
                <p class="no-results-message" style="color: #b1b1b1; text-align: center; display: none;"></p>
                <button id="close-game-menu"><i class="fa-regular fa-times"></i></button>
            </div>
        `;
  }

  const GN_ZONES_URL = "/!!/https://cdn.jsdelivr.net/gh/gn-math/assets@main/zones.json";
  const GN_COVER_URL = "https://cdn.jsdelivr.net/gh/gn-math/covers@main";
  const GN_HTML_URL = "https://cdn.jsdelivr.net/gh/gn-math/html@main";
  const SELENITE_GAME_URL = "/!!/https://selenite.cc/resources/games.json";
  const SELENITE_ASSETS_URL = "https://selenite.cc/resources/semag";
  const TRUFFLED_GAME_URL = "/!!/https://truffled.lol/js/json/g.json";
  const TRUFFLED_ASSETS_URL = "https://truffled.lol";
  const VELARA_GAME_URL = "/!!/https://velara.cc/json/gg.json";
  const VELARA_ASSETS_URL = "https://velara.cc";
  const DUCKMATH_GAME_URL = "/!!/https://cdn.jsdelivr.net/gh/duckmath/duckmath.github.io@main/backup_classes.json";
  const gameMenuContent = gameMenu.querySelector('.game-menu-content');
  const closeGameMenuBtn = document.getElementById('close-game-menu');
  const gameSearchInput = document.getElementById('gameSearchInput');
  const gameGrid = gameMenu.querySelector('.game-grid');
  const gameGridContainer = gameMenu.querySelector('.game-grid-container');
  const gameIcon = document.getElementById('choi');
  const shortcutPromptOverlay = document.getElementById('overlay');
  const gameCredits = gameMenu.querySelector('.game-credits');
  const gameArrow = document.getElementById('arrow-pointer');

  if (gameArrow && localStorage.getItem('wavesUserOpenedGameMenu') !== 'true') {
    gameArrow.classList.add('show');
  }

  let allGames = [];
  let isMenuTransitioning = false;

  let gameDataLoaded = false;
  let gameDataPromise = null;
  let gameRendered = false;

  function getGameData() {
    if (!gameDataPromise) {
      const source = localStorage.getItem('gameSource') || 'GN-Math';
      const cacheKey = `xin_game_cache_${source}`;

      const cachedData = sessionStorage.getItem(cacheKey);
      if (cachedData) {
        try {
          allGames = JSON.parse(cachedData);
          gameDataLoaded = true;
          updateGamePlaceholder();
          return Promise.resolve(allGames);
        } catch (e) {
          sessionStorage.removeItem(cacheKey);
        }
      }

      if (source === 'Selenite') {
        gameDataPromise = fetch(SELENITE_GAME_URL)
          .then(res => {
            if (!res.ok) throw new Error(`Selenite fetch failed: ${res.statusText}`);
            return res.json();
          })
          .then(data => {
            allGames = data.map(game => {
              return {
                id: game.directory,
                name: game.name,
                author: "Selenite",
                coverUrl: `/!!/${SELENITE_ASSETS_URL}/${game.directory}/${game.image}`,
                gameUrl: `${SELENITE_ASSETS_URL}/${game.directory}/`,
                isExternal: false,
                featured: game.tags && game.tags.includes("top")
              };
            }).sort((a, b) => a.name.localeCompare(b.name));

            gameDataLoaded = true;
            updateGamePlaceholder();
            try {
              sessionStorage.setItem(cacheKey, JSON.stringify(allGames));
            } catch (e) {}
            return allGames;
          })
          .catch(err => {
            console.error('Failed to load Selenite games:', err);
            gameDataPromise = null;
            throw err;
          });

      } else if (source === 'Truffled') {
        gameDataPromise = fetch(TRUFFLED_GAME_URL)
          .then(res => {
            if (!res.ok) throw new Error(`Truffled fetch failed: ${res.statusText}`);
            return res.json();
          })
          .then(data => {
            const games = data.games || [];
            allGames = games.map(game => {
              let finalUrl = game.url;
              if (!finalUrl.startsWith('http')) {
                finalUrl = TRUFFLED_ASSETS_URL + (finalUrl.startsWith('/') ? '' : '/') + finalUrl;
              }

              let finalCover = game.thumbnail;
              if (!finalCover.startsWith('http')) {
                finalCover = TRUFFLED_ASSETS_URL + (finalCover.startsWith('/') ? '' : '/') + finalCover;
              }

              return {
                id: game.name,
                name: game.name,
                author: "Truffled",
                coverUrl: `/!!/${finalCover}`,
                gameUrl: finalUrl,
                isExternal: false,
                featured: false
              };
            }).sort((a, b) => a.name.localeCompare(b.name));

            gameDataLoaded = true;
            updateGamePlaceholder();
            try {
              sessionStorage.setItem(cacheKey, JSON.stringify(allGames));
            } catch (e) {}
            return allGames;
          })
          .catch(err => {
            console.error('Failed to load Truffled games:', err);
            gameDataPromise = null;
            throw err;
          });

      } else if (source === 'Velara') {
        gameDataPromise = fetch(VELARA_GAME_URL)
          .then(res => {
            if (!res.ok) throw new Error(`Velara fetch failed: ${res.statusText}`);
            return res.json();
          })
          .then(data => {
            allGames = data
              .filter(game => game.name !== "!!DMCA" && game.name !== "!!Game Request")
              .map(game => {
                let finalUrl = game.link;
                const isExternal = !finalUrl && !!game.grdmca;

                if (finalUrl) {
                  if (!finalUrl.startsWith('http')) {
                    finalUrl = VELARA_ASSETS_URL + (finalUrl.startsWith('/') ? '' : '/') + finalUrl;
                  }
                } else if (game.grdmca) {
                  finalUrl = game.grdmca;
                }

                return {
                  id: game.name,
                  name: game.name,
                  author: "Velara",
                  coverUrl: `/!!/${VELARA_ASSETS_URL}/assets/game-imgs/${game.imgpath}`,
                  gameUrl: finalUrl,
                  isExternal: isExternal,
                  featured: false
                };
              })
              .sort((a, b) => a.name.localeCompare(b.name));

            gameDataLoaded = true;
            updateGamePlaceholder();
            try {
              sessionStorage.setItem(cacheKey, JSON.stringify(allGames));
            } catch (e) {}
            return allGames;
          })
          .catch(err => {
            console.error('Failed to load Velara games:', err);
            gameDataPromise = null;
            throw err;
          });

      } else if (source === 'DuckMath') {
        gameDataPromise = fetch(DUCKMATH_GAME_URL)
          .then(res => {
            if (!res.ok) throw new Error(`DuckMath fetch failed: ${res.statusText}`);
            return res.json();
          })
          .then(data => {
            allGames = data
              .map(game => {
                const formattedName = game.title.replace(/-/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
                return {
                  id: game.id,
                  name: formattedName,
                  author: game.developer_name || "DuckMath",
                  coverUrl: `/!!/${game.icon}`,
                  gameUrl: game.link,
                  isExternal: false,
                  featured: game.is_featured || false
                };
              })
              .sort((a, b) => a.name.localeCompare(b.name));

            gameDataLoaded = true;
            updateGamePlaceholder();
            try {
              sessionStorage.setItem(cacheKey, JSON.stringify(allGames));
            } catch (e) {}
            return allGames;
          })
          .catch(err => {
            console.error('Failed to load DuckMath games:', err);
            gameDataPromise = null;
            throw err;
          });

      } else {
        gameDataPromise = fetch(GN_ZONES_URL)
          .then(res => {
            if (!res.ok) throw new Error(`GN-Math fetch failed: ${res.statusText}`);
            return res.json();
          })
          .then(data => {
            allGames = data
              .map(zone => {
                const isExternal = zone.url.startsWith('http');
                return {
                  id: zone.id,
                  name: zone.name,
                  author: zone.author,
                  description: `By ${zone.author || 'Unknown'}`,
                  coverUrl: zone.cover.replace("{COVER_URL}", GN_COVER_URL),
                  gameUrl: isExternal ? zone.url : zone.url.replace("{HTML_URL}", GN_HTML_URL),
                  isExternal: isExternal,
                  featured: zone.featured || false
                };
              })
              .filter(game => !game.name.startsWith('[!]') && !game.name.startsWith('Chat Bot'))
              .sort((a, b) => {
                if (a.featured && !b.featured) return -1;
                if (!a.featured && b.featured) return 1;
                return a.name.localeCompare(b.name);
              });

            gameDataLoaded = true;
            updateGamePlaceholder();
            try {
              sessionStorage.setItem(cacheKey, JSON.stringify(allGames));
            } catch (e) {}
            return allGames;
          })
          .catch(err => {
            console.error('Failed to load GN-Math games:', err);
            gameDataPromise = null;
            throw err;
          });
      }
    }
    return gameDataPromise;
  }

  document.addEventListener('gameSourceUpdated', () => {
    gameDataLoaded = false;
    gameDataPromise = null;
    allGames = [];
    gameRendered = false;
    gameGrid.innerHTML = '';

    const noResultsEl = gameMenu.querySelector('.no-results-message');
    if (noResultsEl) {
      noResultsEl.textContent = 'Fetching new game source...';
      noResultsEl.style.display = 'block';
    }
    gameGridContainer.style.display = 'none';

    getGameData().then(() => {
      if (gameMenu.classList.contains('open')) {
        renderGame();
        filterAndDisplayGame();
      }
    });
  });

  function showGameMenu() {
    if (isMenuTransitioning || gameMenu.classList.contains('open')) return;

    const gameArrow = document.getElementById('arrow-pointer');
    if (gameArrow) {
      gameArrow.classList.remove('show');
    }
    localStorage.setItem('wavesUserOpenedGameMenu', 'true');

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

    isMenuTransitioning = true;

    if (shortcutPromptOverlay) {
      shortcutPromptOverlay.classList.remove('fade-out');
      shortcutPromptOverlay.classList.add('show');
    }

    gameMenu.style.display = 'flex';
    gameMenu.classList.add('open');
    gameMenuContent.classList.remove('close');
    gameMenuContent.classList.add('open');

    gameMenuContent.addEventListener('animationend', function onShowAnimationEnd(e) {
      if (e.animationName === 'fadeIn') {
        isMenuTransitioning = false;
        gameMenuContent.removeEventListener('animationend', onShowAnimationEnd);
      }
    });

    if (gameSearchInput) {
      gameSearchInput.value = '';
      gameSearchInput.focus();
    }

    const noResultsEl = gameMenu.querySelector('.no-results-message');

    if (gameDataLoaded) {
      updateGamePlaceholder();
      renderGame();
      filterAndDisplayGame();
    } else {
      if (noResultsEl) {
        noResultsEl.textContent = 'Fetching games...';
        noResultsEl.style.display = 'block';
      }
      gameGridContainer.style.display = 'none';
      if (gameCredits) gameCredits.style.display = 'none';

      getGameData()
        .then(() => {
          renderGame();
          filterAndDisplayGame();
        })
        .catch(() => {
          if (noResultsEl) {
            noResultsEl.textContent = 'Error loading games. Please try again!';
            noResultsEl.style.display = 'block';
          }
        });
    }
  }

  function hideGameMenu(calledByOther) {
    if (isMenuTransitioning || !gameMenu.classList.contains('open')) return;
    isMenuTransitioning = true;

    gameMenuContent.classList.remove('open');
    gameMenuContent.classList.add('close');

    if (shortcutPromptOverlay && !calledByOther) {
      shortcutPromptOverlay.classList.remove('show');
    }

    gameMenuContent.addEventListener('animationend', function onHideAnimationEnd(e) {
      if (e.animationName === 'fadeOut') {
        gameMenu.classList.remove('open');
        gameMenuContent.classList.remove('close');
        gameMenuContent.removeEventListener('animationend', onHideAnimationEnd);
        gameMenu.style.display = 'none';
        isMenuTransitioning = false;
      }
    });
  }

  function updateGamePlaceholder() {
    if (!gameSearchInput) return;
    const count = allGames.length || 0;
    gameSearchInput.placeholder = `Search through ${count} games...`;
  }

  function createGameCard(game) {
    const card = document.createElement('div');
    card.className = 'game-card';
    card.dataset.gameUrl = game.gameUrl;
    card.dataset.isExternal = game.isExternal;
    card.dataset.gameName = game.name.toLowerCase();

    const imageContainer = document.createElement('div');
    imageContainer.className = 'game-image skeleton';

    const img = document.createElement('img');
    img.alt = `${game.name} Icon`;
    img.loading = 'lazy';
    img.src = game.coverUrl;

    img.onload = () => {
        imageContainer.classList.remove('skeleton');
    };

    img.onerror = () => {
        imageContainer.classList.remove('skeleton');
    };

    imageContainer.appendChild(img);
    card.appendChild(imageContainer);

    const info = document.createElement('div');
    info.className = 'game-info';

    const name = document.createElement('h2');
    name.textContent = game.name;
    info.appendChild(name);

    const description = document.createElement('p');
    description.className = 'game-description';
    description.textContent = game.description || '';
    info.appendChild(description);

    card.appendChild(info);

    return card;
  }

  function renderGame() {
    if (gameRendered || !gameDataLoaded) return;

    gameGrid.innerHTML = '';
    const fragment = document.createDocumentFragment();

    allGames.forEach(game => {
      fragment.appendChild(createGameCard(game));
    });

    gameGrid.appendChild(fragment);
    gameRendered = true;
  }

  function filterAndDisplayGame() {
    const gameMenuContent = gameMenu.querySelector('.game-menu-content');
    let noResultsEl = gameMenuContent.querySelector('.no-results-message');

    if (!noResultsEl) {
      noResultsEl = document.createElement('p');
      noResultsEl.className = 'no-results-message';
      noResultsEl.style.cssText = 'color: #b1b1b1; text-align: center;';
      gameMenuContent.appendChild(noResultsEl);
    }

    if (!gameDataLoaded) {
      noResultsEl.textContent = 'Fetching games...';
      noResultsEl.style.display = 'block';
      gameGridContainer.style.display = 'none';
      if (gameCredits) gameCredits.style.display = 'none';
      return;
    }

    const query = gameSearchInput.value.toLowerCase().trim();
    let resultsFound = 0;

    Array.from(gameGrid.children).forEach(card => {
      const gameName = card.dataset.gameName;
      const isMatch = !query || gameName.includes(query);

      card.style.display = isMatch ? 'flex' : 'none';
      if (isMatch) {
        resultsFound++;
      }
    });

    const hasContentToShow = resultsFound > 0;

    gameGridContainer.style.display = hasContentToShow ? 'grid' : 'none';
    if (gameCredits) gameCredits.style.display = hasContentToShow ? 'block' : 'none';

    if (!hasContentToShow) {
      noResultsEl.textContent = query ?
        'Zero games were found matching your search :(' :
        'Zero games were found matching your search :(';
      noResultsEl.style.display = 'block';
    } else {
      noResultsEl.style.display = 'none';
    }
  }

  if (gameSearchInput) gameSearchInput.addEventListener('input', filterAndDisplayGame);

  gameGrid.addEventListener('click', (e) => {
    const card = e.target.closest('.game-card');
    if (card && card.dataset.gameUrl) {
      const gameUrl = card.dataset.gameUrl;
      const isExternal = card.dataset.isExternal === 'true';

      if (isExternal) {
        window.open(gameUrl, '_blank');
      } else {
        if (window.WavesApp?.handleSearch) {
          window.WavesApp.handleSearch(gameUrl);
        }
      }
      hideGameMenu(false);
    }
  });

  if (gameIcon) {
    gameIcon.addEventListener('click', e => {
      e.preventDefault();
      showGameMenu();
    });
  }

  if (closeGameMenuBtn) {
    closeGameMenuBtn.addEventListener('click', () => hideGameMenu(false));
  }

  gameMenu.addEventListener('click', e => {
    if (e.target === gameMenu && gameMenu.classList.contains('open')) hideGameMenu(false);
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && gameMenu.classList.contains('open')) {
      if (document.activeElement === gameSearchInput && gameSearchInput.value) {
        gameSearchInput.value = '';
        filterAndDisplayGame();
      } else {
        hideGameMenu(false);
      }
    }
  }, true);

  window.showGameMenu = showGameMenu;
  window.hideGameMenu = hideGameMenu;
}