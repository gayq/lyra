document.addEventListener('DOMContentLoaded', function () {
    function openDB(dbName) {
        return new Promise((resolve, reject) => {
            if (!('indexedDB' in window)) {
                return reject(new Error('indexeddb is not supported in this browser.'));
            }
            const request = indexedDB.open(dbName);
            request.onerror = (event) => reject(`error opening db: ${event.target.error}`);
            request.onsuccess = (event) => resolve(event.target.result);
        });
    }

    async function _exportDB(dbName) {
        const db = await openDB(dbName);
        const exportData = {};
        const storeNames = Array.from(db.objectStoreNames);

        if (storeNames.length === 0) {
            db.close();
            return null;
        }

        const transaction = db.transaction(storeNames, 'readonly');
        await Promise.all(storeNames.map(storeName => {
            return new Promise((resolve, reject) => {
                const store = transaction.objectStore(storeName);
                const usesOutOfLineKeys = !store.keyPath && !store.autoIncrement;

                const valuesRequest = store.getAll();
                valuesRequest.onerror = (event) => {
                    console.error(`error reading values from store ${storeName}:`, event.target.error);
                    reject(event.target.error);
                };
                valuesRequest.onsuccess = (event) => {
                    const values = event.target.result;

                    if (usesOutOfLineKeys) {
                        const keysRequest = store.getAllKeys();
                        keysRequest.onerror = (event) => {
                            console.error(`error reading keys from store ${storeName}:`, event.target.error);
                            reject(event.target.error);
                        };
                        keysRequest.onsuccess = (keyEvent) => {
                            const keys = keyEvent.target.result;
                            exportData[storeName] = {
                                __isExportFormatV2: true,
                                usesOutOfLineKeys: true,
                                data: keys.map((key, i) => ({
                                    key: key,
                                    value: values[i]
                                }))
                            };
                            resolve();
                        };
                    } else {
                        exportData[storeName] = {
                            __isExportFormatV2: true,
                            usesOutOfLineKeys: false,
                            data: values
                        };
                        resolve();
                    }
                };
            });
        }));

        db.close();
        return exportData;
    }

    window.wavesExportAllData = async function () {
        const masterExport = {
            localStorage: Object.keys(localStorage).reduce((acc, key) => {
                if (key !== 'waves-sync-meta') {
                    acc[key] = localStorage.getItem(key);
                }
                return acc;
            }, {}),
            sessionStorage: {
                ...sessionStorage
            },
            cookies: document.cookie,
            indexedDB: {}
        };

        if ('indexedDB' in window && typeof indexedDB.databases === 'function') {
            const dbs = await indexedDB.databases();
            if (dbs && dbs.length > 0) {
                await Promise.all(dbs.map(async (dbInfo) => {
                    const dbName = dbInfo.name;
                    if (!dbName) return;
                    try {
                        const dbData = await _exportDB(dbName);
                        if (dbData) {
                            masterExport.indexedDB[dbName] = dbData;
                        }
                    } catch (err) {
                        console.error(`failed to export db: ${dbName}`, err);
                    }
                }));
            }
        } else {
            try {
                const dbData = await _exportDB('__op');
                if (dbData) {
                    masterExport.indexedDB['__op'] = dbData;
                }
            } catch (err) {
                console.error('failed to export default db: __op', err);
            }
        }
        return masterExport;
    };

    async function exportAllData(fileName) {
        try {
            const masterExport = await window.wavesExportAllData();

            const dataStr = JSON.stringify(masterExport, null, 2);
            const dataBlob = new Blob([dataStr], {
                type: 'application/json'
            });
            const url = URL.createObjectURL(dataBlob);

            const a = document.createElement('a');
            a.href = url;
            a.download = fileName;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);

        } catch (err) {
            console.error('error exporting all data:', err);
        }
    }

    window.wavesImportDataFromObject = async function (importedData, progressCallback = () => { }) {
        if (!importedData || !importedData.localStorage || !importedData.sessionStorage || !importedData.indexedDB) {
            return;
        }

        try {
            progressCallback("clearing local storage...");
            localStorage.clear();
            const totalKeys = Object.keys(importedData.localStorage).length;
            let currentKey = 0;

            for (const [key, value] of Object.entries(importedData.localStorage)) {
                try {
                    localStorage.setItem(key, value);
                } catch (e) {
                    console.warn(`failed to import localStorage key: ${key}`, e);
                }
                currentKey++;
                if (currentKey % 10 === 0) progressCallback(`importing settings (${Math.round((currentKey / totalKeys) * 100)}%)...`);
            }

            if (importedData.cookies) {
                progressCallback("importing cookies...");
                try {
                    const cookies = importedData.cookies.split(';');
                    cookies.forEach(cookie => {
                        const eqPos = cookie.indexOf('=');
                        if (eqPos > -1) {
                            const name = cookie.substring(0, eqPos).trim();
                            const value = cookie.substring(eqPos + 1).trim();
                            document.cookie = `${name}=${value}; path=/; max-age=31536000`;
                        }
                    });
                } catch (e) {
                    console.warn(`failed to import cookies`, e);
                }
            }

            const dbNames = Object.keys(importedData.indexedDB);
            if (dbNames.length > 0) {
                let dbIndex = 0;
                await Promise.all(dbNames.map(async (dbName) => {
                    dbIndex++;
                    progressCallback(`importing database... (${dbIndex}/${dbNames.length})`);

                    const dbData = importedData.indexedDB[dbName];
                    if (!dbData) return;
                    const storeNames = Object.keys(dbData);
                    if (storeNames.length === 0) return;

                    try {
                        const db = await openDB(dbName);
                        const dbStoreNames = Array.from(db.objectStoreNames);
                        const validStoreNames = storeNames.filter(name => {
                            if (!dbStoreNames.includes(name)) {
                                return false;
                            }
                            return true;
                        });

                        if (validStoreNames.length === 0) {
                            db.close();
                            return;
                        }

                        const transaction = db.transaction(validStoreNames, 'readwrite');

                        await Promise.all(validStoreNames.map(storeName => {
                            return new Promise((resolve, reject) => {
                                const store = transaction.objectStore(storeName);
                                store.clear().onsuccess = () => {
                                    const storeData = dbData[storeName];
                                    let records = [];
                                    let usesOutOfLineKeys = false;
                                    if (storeData && typeof storeData === 'object' && storeData.hasOwnProperty('__isExportFormatV2')) {
                                        records = storeData.data;
                                        usesOutOfLineKeys = storeData.usesOutOfLineKeys;
                                    } else {
                                        records = storeData;
                                    }

                                    if (!Array.isArray(records)) {
                                        resolve();
                                        return;
                                    }

                                    Promise.all(records.map(record => {
                                        return new Promise((resolveAdd) => {
                                            let addRequest;
                                            if (usesOutOfLineKeys) {
                                                if (record && typeof record === 'object' && record.hasOwnProperty('key') && record.hasOwnProperty('value')) {
                                                    addRequest = store.put(record.value, record.key);
                                                } else {
                                                    resolveAdd(); return;
                                                }
                                            } else {
                                                addRequest = store.put(record);
                                            }
                                            addRequest.onsuccess = resolveAdd;
                                            addRequest.onerror = resolveAdd;
                                        });
                                    })).then(resolve);
                                };
                            });
                        }));
                        db.close();

                    } catch (err) {
                        console.error(`failed to import data for db: ${dbName}`, err);
                    }
                }));
            }


        } catch (err) {
            console.error('error importing data:', err);
            progressCallback("import error!");
        }
    };

    function importAllData() {
        try {
            const input = document.createElement('input');
            input.type = 'file';
            input.accept = '.json,application/json';

            input.onchange = e => {
                const file = e.target.files[0];
                if (!file) return;

                const reader = new FileReader();
                reader.onload = async (event) => {
                    let importedData;
                    try {
                        importedData = JSON.parse(event.target.result);
                    } catch (err) {
                        console.error('error parsing data file:', err);
                        return;
                    }

                    if (!importedData || !importedData.localStorage || !importedData.sessionStorage || !importedData.indexedDB) {
                        return;
                    }

                    try {
                        localStorage.clear();
                        for (const [key, value] of Object.entries(importedData.localStorage)) {
                            try {
                                localStorage.setItem(key, value);
                            } catch (e) {
                                console.warn(`failed to import localStorage key: ${key}`, e);
                            }
                        }

                        sessionStorage.clear();
                        for (const [key, value] of Object.entries(importedData.sessionStorage)) {
                            try {
                                sessionStorage.setItem(key, value);
                            } catch (e) {
                                console.warn(`failed to import sessionStorage key: ${key}`, e);
                            }
                        }

                        const dbNames = Object.keys(importedData.indexedDB);
                        if (dbNames.length > 0) {
                            await Promise.all(dbNames.map(async (dbName) => {
                                const dbData = importedData.indexedDB[dbName];
                                if (!dbData) return;
                                const storeNames = Object.keys(dbData);
                                if (storeNames.length === 0) return;

                                try {
                                    const db = await openDB(dbName);
                                    const dbStoreNames = Array.from(db.objectStoreNames);

                                    const validStoreNames = storeNames.filter(name => {
                                        if (!dbStoreNames.includes(name)) {
                                            console.warn(`skipping unknown store: ${name} in db: ${dbName}`);
                                            return false;
                                        }
                                        return true;
                                    });

                                    if (validStoreNames.length === 0) {
                                        db.close();
                                        return;
                                    }

                                    const transaction = db.transaction(validStoreNames, 'readwrite');
                                    let importCount = 0;

                                    await Promise.all(validStoreNames.map(storeName => {
                                        return new Promise((resolve, reject) => {
                                            const store = transaction.objectStore(storeName);
                                            const clearRequest = store.clear();

                                            clearRequest.onerror = (event) => reject(`Failed to clear store ${storeName}: ${event.target.error}`);
                                            clearRequest.onsuccess = () => {
                                                const storeData = dbData[storeName];
                                                let records = [];
                                                let usesOutOfLineKeys = false;

                                                if (storeData && typeof storeData === 'object' && storeData.hasOwnProperty('__isExportFormatV2')) {
                                                    records = storeData.data;
                                                    usesOutOfLineKeys = storeData.usesOutOfLineKeys;
                                                } else {
                                                    records = storeData;
                                                    usesOutOfLineKeys = false;
                                                }

                                                if (!Array.isArray(records)) {
                                                    reject(`Data for store ${storeName} is not an array.`);
                                                    return;
                                                }

                                                Promise.all(records.map(record => {
                                                    return new Promise((resolveAdd) => {
                                                        let addRequest;
                                                        if (usesOutOfLineKeys) {
                                                            if (record && typeof record === 'object' && record.hasOwnProperty('key') && record.hasOwnProperty('value')) {
                                                                addRequest = store.put(record.value, record.key);
                                                            } else {
                                                                console.warn(`skipping malformed out-of-line record in ${storeName}`);
                                                                resolveAdd();
                                                                return;
                                                            }
                                                        } else {
                                                            addRequest = store.put(record);
                                                        }

                                                        addRequest.onsuccess = () => {
                                                            importCount++;
                                                            resolveAdd();
                                                        };
                                                        addRequest.onerror = (event) => {
                                                            const keyInfo = usesOutOfLineKeys ? (record ? record.key : 'unknown') : 'N/A';
                                                            console.warn(`failed to add record to ${storeName} (key: ${keyInfo}):`, event.target.error);
                                                            resolveAdd();
                                                        };
                                                    });
                                                })).then(resolve);
                                            };
                                        });
                                    }));

                                    transaction.oncomplete = () => {
                                        console.log(`imported ${importCount} records into ${dbName}.`);
                                    };

                                    db.close();

                                } catch (err) {
                                    console.error(`failed to import data for db: ${dbName}`, err);
                                }
                            }));
                        }

                    } catch (err) {
                        console.error('error importing data:', err);
                    }
                };
                reader.readAsText(file);
            };

            input.click();
        } catch (err) {
            console.error('error importing settings:', err);
        }
    }

    window.addEventListener('beforeunload', function (e) {
        if (window.bypassPreventClosing) return;
        const preventClosingEnabled = localStorage.getItem('preventClosing') !== 'false';
        if (preventClosingEnabled) {
            e.preventDefault();
            e.returnValue = '';
            return '';
        }
    });

    const originalTitle = document.title;
    const originalFavicon = document.querySelector("link[rel*='icon']") ? document.querySelector("link[rel*='icon']").href : 'logo.png';
    let titleObserver = null;

    const siteCloakingPresets = {
        'none': {
            title: 'waves!!',
            icon: '/assets/images/icons/favicon.ico'
        },
        'google': {
            title: 'Google',
            icon: 'https://www.google.com/favicon.ico'
        },
        'google classroom': {
            title: 'Home - Classroom',
            icon: 'https://www.gstatic.com/classroom/logo_square_rounded.svg'
        },
        'google docs': {
            title: 'Google Docs',
            icon: 'https://ssl.gstatic.com/docs/documents/images/kix-favicon-2023q4.ico'
        },
        'google drive': {
            title: 'Google Drive',
            icon: 'https://ssl.gstatic.com/images/branding/product/1x/drive_2020q4_32dp.png'
        },
        'youtube': {
            title: 'YouTube',
            icon: 'https://www.youtube.com/s/desktop/014dbbed/img/favicon_32x32.png'
        },
        'schoology': {
            title: 'Home | Schoology',
            icon: 'https://asset-cdn.schoology.com/sites/all/themes/schoology_theme/favicon.ico'
        },
        'wikipedia': {
            title: 'Wikipedia, the free encyclopedia',
            icon: 'https://en.wikipedia.org/static/favicon/wikipedia.ico'
        },
        'canva': {
            title: 'Home - Canva',
            icon: 'https://static.canva.com/domain-assets/canva/static/images/favicon-1.ico'
        }
    };

    let focusCloakingEnabled = localStorage.getItem('focusCloaking') !== 'false';
    let expectedTitle = originalTitle;
    let isUnloading = false;

    function applyExpectedTitleAndIcon(titleToSet, iconToSet) {
        expectedTitle = titleToSet;
        if (document.title !== titleToSet) {
            document.title = titleToSet;
        }

        let favicons = document.querySelectorAll("link[rel*='icon']");
        if (favicons.length === 0) {
            let favicon = document.createElement('link');
            favicon.rel = 'shortcut icon';
            favicon.href = iconToSet;
            document.head.appendChild(favicon);
        } else {
            favicons.forEach(el => {
                if (el.href !== iconToSet) {
                    el.href = iconToSet;
                }
            });
        }
    }

    function updateTitleAndIcon() {
        const titleTag = document.querySelector('title');
        let currentSiteCloakingName = localStorage.getItem('siteCloaking') || 'coursera';
        if (currentSiteCloakingName === 'default') {
            currentSiteCloakingName = 'coursera';
            localStorage.setItem('siteCloaking', 'coursera');
        }

        let titleToSet = originalTitle;
        let iconToSet = originalFavicon;
        
        let isTabActive = !isUnloading && !document.hidden && document.hasFocus();

        if (focusCloakingEnabled && isTabActive) {
            titleToSet = 'waves!!';
            iconToSet = '/assets/images/icons/favicon.ico';
        } else {
            const preset = siteCloakingPresets[currentSiteCloakingName];
            if (currentSiteCloakingName === 'coursera' || (!preset && currentSiteCloakingName !== 'none')) {
                titleToSet = originalTitle;
                iconToSet = originalFavicon;
            } else if (preset) {
                titleToSet = preset.title;
                iconToSet = preset.icon;
            }
        }

        applyExpectedTitleAndIcon(titleToSet, iconToSet);
    }

    const titleTag = document.querySelector('title');
    if (titleTag && !titleObserver) {
        titleObserver = new MutationObserver(function (mutations) {
            if (document.title !== expectedTitle) {
                document.title = expectedTitle;
            }
        });
        titleObserver.observe(titleTag, {
            childList: true,
            subtree: true,
            characterData: true
        });
    }

    function applyInitialSiteCloaking(siteCloakingName) {
        if (siteCloakingName) {
            localStorage.setItem('siteCloaking', siteCloakingName === 'default' ? 'coursera' : siteCloakingName);
        }
        updateTitleAndIcon();
    }

    window.addEventListener('focus', () => {
        setTimeout(updateTitleAndIcon, 10);
    });

    window.addEventListener('blur', () => {
        setTimeout(updateTitleAndIcon, 10);
    });

    document.addEventListener('visibilitychange', () => {
        if (document.hidden) {
            updateTitleAndIcon();
        } else {
            setTimeout(updateTitleAndIcon, 10);
        }
    });

    window.addEventListener('beforeunload', () => {
        isUnloading = true;
        updateTitleAndIcon();
    });

    function executeTabCloak(linkCloaking, siteCloakingName) {
        let inFrame;
        try {
            inFrame = window !== top;
        } catch (e) {
            inFrame = true;
        }

        if (linkCloaking.toLowerCase() === 'none' || inFrame) return;

        const preset = siteCloakingPresets[siteCloakingName];

        let title;
        let icon;

        if (siteCloakingName !== 'coursera' && preset) {
            title = preset.title;
            icon = preset.icon;
        } else {
            title = localStorage.getItem("siteTitle") || originalTitle;
            icon = localStorage.getItem("faviconURL") || originalFavicon;
        }

        let popup;

        if (linkCloaking === 'about:blank') {
            popup = window.open("", "_blank");
            if (!popup || popup.closed) {
                return;
            }
            const doc = popup.document;
            doc.title = title;

            const linkRel = doc.createElement('link');
            linkRel.rel = 'icon';
            linkRel.href = icon;
            doc.head.appendChild(linkRel);

            const iframe = doc.createElement('iframe');
            iframe.style.cssText = "height: 100%; width: 100%; border: none; position: fixed; top: 0; right: 0; left: 0; bottom: 0;";
            iframe.src = window.location.origin;
            doc.body.appendChild(iframe);

        } else if (linkCloaking === 'blob:') {
            const iframeSrc = window.location.origin;
            const safeTitle = title.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#039;');
            const safeIcon = icon.replace(/"/g, '&quot;');

            const html = `<html><head><title>${safeTitle}</title><link rel="icon" href="${safeIcon}"></head><body><iframe style="height: 100%; width: 100%; border: none; position: fixed; top: 0; right: 0; left: 0; bottom: 0;" src="${iframeSrc}"></iframe></body></html>`;
            const blob = new Blob([html], {
                type: 'text/html'
            });
            const blobUrl = URL.createObjectURL(blob);
            popup = window.open(blobUrl, "_blank");
            if (!popup || popup.closed) {
                return;
            }
        }

        window.bypassPreventClosing = true;
        window.location.replace("https://classroom.google.com/");
    }


    function runInitialCloak(linkCloakingValue) {
        let siteCloakingName = localStorage.getItem('siteCloaking') || 'coursera';
        if (siteCloakingName === 'default') siteCloakingName = 'coursera';
        executeTabCloak(linkCloakingValue, siteCloakingName);
    }

    let initialSiteCloaking = localStorage.getItem('siteCloaking') || 'coursera';
    if (initialSiteCloaking === 'default') {
        initialSiteCloaking = 'coursera';
        localStorage.setItem('siteCloaking', 'coursera');
    }
    const initialLinkCloaking = localStorage.getItem('linkCloaking') || 'none';

    applyInitialSiteCloaking(initialSiteCloaking);

    const savedTheme = localStorage.getItem('theme') || 'default';
    if (savedTheme && savedTheme !== 'default') {
        document.documentElement.setAttribute('data-theme', savedTheme);
    } else {
        document.documentElement.removeAttribute('data-theme');
    }

    window.addEventListener("load", () => runInitialCloak(initialLinkCloaking));

    let settingsInitialized = false;

    function initializeSettingsMenu() {
        if (settingsInitialized) return;

        if (!document.getElementById('settings-data-styles')) {
            const style = document.createElement('style');
            style.id = 'settings-data-styles';
            style.innerHTML = `
                .data-buttons-container {
                    display: flex;
                    gap: 10px;
                    margin-top: 10px;
                    flex-wrap: wrap;
                }
                .data-action-btn {
                    background-color: var(--bg-surface-7);
                    border: 2px solid var(--border-transparent);
                    color: var(--text-primary);
                    padding: 10px;
                    border-radius: 15px;
                    cursor: pointer;
                    display: flex; 
                    align-items: center;
                    gap: 12px; 
                    transition: all 0.1s ease;
                    width: 100%; 
                    max-width: 300px; 
                    margin-bottom: 15px; 
                    font-size: 16px; 
                }
                .data-action-btn:hover {
                    background-color: var(--bg-surface-active); 
                }
                .data-action-btn i {
                    font-size: 1em; 
                    width: 1.2em; 
                    text-align: center;
                }
            `;
            document.head.appendChild(style);
        }

        const settingsMenu = document.getElementById('settings-menu');
        const overlay = document.getElementById('overlay');

        if (localStorage.getItem('preventClosing') === null) {
            localStorage.setItem('preventClosing', 'true');
        }

        const appSettings = {
            backend: localStorage.getItem('backend') || 'scramjet',
            transport: localStorage.getItem('transport') || 'epoxy',
            linkCloaking: localStorage.getItem('linkCloaking') || 'none',
            siteCloaking: localStorage.getItem('siteCloaking') === 'default' ? 'coursera' : (localStorage.getItem('siteCloaking') || 'coursera'),
            searchEngine: localStorage.getItem('searchEngine') || 'duckduckgo',
            gameSource: localStorage.getItem('gameSource') || 'selenite',
            theme: localStorage.getItem('theme') || 'default',
            preventClosing: localStorage.getItem('preventClosing') !== 'false',
            fallEnabled: localStorage.getItem('fallEnabled') !== 'false',
            focusCloaking: localStorage.getItem('focusCloaking') !== 'false'
        };

        let isToggling = false;

        if (appSettings.linkCloaking.toLowerCase() === 'none') {
            appSettings.linkCloaking = 'none';
            localStorage.setItem('linkCloaking', 'none');
        }

        settingsMenu.innerHTML = `
            <h2>settings</h2>
            <div class="settings-container">
                <div class="settings-tabs">
                    <button class="tab-button active" id="preferences-tab">
                        <i class="fa-solid fa-sliders"></i> preferences
                    </button>
                    <button class="tab-button" id="appearance-tab">
                        <i class="fa-regular fa-palette"></i> appearance
                    </button>
                    <button class="tab-button" id="cloaking-tab">
                        <i class="fa-regular fa-ghost"></i> cloaking
                    </button>
                    <button class="tab-button" id="advanced-tab">
                        <i class="fa-regular fa-server"></i> advanced
                    </button>
                    <button class="tab-button" id="about-tab">
                        <i class="fa-regular fa-heart"></i> credits
                    </button>
                    <div class="settings-bottom">≽^•⩊•^≼</div>
                </div>
                <div class="settings-content-wrapper">
                    <div id="preferences-content" class="tab-content active">
                        <div class="settings-item">
                            <label>search engine</label>
                            <p>the engine that is used for your search queries.</p>
                            <div class="search-engine-selector">
                                <div class="search-engine-selected"></div>
                                <div class="search-engine-options"></div>
                            </div>
                        </div>
                        <div class="settings-item">
                            <label>game source</label>
                            <p>where all the games are fetched from.</p>
                            <div class="game-source-selector">
                                <div class="game-source-selected"></div>
                                <div class="game-source-options"></div>
                            </div>
                        </div>
                        <div class="settings-item">
                            <label>prevent closing</label>
                            <p>prevent the tab from being closed.</p>
                            <input type="checkbox" id="prevent-closing-toggle">
                        </div>
                    </div>
                    <div id="appearance-content" class="tab-content">
                        <div class="settings-item">
                            <label>theme</label>
                            <p>change the look and feel of waves.</p>
                            <div class="theme-selector">
                                <div class="theme-selected"></div>
                                <div class="theme-options"></div>
                            </div>
                        </div>
                        <div class="settings-item">
                            <label>falling things</label>
                            <p>toggle the falling things on top of the screen.</p>
                            <input type="checkbox" id="fall-toggle">
                        </div>
                    </div>
                    <div id="cloaking-content" class="tab-content">
                        <div class="settings-item">
                            <label>site cloaking</label>
                            <p>cloak the site title and favicon as a different site.</p>
                            <div class="site-cloaking-selector">
                                <div class="site-cloaking-selected"></div>
                                <div class="site-cloaking-options"></div>
                            </div>
                        </div>
                        <div class="settings-item">
                            <label>link cloaking</label>
                            <p>cloak the site link in the url bar.</p>
                            <div class="link-cloaking-selector">
                                <div class="link-cloaking-selected"></div>
                                <div class="link-cloaking-options"></div>
                            </div>
                        </div>
                        <div class="settings-item">
                            <label>focus cloaking</label>
                            <p>cloak the title and favicon when clicking off the tab.</p>
                            <input type="checkbox" id="focus-cloaking-toggle">
                        </div>
                    </div>
                    <div id="advanced-content" class="tab-content">
                        <div class="settings-item">
                            <label>backend</label>
                            <p>the engine responsible for loading all your sites.</p>
                            <div class="backend-selector">
                                <div class="backend-selected"></div>
                                <div class="backend-options"></div>
                            </div>
                        </div>
                        <div class="settings-item">
                            <label>transport</label>
                            <p>how all the information will be sent.</p>
                            <div class="transport-selector">
                                <div class="transport-selected"></div>
                                <div class="transport-options"></div>
                            </div>
                        </div>
                    </div>

                    <div id="about-content" class="tab-content">
                        <div class="settings-item">
                            <label>credits</label>
                             <p>selenite - game source</p>
                             <p>gn-math - game source</p>
                             <p>velara - game source</p>
                             <p>bog - ports for hollow knight, re:run, and touhou mother</p>
                            <p>titanium network - ultraviolet</p>
                            <p>mercury workshop - scramjet, epoxy, and libcurl</p>
                        </div>
                        <div class="settings-item">
                            <label>you have reached the end!</label>
                            <p>
                                thank you so much for using <a href="https://waves.lat/" target="_blank" class="hover-link">waves!!</a> 
                                if you have any suggestions or issues, please contact us at support@waves.lat
                            </p>
                        </div>
                    </div>
                </div>
            </div>
            <button id="close-settings-menu">
                <i class="fa-regular fa-times"></i>
            </button>
        `;

        const closeSettingsBtn = document.getElementById('close-settings-menu');
        const preventClosingToggle = document.getElementById('prevent-closing-toggle');
        const focusCloakingToggle = document.getElementById('focus-cloaking-toggle');
        const exportDataBtn = document.getElementById('export-data-btn');
        const importDataBtn = document.getElementById('import-data-btn');
        const backendSelector = document.querySelector('.backend-selector');
        const backendSelected = backendSelector.querySelector('.backend-selected');
        const backendOptions = backendSelector.querySelector('.backend-options');
        const transportSelector = document.querySelector('.transport-selector');
        const transportSelected = transportSelector.querySelector('.transport-selected');
        const transportOptions = transportSelector.querySelector('.transport-options');
        const searchEngineSelector = document.querySelector('.search-engine-selector');
        const searchEngineSelected = searchEngineSelector.querySelector('.search-engine-selected');
        const searchEngineOptions = searchEngineSelector.querySelector('.search-engine-options');
        const siteCloakingSelector = document.querySelector('.site-cloaking-selector');
        const siteCloakingSelected = siteCloakingSelector.querySelector('.site-cloaking-selected');
        const siteCloakingOptions = siteCloakingSelector.querySelector('.site-cloaking-options');
        const linkCloakingSelector = document.querySelector('.link-cloaking-selector');
        const linkCloakingSelected = linkCloakingSelector.querySelector('.link-cloaking-selected');
        const linkCloakingOptions = linkCloakingSelector.querySelector('.link-cloaking-options');
        const gameSourceSelector = document.querySelector('.game-source-selector');
        const gameSourceSelected = gameSourceSelector.querySelector('.game-source-selected');
        const gameSourceOptions = gameSourceSelector.querySelector('.game-source-options');
        const themeSelector = document.querySelector('.theme-selector');
        const themeSelected = themeSelector.querySelector('.theme-selected');
        const themeOptionsEl = themeSelector.querySelector('.theme-options');
        const allBackendOptions = ['ultraviolet', 'scramjet'];
        const allTransportOptions = ['epoxy', 'libcurl'];
        const allSearchEngineOptions = ['google', 'bing', 'duckduckgo', 'startpage', 'brave', 'mojeek', 'swisscows'];
        const allSiteCloakingOptions = ['coursera', 'none', 'google', 'google classroom', 'google docs', 'youtube', 'google drive', 'schoology', 'wikipedia', 'canva'];
        const allLinkCloakingOptions = ['none', 'about:blank', 'blob:'];
        const allGameSourceOptions = ['selenite', 'gn-math', 'velara'];
        const allThemeOptions = ['default', 'catppuccin', 'nord', 'rose pine', 'gruvbox', 'dracula', 'synthwave', 'tokyo night', 'everforest', 'kanagawa', 'solarized', 'sakura'];

        if (!allGameSourceOptions.includes(appSettings.gameSource)) {
            appSettings.gameSource = 'selenite';
            localStorage.setItem('gameSource', 'selenite');
        }

        window.toggleSettingsMenu = function () {
            if (isToggling) return;
            isToggling = true;
            const icon = document.querySelector('#settings i.settings');
            const isOpen = settingsMenu.classList.contains('open');

            if (isOpen) {
                settingsMenu.classList.add('close');
                if (icon) icon.classList.remove('active-icon');
                if (overlay) {
                    overlay.classList.remove('show');
                }
            } else {
                if (window.wavesUpdate && typeof window.wavesUpdate.hideSuccess === 'function' && document.getElementById('updateSuccess')?.style.display === 'block') {
                    window.wavesUpdate.hideSuccess(true);
                }
                if (window.SharePromoter && typeof window.SharePromoter.hideWarningPrompt === 'function' && document.getElementById('warningPrompt')?.style.display === 'block') {
                    window.SharePromoter.hideWarningPrompt(true);
                }
                if (window.hideBookmarkPrompt && document.getElementById('bookmark-prompt')?.style.display === 'block') {
                    window.hideBookmarkPrompt(true);
                }

                settingsMenu.classList.add('open');
                if (icon) icon.classList.add('active-icon');
                if (overlay) {
                    overlay.classList.add('show');
                }
            }

            if (isOpen) {
                settingsMenu.addEventListener('animationend', (e) => {
                    if (e.animationName !== 'fadeOut') return;
                    settingsMenu.classList.remove('open', 'close');
                    isToggling = false;
                }, {
                    once: true
                });
            } else {
                settingsMenu.addEventListener('animationend', (e) => {
                    if (e.animationName !== 'fadeIn') return;
                    settingsMenu.classList.remove('close');
                    isToggling = false;
                }, {
                    once: true
                });
            }
        }

        function runMenuCloak() {
            executeTabCloak(appSettings.linkCloaking, appSettings.siteCloaking);
        }

        function closeAllSelectors() {
            document.querySelectorAll('.backend-show, .transport-show, .search-engine-show, .site-cloaking-show, .link-cloaking-show, .game-source-show, .theme-show').forEach(el => el.classList.remove('backend-show', 'transport-show', 'search-engine-show', 'site-cloaking-show', 'link-cloaking-show', 'game-source-show', 'theme-show'));
            document.querySelectorAll('.backend-arrow-active, .transport-arrow-active, .search-engine-arrow-active, .site-cloaking-arrow-active, .link-cloaking-arrow-active, .game-source-arrow-active, .theme-arrow-active').forEach(el => el.classList.remove('backend-arrow-active', 'transport-arrow-active', 'search-engine-arrow-active', 'site-cloaking-arrow-active', 'link-cloaking-arrow-active', 'game-source-arrow-active', 'theme-arrow-active'));
        }

        function changeTab(targetId) {
            closeAllSelectors();

            document.querySelectorAll('.tab-button i').forEach(icon => {
                icon.classList.remove('fa-solid');
                icon.classList.add('fa-regular');
            });

            document.querySelectorAll('.tab-button.active').forEach(button => button.classList.remove('active'));
            const activeBtn = document.getElementById(targetId);
            activeBtn.classList.add('active');
            const activeIcon = activeBtn.querySelector('i');
            if (activeIcon) {
                activeIcon.classList.remove('fa-regular');
                activeIcon.classList.add('fa-solid');
            }

            const contentId = targetId.replace('-tab', '-content');
            document.querySelectorAll('.tab-content.active').forEach(content => content.classList.remove('active'));
            document.getElementById(contentId).classList.add('active');
        }

        function createSelector(selectorType, selectedEl, optionsEl, allOptions, currentVal, storageKey, eventName) {
            selectedEl.textContent = currentVal;

            selectedEl.addEventListener('click', e => {
                e.stopPropagation();
                const wasOpen = optionsEl.classList.contains(`${selectorType}-show`);
                closeAllSelectors();

                if (!wasOpen) {
                    optionsEl.innerHTML = '';
                    allOptions.forEach(optionText => {
                        if (optionText !== selectedEl.textContent) {
                            const div = document.createElement('div');
                            div.textContent = optionText;
                            div.addEventListener('click', function (e) {
                                e.stopPropagation();
                                const val = this.textContent;
                                const displayVal = (storageKey === 'backend' || storageKey === 'transport') ? val.toLowerCase() : val;

                                selectedEl.textContent = displayVal;

                                const storageVal = displayVal;

                                appSettings[storageKey] = storageVal;
                                localStorage.setItem(storageKey, storageVal);
                                window.showToast('success', 'settings saved!');
                                closeAllSelectors();

                                if (storageKey === 'theme') {
                                    if (storageVal === 'default') {
                                        document.documentElement.removeAttribute('data-theme');
                                    } else {
                                        document.documentElement.setAttribute('data-theme', storageVal);
                                    }
                                } else if (storageKey === 'gameSource') {
                                    document.dispatchEvent(new CustomEvent('gameSourceUpdated', {
                                        detail: storageVal
                                    }));
                                } else if (storageKey === 'backend') {
                                    document.dispatchEvent(new CustomEvent('backendUpdated', {
                                        detail: storageVal
                                    }));
                                    window.bypassPreventClosing = true;
                                    window.location.reload();
                                } else if (storageKey === 'transport') {
                                    document.dispatchEvent(new CustomEvent('newTransport', {
                                        detail: storageVal
                                    }));
                                } else if (storageKey === 'siteCloaking') {
                                    applyInitialSiteCloaking(storageVal);
                                } else if (eventName) {
                                    document.dispatchEvent(new CustomEvent(eventName, {
                                        detail: storageVal
                                    }));
                                }

                                if (storageKey === 'linkCloaking') {
                                    window.bypassPreventClosing = true;
                                    runMenuCloak();
                                }
                            });
                            optionsEl.appendChild(div);
                        }
                    });
                    optionsEl.classList.add(`${selectorType}-show`);
                    selectedEl.classList.add(`${selectorType}-arrow-active`);
                }
            });
        }

        preventClosingToggle.checked = appSettings.preventClosing;
        if (focusCloakingToggle) {
            focusCloakingToggle.checked = appSettings.focusCloaking;
        }

        const fallToggle = document.getElementById('fall-toggle');
        fallToggle.checked = appSettings.fallEnabled;

        createSelector('backend', backendSelected, backendOptions, allBackendOptions, appSettings.backend, 'backend');
        createSelector('transport', transportSelected, transportOptions, allTransportOptions, appSettings.transport, 'transport');
        createSelector('link-cloaking', linkCloakingSelected, linkCloakingOptions, allLinkCloakingOptions, appSettings.linkCloaking, 'linkCloaking');
        createSelector('search-engine', searchEngineSelected, searchEngineOptions, allSearchEngineOptions, appSettings.searchEngine, 'searchEngine');
        createSelector('site-cloaking', siteCloakingSelected, siteCloakingOptions, allSiteCloakingOptions, appSettings.siteCloaking, 'siteCloaking');
        createSelector('game-source', gameSourceSelected, gameSourceOptions, allGameSourceOptions, appSettings.gameSource, 'gameSource');
        createSelector('theme', themeSelected, themeOptionsEl, allThemeOptions, appSettings.theme, 'theme');

        closeSettingsBtn.addEventListener('click', window.toggleSettingsMenu);

        document.addEventListener('siteCloakingUpdated', (e) => applyInitialSiteCloaking(e.detail));

        if (exportDataBtn) {
            exportDataBtn.addEventListener('click', () => {
                const now = new Date();
                const year = now.getFullYear();
                const month = (now.getMonth() + 1).toString().padStart(2, '0');
                const day = now.getDate().toString().padStart(2, '0');
                const hours = now.getHours().toString().padStart(2, '0');
                const minutes = now.getMinutes().toString().padStart(2, '0');
                const seconds = now.getSeconds().toString().padStart(2, '0');
                const timestamp = `${year}-${month}-${day}_${hours}-${minutes}-${seconds}`;
                const fileName = `waves-data-${timestamp}.json`;
                exportAllData(fileName);
            });
        }

        if (importDataBtn) {
            importDataBtn.addEventListener('click', () => {
                importAllData();
            });
        }

        if (overlay) {
            overlay.addEventListener('click', (e) => {
                if (e.target === overlay && settingsMenu.classList.contains('open')) {
                    window.toggleSettingsMenu();
                }
            });
        }
        window.addEventListener('click', (e) => {
            if (!e.target.closest('.backend-selector, .transport-selector, .search-engine-selector, .site-cloaking-selector, .link-cloaking-selector, .game-source-selector, .theme-selector')) {
                closeAllSelectors();
            }
        });

        document.querySelectorAll('.tab-button').forEach(button => {
            button.addEventListener('click', () => changeTab(button.id));
        });

        preventClosingToggle.addEventListener('change', function () {
            appSettings.preventClosing = this.checked;
            localStorage.setItem('preventClosing', this.checked.toString());
            window.showToast('success', 'settings saved!');
        });

        fallToggle.addEventListener('change', function () {
            appSettings.fallEnabled = this.checked;
            localStorage.setItem('fallEnabled', this.checked.toString());
            const fallContainer = document.getElementById('fall-container');
            if (fallContainer) {
                fallContainer.style.display = this.checked ? '' : 'none';
            }
            window.showToast('success', 'settings saved!');
        });

        if (focusCloakingToggle) {
            focusCloakingToggle.addEventListener('change', function () {
                appSettings.focusCloaking = this.checked;
                localStorage.setItem('focusCloaking', this.checked.toString());
                focusCloakingEnabled = this.checked;
                updateTitleAndIcon();
                window.showToast('success', 'settings saved!');
            });
        }

        document.querySelectorAll('input[type="checkbox"]').forEach(toggle => {
            toggle.addEventListener('change', function () {
                this.classList.remove('animate-on', 'animate-off');
                void this.offsetWidth;
                this.classList.add(this.checked ? 'animate-on' : 'animate-off');
            });
        });

        document.addEventListener('keydown', (e) => {
            const settingsMenu = document.getElementById('settings-menu');
            if (e.key === 'Escape' && settingsMenu && settingsMenu.classList.contains('open') && !settingsMenu.classList.contains('close')) {
                window.toggleSettingsMenu();
            }
        });

        settingsInitialized = true;
    }

    window.initializeSettingsMenu = initializeSettingsMenu;

    (function updateServerInfo() {
        const applyText = (textStr) => {
            const stuffDiv = document.getElementById('stuff');
            if (stuffDiv) {
                stuffDiv.textContent = textStr;
            }
        };

        fetch('/api/stuff', {
            cache: 'no-store'
        })
            .then(res => res.ok ? res.json() : null)
            .then(data => {
                const location = data && data.location ? data.location : "unknown";
                applyText(`server: ${location.toLowerCase()}`);
            })
            .catch(() => applyText(`server: unknown`));
    })();

    document.addEventListener('click', e => {
        const settingsBtn = e.target.closest('#settings');
        if (settingsBtn) {
            e.preventDefault();
            initializeSettingsMenu();
            if (typeof window.toggleSettingsMenu === 'function') {
                window.toggleSettingsMenu();
            }
        }
    });
});