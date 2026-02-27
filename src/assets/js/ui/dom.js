const _cache = {};

function _get(id) {
    return _cache[id] || (_cache[id] = document.getElementById(id));
}
function _q(sel) {
    return document.querySelector(sel);
}

export const dom = {
    splitSelectionOverlay: null,
    pageInitializingOverlay: null,
    notificationsMenu: null,
    notificationsList: null,
    notificationsStatus: null,

    get iframeContainer() { return _get('iframe-container'); },
    get iframeResizeDivider() { return _get('iframe-resize-divider'); },
    get newTabModal() { return _get('new-tab-modal'); },
    get newTabInput() { return _get('newTabInput'); },
    get searchInputMain() { return _get('searchInput'); },
    get topBar() { return _q('.topbar'); },
    get refreshBtn() { return _get('refreshIcon'); },
    get refreshBtnIcon() { return _q('#refreshIcon > i'); },
    get fullscreenBtn() { return _get('fullscreenBtn'); },
    get homeBtn() { return _get('home-btn'); },
    get backBtn() { return _get('backIcon'); },
    get forwardBtn() { return _get('forwardIcon'); },
    get searchInputNav() { return _get('searchInputt'); },
    get lockIcon() { return _get('lockIcon'); },
    get navbarToggle() { return _get('toggle-sidebar-btn'); },
    get navBar() { return _q('.main-nav'); },
    get bookmarksList() { return _get('bookmarks-list'); },
    get addBookmarkBtn() { return _get('add-bookmark-btn'); },
    get bookmarkPrompt() { return _get('bookmark-prompt'); },
    get bookmarkPromptOverlay() { return _get('overlay'); },
    get saveBookmarkBtn() { return _get('saveBookmarkBtn'); },
    get cancelBookmarkBtn() { return _get('cancelBookmarkBtn'); },
    get bookmarkNameInput() { return _get('bookmarkName'); },
    get bookmarkUrlInput() { return _get('bookmarkUrl'); },
    get addBookmarkLi() { return _q('.bookmark-item-add'); },
    get tabsContainer() { return _get('tabs-container'); },
    get addTabBtn() { return _get('add-tab-btn'); },
    get splitViewBtn() { return _get('splitViewBtn'); },
    get notificationsBtn() { return _get('notifications'); },
    get notificationsIcon() { return _q('#notifications > i'); },
    get memoryUsageValue() { return _get('memory-usage-value'); },
    get markAllReadBtn() { return _get('mark-all-read-btn'); },

    init() {
        this.splitSelectionOverlay = _get('split-selection-overlay');
        this.pageInitializingOverlay = _get('page-initializing-overlay');
        this.notificationsMenu = _get('notifications-menu');
        this.notificationsList = _q('.notifications-list');
        this.notificationsStatus = _get('notifications-status');
    }
};
