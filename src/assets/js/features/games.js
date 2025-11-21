document.addEventListener('DOMContentLoaded', () => {
    const gamesMenu = document.getElementById('games-menu');
    if (!gamesMenu) return;

    const ZONES_URL = "https://cdn.jsdelivr.net/gh/gn-math/assets@main/zones.json";
    const COVER_URL = "https://cdn.jsdelivr.net/gh/gn-math/covers@main";
    const HTML_URL = "https://cdn.jsdelivr.net/gh/gn-math/html@main";

    const gamesMenuContent = gamesMenu.querySelector('.games-menu-content');
    const closeGamesMenuBtn = document.getElementById('close-games-menu');
    const gamesSearchInput = document.getElementById('gamesSearchInput');
    const gamesGrid = gamesMenu.querySelector('.games-grid');
    const gamesGridContainer = gamesMenu.querySelector('.games-grid-container');
    const gamesLink = document.getElementById('games');
    const shortcutPromptOverlay = document.getElementById('overlay');
    const gamesCredits = gamesMenu.querySelector('.games-credits');

    const gamesArrow = document.getElementById('arrow-pointer');
    if (gamesArrow && localStorage.getItem('wavesUserOpenedGamesMenu') !== 'true') {
        gamesArrow.classList.add('show');
    }

    let allGames = [];
    let filteredGames = [];
    let isMenuTransitioning = false;

    let gamesDataLoaded = false;
    let gameDataPromise = null;
    let debounceTimer = null;

    function getGameData() {
        if (!gameDataPromise) {
            gameDataPromise = fetch(ZONES_URL)
                .then(res => {
                    if (!res.ok) {
                        throw new Error(`Network response was not ok: ${res.statusText}`);
                    }
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
                                coverUrl: zone.cover.replace("{COVER_URL}", COVER_URL),
                                gameUrl: isExternal ? zone.url : zone.url.replace("{HTML_URL}", HTML_URL),
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
                                        
                    gamesDataLoaded = true;
                    
                    updateGamesPlaceholder();

                    return allGames;
                })
                .catch(err => {
                    console.error('Failed to load game data:', err);
                    gameDataPromise = null;
                    throw err;
                });
        }
        return gameDataPromise;
    }

    function showGamesMenu() {
        if (isMenuTransitioning || gamesMenu.classList.contains('open')) return;

        const gamesArrow = document.getElementById('arrow-pointer');
        if (gamesArrow) {
            gamesArrow.classList.remove('show');
        }
        localStorage.setItem('wavesUserOpenedGamesMenu', 'true');

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
        
        gamesMenu.style.display = 'flex';
        gamesMenu.classList.add('open');
        gamesMenuContent.classList.remove('close');
        gamesMenuContent.classList.add('open');

        gamesMenuContent.addEventListener('animationend', function onShowAnimationEnd(e) {
            if (e.animationName === 'openMenu') {
                isMenuTransitioning = false;
                gamesMenuContent.removeEventListener('animationend', onShowAnimationEnd);
            }
        });

        if (gamesSearchInput) {
            gamesSearchInput.value = '';
            gamesSearchInput.focus();
        }

        gamesGrid.innerHTML = '';
        filteredGames = [];
        
        const noResultsEl = gamesMenu.querySelector('.no-results-message');

        if (gamesDataLoaded) {
            updateGamesPlaceholder();
            resetAndRenderGames();
        } else {
            if (noResultsEl) {
                noResultsEl.textContent = 'Fetching games..';
                noResultsEl.style.display = 'block';
            }
            gamesGridContainer.style.display = 'none';
            if (gamesCredits) gamesCredits.style.display = 'none';

            getGameData()
                .then(() => {
                    resetAndRenderGames();
                })
                .catch(() => {
                    if (noResultsEl) {
                        noResultsEl.textContent = 'Error loading games. Please try again!';
                        noResultsEl.style.display = 'block';
                    }
                });
        }
    }

    function hideGamesMenu(calledByOther) {
        if (isMenuTransitioning || !gamesMenu.classList.contains('open')) return;
        isMenuTransitioning = true;

        gamesMenuContent.classList.remove('open');
        gamesMenuContent.classList.add('close');
        
        if (shortcutPromptOverlay && !calledByOther) {
            const settingsMenu = document.getElementById('settings-menu');
            const sharePromptEl = document.getElementById('sharePrompt');
            const updateSuccess = document.getElementById('updateSuccess');
            const bookmarkPrompt = document.getElementById('bookmark-prompt');
            const shortcutPrompt = document.getElementById('shortcut-prompt');
        
            const isOtherModalOpen = (settingsMenu && settingsMenu.classList.contains('open')) ||
                                     (sharePromptEl && sharePromptEl.style.display === 'block' && !sharePromptEl.classList.contains('fade-out')) ||
                                     (updateSuccess && updateSuccess.style.display === 'block' && !updateSuccess.classList.contains('fade-out')) ||
                                     (bookmarkPrompt && bookmarkPrompt.style.display === 'block' && !bookmarkPrompt.classList.contains('fade-out-prompt')) ||
                                     (shortcutPrompt && shortcutPrompt.style.display === 'block');

            if (!isOtherModalOpen) {
                shortcutPromptOverlay.classList.remove('show');
            }
        }

        gamesMenuContent.addEventListener('animationend', function onHideAnimationEnd(e) {
            if (e.animationName === 'closeMenu') {
                gamesMenu.classList.remove('open');
                gamesMenuContent.classList.remove('close');
                gamesMenuContent.removeEventListener('animationend', onHideAnimationEnd);
                gamesMenu.style.display = 'none';
                isMenuTransitioning = false;
            }
        });
    }

    function debouncedRenderGames() {
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(resetAndRenderGames, 200);
    }

    function updateGamesPlaceholder() {
        if (!gamesSearchInput) return;

        const count = allGames.length || 0;
        gamesSearchInput.placeholder = `Search through ${count} games...`;
    }

    function createGameCard(game) {
        const card = document.createElement('div');
        card.className = 'game-card';
        card.dataset.gameUrl = game.gameUrl;
        card.dataset.isExternal = game.isExternal;

        const imageContainer = document.createElement('div');
        imageContainer.className = 'game-image';

        const img = document.createElement('img');
        img.alt = `${game.name} Icon`;
        img.src = game.coverUrl; 

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

    function resetAndRenderGames() {
        const gamesMenuContent = gamesMenu.querySelector('.games-menu-content');
        let noResultsEl = gamesMenuContent.querySelector('.no-results-message');
        
        if (!noResultsEl) {
            noResultsEl = document.createElement('p');
            noResultsEl.className = 'no-results-message';
            noResultsEl.style.cssText = 'color: #b1b1b1; text-align: center;';
            gamesMenuContent.appendChild(noResultsEl);
        }

        if (!gamesDataLoaded) {
             noResultsEl.textContent = 'Fetching games!';
             noResultsEl.style.display = 'block';
             gamesGridContainer.style.display = 'none';
             if (gamesCredits) gamesCredits.style.display = 'none';
             return;
        }
        
        noResultsEl.style.display = 'none';
        if (gamesCredits) gamesCredits.style.display = 'block';

        const query = gamesSearchInput.value.toLowerCase().trim();
        
        const gamesToSearch = allGames;
        filteredGames = query
            ? gamesToSearch.filter(g => (g.name || '').toLowerCase().includes(query))
            : gamesToSearch;

        gamesGrid.innerHTML = '';

        const hasContentToShow = filteredGames.length > 0;
        
        gamesGridContainer.style.display = hasContentToShow ? 'grid' : 'none';

        if (hasContentToShow) {
            const fragment = document.createDocumentFragment();
            filteredGames.forEach(game => {
                fragment.appendChild(createGameCard(game));
            });
            gamesGrid.appendChild(fragment);
        } else if (query) {
            noResultsEl.textContent = 'Zero games were found matching your search :(';
            noResultsEl.style.display = 'block';
            if (gamesCredits) gamesCredits.style.display = 'none';
        } else {
             noResultsEl.textContent = 'Zero games were found matching your search :(';
             noResultsEl.style.display = 'block';
             if (gamesCredits) gamesCredits.style.display = 'none';
        }
    }

    getGameData();

    if (gamesSearchInput) gamesSearchInput.addEventListener('input', debouncedRenderGames);

    gamesGrid.addEventListener('click', (e) => {
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
            hideGamesMenu(false);
        }
    });

    if (gamesLink) {
        gamesLink.addEventListener('click', e => {
            e.preventDefault();
            showGamesMenu();
        });
    }

    if (closeGamesMenuBtn) {
        closeGamesMenuBtn.addEventListener('click', () => hideGamesMenu(false));
    }

    gamesMenu.addEventListener('click', e => {
        if (e.target === gamesMenu && gamesMenu.classList.contains('open')) hideGamesMenu(false);
    });

    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && gamesMenu.classList.contains('open')) {
            if (document.activeElement === gamesSearchInput && gamesSearchInput.value) {
                gamesSearchInput.value = '';
                resetAndRenderGames();
            } else {
                hideGamesMenu(false);
            }
        }
    }, true);

    window.showGamesMenu = showGamesMenu;
    window.hideGamesMenu = hideGamesMenu;
});