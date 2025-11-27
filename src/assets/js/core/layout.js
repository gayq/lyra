export function initializeLayout() {
    const sidebar = document.createElement('nav');
    sidebar.className = 'sidebar';
    sidebar.innerHTML = `
        <div class="tabs-header">
            <span>Tabs</span>
        </div>
        <button id="add-tab-btn"><i class="fa-regular fa-plus"></i> New Tab</button>
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

    const leftIcons = document.createElement('div');
    leftIcons.id = 'left-icons';
    leftIcons.innerHTML = `
        <div id="branding-container" class="icon-btn">
            <span id="brand"></span>
            <div id="oneko"></div>
        </div>
        <a href="#" id="notifications" class="icon-btn">
            <i class="fa-solid fa-bell"></i>
        </a>
        <a href="#" id="choi" class="icon-btn">
            <i class="fa-solid fa-gamepad-modern"></i>
        </a>
        <div id="arrow-pointer" class="arrow">
            <svg class="arrow-svg" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 52 40" width="52" height="40">
                <path d="M2.5, 18.5 C10.5, 15.5 18.5, 12.5 26.5, 10.5 C34.5, 8.5 42.5, 7.5 50.5, 7.5" stroke="#FFF" stroke-width="2" fill="none" stroke-linecap="round"/>
                <path d="M45.5, 2.5 L50.5, 7.5 L45.5, 12.5" stroke="#FFF" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
            <span class="arrow-text"></span>
        </div>
    `;
    document.body.appendChild(leftIcons);

    const rightTopIcons = document.createElement('div');
    rightTopIcons.id = 'right-top-icons';
    rightTopIcons.innerHTML = `
        <a href="#" id="settings" class="icon-btn" title="Settings">
            <i class="settings fa-regular fa-gear"></i>
        </a>
    `;
    document.body.appendChild(rightTopIcons);

    const rightBottomIcons = document.createElement('div');
    rightBottomIcons.id = 'right-bottom-icons';
    rightBottomIcons.innerHTML = `
        <a href="https://discord.gg/dJvdkPRheV" target="_blank" id="discord" class="icon-btn">
            <i class="fa-brands fa-discord"></i>
            <span id="discord-text">Join the server!</span>
        </a>
    `;
    document.body.appendChild(rightBottomIcons);

    const mainNav = document.createElement('div');
    mainNav.className = 'main-nav';
    mainNav.innerHTML = `
        <div class="nav-controls">
            <a id="toggle-sidebar-btn" href="#"><i class="fa-regular fa-table-rows"></i></a>
            <a id="backIcon" href="#"><i class="fa-regular fa-chevron-left"></i></a>
            <a id="forwardIcon" href="#"><i class="fa-regular fa-chevron-right"></i></a>
            <a id="refreshIcon" href="#"><i class="fa-regular fa-rotate-right"></i></a>
        </div>
        <div class="omnibox">
            <i id="lockIcon" class="fa-regular fa-unlock-keyhole"></i>
            <input type="text" id="searchInputt" placeholder="Search or enter address" autocomplete="off">
            <div id="suggestions-container-nav" class="suggestions-box"></div>
        </div>
        <div class="window-controls">
            <a href="/"><i class="fa-regular fa-house-chimney-window"></i></a>
            <a id="fullscreenBtn" href="#"><i class="fa-regular fa-expand"></i></a>
            <a id="splitViewBtn" href="#"><i class="fa-regular fa-table-columns"></i></a>
            <a id="erudaBtn" href="#"><i class="fa-regular fa-square-code"></i></a>
        </div>
    `;

    const mainContainer = document.createElement('div');
    mainContainer.className = 'main-container';
    mainContainer.innerHTML = `
        <div class="phrases"></div>
        <div class="search-bar">
            <div class="light-border"></div>
            <div class="light-inset-bg"></div>
            <div class="light"></div>
            <i style="position: absolute; z-index: 4; top: 50%; margin-left: -8px; transform: translateY(-50%); font-size: 18px; color: #ffffff1f; pointer-events: none;" class="fa-regular fa-magnifying-glass"></i>
            <input type="text" id="searchInput" placeholder="Have anything in mind?" autocomplete="off">
            <div id="suggestions-container" class="suggestions-box"></div>
        </div>
    `;

    const iframeContainer = document.createElement('div');
    iframeContainer.id = 'iframe-container';
    
    const resizeDivider = document.createElement('div');
    resizeDivider.id = 'iframe-resize-divider';
    iframeContainer.appendChild(resizeDivider);

    const disclaimer = document.createElement('div');
    disclaimer.id = 'disclaimer';
    disclaimer.innerHTML = `
        <a><strong>Disclaimer</strong>: This website doesn't host any files. Any legal issues should be taken up with the 3rd party provider(s).</a>
    `;

    const wrapper = document.querySelector('.wrapper');
    if (wrapper) {
        wrapper.prepend(mainNav); 
        mainNav.after(mainContainer);
        mainContainer.after(iframeContainer);
        iframeContainer.after(disclaimer);
    }

    const newTabModal = document.createElement('div');
    newTabModal.id = 'new-tab-modal';
    newTabModal.className = 'popup new-tab-popup';
    newTabModal.style.display = 'none';
    document.body.appendChild(newTabModal);
    
    const erudaLoadingScreen = document.createElement('div');
    erudaLoadingScreen.id = 'erudaLoadingScreen';
    erudaLoadingScreen.style.display = 'none';
    erudaLoadingScreen.textContent = 'Eruda is loading...';
    document.body.appendChild(erudaLoadingScreen);

    const encodedBrand = "V2F2ZXMh";
    const encodedArrow = "R2FtZXMgaGVyZQ==";
    
    const brandEl = document.getElementById("brand");
    if (brandEl) brandEl.textContent = atob(encodedBrand);
    
    const arrowEl = document.querySelector(".arrow-text");
    if (arrowEl) arrowEl.textContent = atob(encodedArrow);

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
        <i class="fa-regular fa-rotate-right"></i>
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