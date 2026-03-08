export function initializeLayout() {
    const sidebar = document.createElement('nav');
    sidebar.className = 'sidebar';
    sidebar.innerHTML = `
        <div class="tabs-header">
            <span>tabs</span>
        </div>
        <button id="add-tab-btn"><i class="fa-regular fa-plus"></i> new tab</button>
        <div id="tabs-container" class="tabs-container"></div>
    `;
    document.body.insertBefore(sidebar, document.body.firstChild);

    const settingsMenu = document.createElement('div');
    settingsMenu.id = 'settings-menu';
    settingsMenu.className = 'settings-menu';
    document.body.appendChild(settingsMenu);

    const overlay = document.createElement('div');
    overlay.id = 'overlay';
    overlay.className = 'overlay';
    document.body.appendChild(overlay);

    const topLeftStuff = document.createElement('div');
    topLeftStuff.id = 'top-left-stuff';
    topLeftStuff.innerHTML = `
        <div id="branding-container" class="icon-btn">
            <span id="brand">waves!!</span>
            <div id="oneko"></div>
        </div>
        <a href="https://discord.gg/dJvdkPRheV" target="_blank" id="discord-btn" class="icon-btn">
            <i class="fa-brands fa-discord"></i>
        </a>
        <a href="#" id="choi" class="icon-btn">
            <i class="fa-solid fa-gamepad-modern"></i>
        </a>
    `;
    document.body.appendChild(topLeftStuff);

    const topRightStuff = document.createElement('div');
    topRightStuff.id = 'top-right-stuff';
    topRightStuff.innerHTML = `
        <div id="auth-container" class="text-icon-btn">
            <i class="fa-solid fa-cloud"></i>
            <span id="auth-status">cloud sync</span>
        </div>
        <a href="#" id="settings" class="icon-btn">
            <i class="settings fa-solid fa-gear"></i>
        </a>
    `;
    document.body.appendChild(topRightStuff);

    const user = JSON.parse(localStorage.getItem('auth_user') || '{}');
    if (user.username) {
        const statusEl = topRightStuff.querySelector('#auth-status');
        if (statusEl) statusEl.textContent = user.username;
    }

    const authContainer = topRightStuff.querySelector('#auth-container');
    if (authContainer) {
        authContainer.addEventListener('click', () => {
            document.dispatchEvent(new CustomEvent('toggleAuthModal'));
        });
    }

    const mainNav = document.createElement('div');
    mainNav.className = 'main-nav';
    mainNav.innerHTML = `
        <div class="nav-controls">
            <a id="toggle-sidebar-btn" href="#"><i class="fa-regular fa-table-rows"></i></a>
            <a id="backIcon" href="#"><i class="fa-regular fa-chevron-left"></i></a>
            <a id="forwardIcon" href="#"><i class="fa-regular fa-chevron-right"></i></a>
            <a id="refreshIcon" href="#"><i class="fa-regular fa-arrow-rotate-right"></i></a>
        </div>
        <div class="omnibox">
            <i id="lockIcon" class="fa-regular fa-unlock-keyhole"></i>
            <input type="text" id="searchInputt" placeholder="search or enter address" autocomplete="off">
        </div>
        <div class="window-controls">
            <a id="home-btn" href="/"><i class="fa-regular fa-house-chimney-window"></i></a>
            <a id="fullscreenBtn" href="#"><i class="fa-regular fa-expand"></i></a>
            <a id="splitViewBtn" href="#"><i class="fa-regular fa-table-columns"></i></a>
            <a id="erudaBtn" href="#"><i class="fa-regular fa-square-code"></i></a>
        </div>
    `;

    const mainContainer = document.createElement('div');
    mainContainer.className = 'main-container';
    mainContainer.innerHTML = `
        <div class="title">waves!!</div>
        <div class="search-bar">
            <div class="light-border"></div>
            <div class="light-inset-bg"></div>
            <div class="light"></div>
            <i class="fa-light fa-magnifying-glass search-icon"></i>
            <input type="text" id="searchInput" placeholder="have anything in mind?" autocomplete="off">
            <div id="suggestions-container" class="suggestions-box"></div>
        </div>
    `;

    const iframeContainer = document.createElement('div');
    iframeContainer.id = 'iframe-container';

    const resizeDivider = document.createElement('div');
    resizeDivider.id = 'iframe-resize-divider';
    iframeContainer.appendChild(resizeDivider);

    const footer = document.createElement('div');
    footer.className = 'footer';

    const stuff = document.createElement('div');
    stuff.id = 'stuff';
    stuff.innerHTML = `
        <a>--</a>
    `;

    footer.appendChild(stuff);

    const share = document.createElement('div');
    share.id = 'share';
    share.innerHTML = `
        <a>share the site with your friends!</a>
    `;

    footer.appendChild(share);

    const yay = document.querySelector('.yay');
    if (yay) {
        yay.prepend(mainNav);
        mainNav.after(mainContainer);
        mainContainer.after(iframeContainer);
        iframeContainer.after(footer);
    }

    const newTabModal = document.createElement('div');
    newTabModal.id = 'new-tab-modal';
    newTabModal.className = 'popup new-tab-popup';
    newTabModal.style.display = 'none';
    document.body.appendChild(newTabModal);

    const iconsPreloader = document.createElement('div');
    iconsPreloader.style.position = 'absolute';
    iconsPreloader.style.width = '0';
    iconsPreloader.style.height = '0';
    iconsPreloader.style.overflow = 'hidden';
    iconsPreloader.style.visibility = 'hidden';
    iconsPreloader.style.pointerEvents = 'none';
    iconsPreloader.ariaHidden = 'true';
    iconsPreloader.innerHTML = `
        <i class="fa-regular fa-table-rows"></i>
        <i class="fa-regular fa-chevron-left"></i>
        <i class="fa-regular fa-chevron-right"></i>
        <i class="fa-regular fa-arrow-rotate-right"></i>
        <i class="fa-regular fa-unlock-keyhole"></i>
        <i class="fa-regular fa-lock-keyhole"></i>
        <i class="fa-regular fa-house-chimney-window"></i>
        <i class="fa-regular fa-expand"></i>
        <i class="fa-regular fa-table-columns"></i>
        <i class="fa-regular fa-square-code"></i>
        <i class="fa-regular fa-magnifying-glass"></i>
        <i class="fa-regular fa-plus"></i>
        <i class="fa-solid fa-gear"></i>
        <i class="fa-solid fa-ghost"></i>
        <i class="fa-solid fa-server"></i>
        <i class="fa-solid fa-user"></i>
        <i class="fa-solid fa-heart"></i>
        <i class="fa-solid fa-file-export"></i>
        <i class="fa-solid fa-file-import"></i>
        <i class="fa-regular fa-times"></i>
        <i class="fa-solid fa-angle-down"></i>
        <i class="fa-regular fa-pencil"></i> `;
    document.body.appendChild(iconsPreloader);
}

export function initializeFall() {
    const CONTAINER_ID = 'fall-container';
    const IMAGE_SOURCES = [
        '/assets/images/peaks/chii.png',
        '/assets/images/peaks/pochi.png'
    ];
    const SPAWN_RATE = 300;
    const MAX_PARTICLES = 40;
    const fallEnabled = localStorage.getItem('fallEnabled') !== 'false';

    try {
        if (!document.getElementById('fall-styles')) {
            const style = document.createElement('style');
            style.id = 'fall-styles';
            style.innerHTML = `
                .falling {
                    position: fixed;
                    top: -8%; 
                    left: 50%; 
                    width: 50px;
                    height: auto;
                    pointer-events: none;
                    z-index: -1; 
                    will-change: transform, opacity;
                    opacity: 0;
                    animation-name: fallAndFade;
                    animation-timing-function: linear;
                    animation-fill-mode: forwards;
                }
                @keyframes fallAndFade {
                    0% {
                        opacity: 0.8; 
                        transform: translate(-50%, 0) rotate(0deg);
                    }
                    100% {
                        opacity: 0;
                        transform: translate(calc(-50% + var(--drift-x)), 110vh) rotate(var(--rot-end));
                    }
                }
            `;
            document.head.appendChild(style);
        }

        let container = document.getElementById(CONTAINER_ID);
        if (!container) {
            container = document.createElement('div');
            container.id = CONTAINER_ID;
            Object.assign(container.style, {
                position: 'fixed',
                top: '0',
                left: '0',
                width: '100%',
                height: '100%',
                pointerEvents: 'none',
                zIndex: '-1'
            });
            document.body.appendChild(container);
        }

        if (!fallEnabled) {
            container.style.display = 'none';
            return;
        }

        const imgPool = [];
        for (let i = 0; i < MAX_PARTICLES; i++) {
            const img = document.createElement('img');
            img.className = 'falling';
            img.style.display = 'none';
            img.addEventListener('animationend', () => {
                img.style.display = 'none';
                img.style.animationName = 'none';
            });
            container.appendChild(img);
            imgPool.push(img);
        }

        function spawnImage() {
            let img = null;
            for (let i = 0; i < imgPool.length; i++) {
                if (imgPool[i].style.display === 'none') {
                    img = imgPool[i];
                    break;
                }
            }

            if (!img) return;

            img.src = IMAGE_SOURCES[Math.floor(Math.random() * IMAGE_SOURCES.length)];

            const duration = Math.random() * 5 + 10;
            const spreadWidth = 800;
            const driftX = (Math.random() - 0.5) * spreadWidth;
            const rotationEnd = (Math.random() - 0.5) * 720;

            img.style.animationDuration = `${duration}s`;
            img.style.setProperty('--drift-x', `${driftX}px`);
            img.style.setProperty('--rot-end', `${rotationEnd}deg`);

            void img.offsetWidth;

            img.style.display = 'block';
            img.style.animationName = 'fallAndFade';
        }

        function startWhenReady() {
            const start = () => setInterval(spawnImage, SPAWN_RATE);
            if (document.readyState === 'complete') {
                start();
            } else {
                window.addEventListener('load', start);
            }
        }

        startWhenReady();

    } catch (e) {
        console.error("fall error:", e);
    }
}