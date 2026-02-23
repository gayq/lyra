
import { showHomeView } from '../ui/ui.js';
import { attachSearchLight } from '../core/load.js';

export function initializeWatch() {
    const wrapper = document.querySelector('.wrapper');
    const mainContainer = document.querySelector('.main-container');
    const watchBtn = document.getElementById('watch-btn');
    const overlay = document.getElementById('overlay');

    if (!wrapper || !watchBtn) return;

    const iconEl = watchBtn.querySelector('i');
    const defaultIconClass = iconEl?.className || 'fa-solid fa-clapperboard';
    const homeIconClass = 'fa-solid fa-magnifying-glass';


    const API_BASE = '/!!/https://vidsrc-embed.ru';
    const EMBED_BASE = 'https://vidsrc-embed.ru';

    const DURATION = 60;
    const SKELETON_COUNT = 18;

    let watchPage = document.getElementById('watch-page');
    if (!watchPage) {
        watchPage = document.createElement('section');
        watchPage.id = 'watch-page';
        watchPage.className = 'watch-page';
        watchPage.setAttribute('aria-hidden', 'true');
        watchPage.innerHTML = `
      <div class="watch-topbar">
        <div class="watch-tabs">
          <div class="watch-tab-indicator"></div>
          <button class="watch-tab-btn active" data-tab="movies">movies</button>
          <button class="watch-tab-btn" data-tab="shows">shows</button>
        </div>
        <div class="search-bar watch-search-bar">
          <div class="light"></div>
          <div class="light-border"></div>
          <div class="light-inset-bg"></div>
          <i class="fa-regular fa-magnifying-glass watch-search-icon"></i>
          <input type="text" id="watchSearchInput" placeholder="fetching..." autocomplete="off">
        </div>
      </div>
      <div class="watch-grid-container">
        <div class="watch-grid"></div>
        <p class="watch-no-results">--</p>
        <button class="watch-fetch-more-btn" style="display:none;">fetch more</button>
      </div>
    `;

        if (mainContainer) {
            mainContainer.insertAdjacentElement('afterend', watchPage);
        } else {
            wrapper.prepend(watchPage);
        }
    }

    const watchGrid = watchPage.querySelector('.watch-grid');
    const watchSearchInput = watchPage.querySelector('#watchSearchInput');
    const noResultsEl = watchPage.querySelector('.watch-no-results');
    const fetchMoreBtn = watchPage.querySelector('.watch-fetch-more-btn');
    const watchSearchBar = watchPage.querySelector('.watch-search-bar');
    const tabBtns = watchPage.querySelectorAll('.watch-tab-btn');

    function updateTabIndicator() {
        const activeBtn = watchPage.querySelector('.watch-tab-btn.active');
        const indicator = watchPage.querySelector('.watch-tab-indicator');
        if (activeBtn && indicator && activeBtn.offsetWidth > 0) {
            indicator.style.width = `${activeBtn.offsetWidth}px`;
            indicator.style.transform = `translateX(${activeBtn.offsetLeft}px)`;
        }
    }

    const tabsContainer = watchPage.querySelector('.watch-tabs');
    if (tabsContainer) {
        const ro = new ResizeObserver(() => updateTabIndicator());
        ro.observe(tabsContainer);
    }

    attachSearchLight(watchSearchBar);

    const scrollTarget = wrapper || window;
    scrollTarget.addEventListener('scroll', () => {
        const currentScroll = wrapper ? wrapper.scrollTop : window.scrollY;
        if (currentScroll > 10) {
            watchSearchBar.classList.add('is-sticky');
        } else {
            watchSearchBar.classList.remove('is-sticky');
        }
    }, { passive: true });

    let currentTab = 'movies';
    let allItems = [];
    let dataLoaded = false;
    let dataPromise = null;
    let rendered = false;
    let fadeTimer = null;
    let currentPage = 1;
    let totalPages = 1;
    let _filterTimer = 0;
    let _lastFilterQuery = null;
    let savedScrollPosition = 0;
    let cardTemplate = null;

    const getCacheKey = () => `waves-watch-cache-${currentTab}-${currentPage}`;

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

    function updatePlaceholder() {
        if (!watchSearchInput) return;
        if (!dataLoaded) {
            watchSearchInput.placeholder = `fetching ${currentTab}`;
            return;
        }

        watchSearchInput.placeholder = `search ${currentTab}...
        `;
    }

    function setStatus(message) {
        if (noResultsEl) {
            noResultsEl.textContent = message;
            noResultsEl.style.display = 'block';
        }
        if (watchGrid) {
            watchGrid.style.display = 'none';
            watchGrid.innerHTML = '';
        }
    }

    function createSkeletonCard() {
        const card = document.createElement('article');
        card.className = 'watch-card skeleton-card';

        const media = document.createElement('div');
        media.className = 'watch-cover skeleton';
        card.appendChild(media);

        return card;
    }

    function showSkeletonLoading() {
        if (!watchGrid) return;
        if (watchGrid.children.length > 0 && !watchGrid.querySelector('.skeleton-card')) return;

        const fragment = document.createDocumentFragment();
        watchGrid.innerHTML = '';
        for (let i = 0; i < SKELETON_COUNT; i++) {
            fragment.appendChild(createSkeletonCard());
        }
        watchGrid.appendChild(fragment);
        watchGrid.style.display = 'grid';
        if (noResultsEl) noResultsEl.style.display = 'none';
    }

    function getCardTemplate() {
        if (cardTemplate) return cardTemplate;

        const card = document.createElement('article');
        card.className = 'watch-card';

        const media = document.createElement('div');
        media.className = 'watch-cover skeleton';

        const img = document.createElement('img');
        img.loading = 'lazy';
        img.decoding = 'async';
        media.appendChild(img);

        const info = document.createElement('div');
        info.className = 'watch-info';

        const title = document.createElement('h1');
        const quality = document.createElement('span');
        quality.className = 'watch-quality';
        info.appendChild(title);
        info.appendChild(quality);

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

    function createWatchCard(item) {
        const card = getCardTemplate().cloneNode(true);

        const embedUrl = item.embed_url_tmdb || item.embed_url || (currentTab === 'movies'
            ? `${EMBED_BASE}/embed/movie?tmdb=${item.tmdb_id || ''}&imdb=${item.imdb_id || ''}`
            : `${EMBED_BASE}/embed/tv?tmdb=${item.tmdb_id || ''}&imdb=${item.imdb_id || ''}`);

        card.dataset.embedUrl = embedUrl;
        card.dataset.itemName = item.title.toLowerCase();
        card.dataset.itemTitle = item.title;
        card.dataset.itemType = currentTab;

        let posterUrl = '';
        if (item.posterOverride) {
            posterUrl = `/!!/${item.posterOverride}`;
        } else if (item.imdb_id) {
            posterUrl = `/!!/https://images.metahub.space/poster/small/${item.imdb_id}/img`;
        }
        card.dataset.posterUrl = posterUrl;

        const media = card.firstChild;
        const info = card.lastChild;
        const img = media.firstChild;
        const title = info.querySelector('h1');
        const quality = info.querySelector('.watch-quality');

        if (posterUrl) {
            img.alt = item.title;
            img.src = posterUrl;
            img.onload = handleImageLoad;
            img.onerror = handleImageError;
        } else {
            media.classList.remove('skeleton');
            media.classList.add('no-cover');
        }

        title.textContent = item.title;
        if (item.quality) {
            quality.textContent = item.quality;
        } else {
            quality.style.display = 'none';
        }

        return card;
    }

    function renderCards(items) {
        if (!watchGrid) return;

        const fragment = document.createDocumentFragment();
        for (let i = 0; i < items.length; i++) {
            fragment.appendChild(createWatchCard(items[i]));
        }

        watchGrid.innerHTML = '';
        watchGrid.appendChild(fragment);
        watchGrid.style.display = items.length ? 'grid' : 'none';
    }

    function appendCards(items) {
        if (!watchGrid) return;
        const fragment = document.createDocumentFragment();
        for (let i = 0; i < items.length; i++) {
            fragment.appendChild(createWatchCard(items[i]));
        }
        watchGrid.appendChild(fragment);
        watchGrid.style.display = 'grid';
    }

    function renderAll() {
        if (rendered || !dataLoaded || !watchGrid) return;
        renderCards(allItems);
        rendered = true;
        _lastFilterQuery = null;
    }

    function filterAndDisplay() {
        if (!dataLoaded || !watchGrid) return;

        const query = (watchSearchInput?.value || '').trim();
        if (query === _lastFilterQuery) return;
        _lastFilterQuery = query;

        if (query) savedScrollPosition = 0;

        if (!query) {
            renderCards(allItems);
            if (noResultsEl) noResultsEl.style.display = 'none';
            fetchMoreBtn.style.display = currentPage < totalPages ? 'block' : 'none';
            return;
        }

        fetchMoreBtn.style.display = 'none';
        showSkeletonLoading();

        const TMDB_API_KEY = "0e33c92186263620ce8c7f6b8fb35b00";
        const activeType = currentTab === 'movies' ? 'movie' : 'tv';
        const tmdbUrl = `https://api.themoviedb.org/3/search/${activeType}?api_key=${TMDB_API_KEY}&query=${encodeURIComponent(query)}&page=1&include_adult=false&language=en-US`;

        fetch(`/!!/${tmdbUrl}`)
            .then(res => {
                if (!res.ok) throw new Error("Search failed");
                return res.json();
            })
            .then(data => {
                if (!data.results || data.results.length === 0) {
                    setStatus(`zero ${currentTab} match were found :(`);
                    return;
                }

                const mappedResults = data.results.map(item => ({
                    tmdb_id: item.id,
                    title: item.title || item.name,
                    quality: '',
                    embed_url_tmdb: `${EMBED_BASE}/embed/${activeType === 'movie' ? 'movie' : 'tv'}?tmdb=${item.id}`,
                    imdb_id: item.id
                }));

                mappedResults.forEach(item => {
                    const originalItem = data.results.find(res => res.id === item.tmdb_id);
                    if (originalItem && originalItem.poster_path) {
                        item.posterOverride = `https://image.tmdb.org/t/p/w342${originalItem.poster_path}`;
                    }
                });

                if (noResultsEl) noResultsEl.style.display = 'none';
                renderCards(mappedResults);
                if (wrapper) wrapper.scrollTop = 0;
            })
            .catch(err => {
                console.error("Search error:", err);
                setStatus(`error searching for "${query}"`);
            });
    }

    function debounce(func, wait) {
        let timeout;
        return function (...args) {
            const context = this;
            clearTimeout(timeout);
            timeout = setTimeout(() => func.apply(context, args), wait);
        };
    }

    function fetchData(page = 1) {
        const TMDB_API_KEY = "0e33c92186263620ce8c7f6b8fb35b00";
        const activeType = currentTab === 'movies' ? 'movie' : 'tv';
        const tmdbUrl = `https://api.themoviedb.org/3/discover/${activeType}?api_key=${TMDB_API_KEY}&language=en-US&sort_by=popularity.desc&page=${page}&include_adult=false`;

        updatePlaceholder();

        return fetch(`/!!/${tmdbUrl}`)
            .then(res => res.ok ? res.json() : Promise.reject(res.statusText))
            .then(data => {
                const results = data.results || [];
                totalPages = data.total_pages > 500 ? 500 : (data.total_pages || 1);

                const mappedResults = results.map(item => ({
                    tmdb_id: item.id,
                    title: item.title || item.name,
                    quality: '',
                    embed_url_tmdb: `${EMBED_BASE}/embed/${activeType === 'movie' ? 'movie' : 'tv'}?tmdb=${item.id}`,
                    imdb_id: item.id
                }));

                mappedResults.forEach(item => {
                    const originalItem = results.find(res => res.id === item.tmdb_id);
                    if (originalItem && originalItem.poster_path) {
                        item.posterOverride = `https://image.tmdb.org/t/p/w342${originalItem.poster_path}`;
                    }
                });

                if (page === 1) {
                    allItems = mappedResults;
                } else {
                    allItems = allItems.concat(mappedResults);
                }

                dataLoaded = true;
                currentPage = page;
                updatePlaceholder();
                return allItems;
            })
            .catch(err => {
                console.error(`failed to fetch ${currentTab}:`, err);
                dataLoaded = true;
                updatePlaceholder();
                throw err;
            });
    }

    function resetData() {
        dataLoaded = false;
        rendered = false;
        dataPromise = null;
        allItems = [];
        currentPage = 1;
        totalPages = 1;
        savedScrollPosition = 0;
        cardTemplate = null;
        _lastFilterQuery = null;
        if (watchGrid) watchGrid.innerHTML = '';
        if (noResultsEl) noResultsEl.style.display = 'none';
        if (fetchMoreBtn) fetchMoreBtn.style.display = 'none';
        if (watchSearchInput) watchSearchInput.value = '';
    }

    function showWatchPage() {
        if (fadeTimer) {
            clearTimeout(fadeTimer);
            fadeTimer = null;
        }

        if (document.body.classList.contains('games-view') && window.hideGameMenu) {
            window.hideGameMenu();
        }

        showHomeView();
        dismissOverlays();
        if (overlay) overlay.classList.remove('fade-out');
        document.body.classList.add('watch-view');
        watchPage.classList.add('is-visible');
        watchPage.classList.remove('is-active');

        const isAlreadyRendered = dataLoaded && watchGrid && watchGrid.children.length > 0;

        requestAnimationFrame(() => {
            watchPage.classList.add('is-active');
            if (wrapper) {
                wrapper.scrollTop = savedScrollPosition;
            } else {
                window.scrollTo(0, savedScrollPosition);
            }
        });

        watchPage.setAttribute('aria-hidden', 'false');
        setIconAsHome(true);

        if (isAlreadyRendered) {
            const images = watchGrid.querySelectorAll('img');
            for (let i = 0; i < images.length; i++) {
                const img = images[i];
                if (img.complete && img.naturalHeight === 0 && img.src) {
                    const src = img.src;
                    img.src = '';
                    img.src = src;
                    if (img.parentElement) {
                        img.parentElement.classList.remove('no-cover');
                        img.parentElement.classList.add('skeleton');
                    }
                }
            }
            return;
        }

        showSkeletonLoading();

        rendered = false;

        dataPromise = fetchData(1);
        dataPromise
            .then(() => {
                renderAll();
                filterAndDisplay();
                if (fetchMoreBtn) fetchMoreBtn.style.display = currentPage < totalPages ? 'block' : 'none';
            })
            .catch(() => setStatus(`failed to fetch ${currentTab} :(`));
    }

    function hideWatchPage() {
        if (!document.body.classList.contains('watch-view')) return;

        if (wrapper) {
            savedScrollPosition = wrapper.scrollTop;
        } else {
            savedScrollPosition = window.scrollY || document.documentElement.scrollTop;
        }

        if (fadeTimer) {
            clearTimeout(fadeTimer);
        }
        watchPage.classList.remove('is-active');
        fadeTimer = setTimeout(() => {
            watchPage.classList.remove('is-visible');
            document.body.classList.remove('watch-view');
            watchPage.setAttribute('aria-hidden', 'true');
            setIconAsHome(false);
            if (overlay) overlay.classList.remove('show');
            fadeTimer = null;
        }, DURATION);
    }

    function toggleWatchPage() {
        if (document.body.classList.contains('watch-view')) {
            hideWatchPage();
        } else {
            showWatchPage();
        }
    }

    tabBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            const tab = btn.dataset.tab;
            if (tab === currentTab) return;

            tabBtns.forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            updateTabIndicator();

            currentTab = tab;
            resetData();

            if (document.body.classList.contains('watch-view')) {
                showSkeletonLoading();
                dataPromise = fetchData(1);
                dataPromise
                    .then(() => {
                        renderAll();
                        filterAndDisplay();
                        fetchMoreBtn.style.display = currentPage < totalPages ? 'block' : 'none';
                    })
                    .catch(() => setStatus(`failed to fetch ${currentTab} :(`));
            }
        });
    });

    if (fetchMoreBtn) {
        fetchMoreBtn.addEventListener('click', () => {
            if (currentPage >= totalPages) return;
            fetchMoreBtn.textContent = 'fetching...';
            fetchMoreBtn.disabled = true;

            fetchData(currentPage + 1)
                .then(() => {
                    rendered = false;
                    renderAll();
                    filterAndDisplay();
                    fetchMoreBtn.textContent = 'fetch more';
                    fetchMoreBtn.disabled = false;
                    fetchMoreBtn.style.display = currentPage < totalPages ? 'block' : 'none';
                })
                .catch(() => {
                    fetchMoreBtn.textContent = 'fetch more';
                    fetchMoreBtn.disabled = false;
                });
        });
    }

    if (watchSearchInput) {
        const debouncedFilter = debounce(filterAndDisplay, 100);
        watchSearchInput.addEventListener('input', debouncedFilter);
    }

    if (watchGrid) {
        watchGrid.addEventListener('click', (e) => {
            const card = e.target.closest('.watch-card');
            if (card && card.dataset.embedUrl) {
                const embedUrl = card.dataset.embedUrl;
                if (window.WavesApp?.handleSearch) {
                    hideWatchPage();
                    const title = card.dataset.itemTitle || 'movie';
                    const posterIcon = card.dataset.posterUrl || '';
                    window.WavesApp.handleSearch(embedUrl, title, posterIcon);
                }
            }
        });
    }

    watchBtn.addEventListener('click', e => {
        e.preventDefault();
        toggleWatchPage();
    });

    const brand = document.getElementById('brand');
    const brandingContainer = document.getElementById('branding-container');
    const brandToggleTarget = brandingContainer || brand;
    if (brandToggleTarget) {
        brandToggleTarget.addEventListener('click', e => {
            if (document.body.classList.contains('watch-view')) {
                e.preventDefault();
                hideWatchPage();
            }
        });
    }

    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && document.body.classList.contains('watch-view')) {
            hideWatchPage();
        }
    }, true);

    window.showWatchMenu = showWatchPage;
    window.hideWatchMenu = hideWatchPage;
    window.toggleWatchMenu = toggleWatchPage;
}
