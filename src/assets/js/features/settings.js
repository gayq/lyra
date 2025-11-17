document.addEventListener('DOMContentLoaded', function() {
    
    const settingsIcon = document.getElementById('settings');
    if (!settingsIcon) return;

    function openDB(dbName) {
        return new Promise((resolve, reject) => {
            if (!('indexedDB' in window)) {
                return reject(new Error('IndexedDB is not supported in this browser.'));
            }
            const request = indexedDB.open(dbName);
            request.onerror = (event) => reject(`Error opening DB: ${event.target.error}`);
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
                    console.error(`Error reading values from store ${storeName}:`, event.target.error);
                    reject(event.target.error);
                };
                valuesRequest.onsuccess = (event) => {
                    const values = event.target.result;

                    if (usesOutOfLineKeys) {
                        const keysRequest = store.getAllKeys();
                        keysRequest.onerror = (event) => {
                             console.error(`Error reading keys from store ${storeName}:`, event.target.error);
                             reject(event.target.error);
                        };
                        keysRequest.onsuccess = (keyEvent) => {
                            const keys = keyEvent.target.result;
                            exportData[storeName] = {
                                __isExportFormatV2: true,
                                usesOutOfLineKeys: true,
                                data: keys.map((key, i) => ({ key: key, value: values[i] }))
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

    async function exportAllData(fileName) {
        try {
            const masterExport = {
                localStorage: { ...localStorage },
                sessionStorage: { ...sessionStorage },
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
                            console.error(`Failed to export DB: ${dbName}`, err);
                        }
                    }));
                }
            } else {
                console.warn('indexedDB.databases() is not supported, exporting only __op.');
                try {
                     const dbData = await _exportDB('__op');
                     if (dbData) {
                         masterExport.indexedDB['__op'] = dbData;
                     }
                } catch (err) {
                     console.error('Failed to export default DB: __op', err);
                }
            }
            
            const dataStr = JSON.stringify(masterExport, null, 2);
            const dataBlob = new Blob([dataStr], { type: 'application/json' });
            const url = URL.createObjectURL(dataBlob);
            
            const a = document.createElement('a');
            a.href = url;
            a.download = fileName;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
            
            if (typeof showToast === 'function') {
                showToast('success', 'All data exported!', 'check-circle');
            }

        } catch (err) {
            console.error('Error exporting all data:', err);
            if (typeof showToast === 'function') {
                showToast('error', `Export failed: ${err.message}`, 'times-circle');
            }
        }
    }

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
                        console.error('Error parsing data file:', err);
                        if (typeof showToast === 'function') {
                            showToast('error', 'Invalid data file.', 'times-circle');
                        }
                        return;
                    }

                    if (!importedData || !importedData.localStorage || !importedData.sessionStorage || !importedData.indexedDB) {
                        if (typeof showToast === 'function') {
                            showToast('error', 'File is not a valid data export.', 'times-circle');
                        }
                        return;
                    }

                    try {
                        localStorage.clear();
                        for (const [key, value] of Object.entries(importedData.localStorage)) {
                            try {
                                localStorage.setItem(key, value);
                            } catch (e) {
                                console.warn(`Failed to import localStorage key: ${key}`, e);
                            }
                        }

                        sessionStorage.clear();
                        for (const [key, value] of Object.entries(importedData.sessionStorage)) {
                             try {
                                sessionStorage.setItem(key, value);
                            } catch (e) {
                                console.warn(`Failed to import sessionStorage key: ${key}`, e);
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
                                            console.warn(`Skipping unknown store: ${name} in DB: ${dbName}`);
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

                                    transaction.onerror = (event) => {
                                        if (typeof showToast === 'function') {
                                            showToast('error', `Import transaction error: ${event.target.error}`, 'times-circle');
                                        }
                                    };
                                    
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
                                                                console.warn(`Skipping malformed out-of-line record in ${storeName}`);
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
                                                            console.warn(`Failed to add record to ${storeName} (key: ${keyInfo}):`, event.target.error);
                                                            resolveAdd(); 
                                                        };
                                                    });
                                                })).then(resolve);
                                            };
                                        });
                                    }));
                                    
                                    transaction.oncomplete = () => {
                                        console.log(`Imported ${importCount} records into ${dbName}.`);
                                    };

                                    db.close();

                                } catch (err) {
                                    console.error(`Failed to import data for DB: ${dbName}`, err);
                                    if (typeof showToast === 'function') {
                                        showToast('error', `Import failed for ${dbName}: ${err.message}`, 'times-circle');
                                    }
                                }
                            }));
                        }

                        if (typeof showToast === 'function') {
                            showToast('success', 'Data imported successfully! Reloading...', 'check-circle');
                        }
                        setTimeout(() => window.location.reload(), 1500);

                    } catch (err) {
                        console.error('Error importing data:', err);
                        if (typeof showToast === 'function') {
                            showToast('error', `Import failed: ${err.message}`, 'times-circle');
                        }
                    }
                };
                reader.readAsText(file);
            };
            
            input.click();
        } catch (err) {
            console.error('Error importing settings:', err);
            if (typeof showToast === 'function') {
                showToast('error', 'Failed to open file picker.', 'times-circle');
            }
        }
    }

    window.addEventListener('beforeunload', function (e) {
        const preventClosingEnabled = localStorage.getItem('preventClosing') === 'true';
        if (preventClosingEnabled) {
            e.preventDefault();
            e.returnValue = '';
            return '';
        }
    });

    const originalTitle = document.title;
    const originalFavicon = document.querySelector("link[rel*='icon']") ? document.querySelector("link[rel*='icon']").href : 'logo.png';

    const decoyPresets = {
        'Google': {
            title: 'Google',
            icon: 'https://www.google.com/favicon.ico'
        },
        'Google Docs': {
            title: 'Google Docs',
            icon: 'https://ssl.gstatic.com/docs/documents/images/kix-favicon-2023q4.ico'
        },
        'Youtube': {
            title: 'YouTube',
            icon: 'https://www.youtube.com/s/desktop/014dbbed/img/favicon_32x32.png'
        },
        'Google Drive': {
            title: 'Google Drive',
            icon: 'https://ssl.gstatic.com/images/branding/product/1x/drive_2020q4_32dp.png'
        },
        'Schoology': {
            title: 'Home | Schoology',
            icon: 'https://asset-cdn.schoology.com/sites/all/themes/schoology_theme/favicon.ico'
        }
    };

    function applyInitialDecoy(decoyName) {
        const preset = decoyPresets[decoyName];
        let favicon = document.querySelector("link[rel*='icon']");

        if (!favicon) {
            favicon = document.createElement('link');
            favicon.rel = 'shortcut icon';
            document.head.appendChild(favicon);
        }

        if (decoyName === 'None' || !preset) {
            document.title = originalTitle;
            favicon.href = originalFavicon;
        } else {
            document.title = preset.title;
            favicon.href = preset.icon;
        }
    }

    function executeTabCloak(cloakLink, decoyName) {
        let inFrame;
        try {
            inFrame = window !== top;
        } catch (e) {
            inFrame = true;
        }

        if (cloakLink.toLowerCase() === 'none' || inFrame) return;

        const preset = decoyPresets[decoyName];
        
        let title;
        let icon;

        if (decoyName !== 'None' && preset) {
            title = preset.title;
            icon = preset.icon;
        } else {
            title = localStorage.getItem("siteTitle") || "Google";
            icon = localStorage.getItem("faviconURL") || "https://www.google.com/favicon.ico";
        }

        let popup;

        if (cloakLink === 'about:blank') {
            popup = window.open("", "_blank");
            if (!popup || popup.closed) {
                if (typeof showToast === 'function') {
                    showToast('error', 'Please allow popups and refresh the page!', 'times-circle');
                }
                return;
            }
            popup.document.head.innerHTML = `<title>${title}</title><link rel="icon" href="${icon}">`;
            popup.document.body.innerHTML = `<iframe style="height: 100%; width: 100%; border: none; position: fixed; top: 0; right: 0; left: 0; bottom: 0;" src="${window.location.origin}"></iframe>`;
        
        } else if (cloakLink === 'blob:') {
            const iframeSrc = window.location.origin;
            const html = `<html><head><title>${title}</title><link rel="icon" href="${icon}"></head><body><iframe style="height: 100%; width: 100%; border: none; position: fixed; top: 0; right: 0; left: 0; bottom: 0;" src="${iframeSrc}"></iframe></body></html>`;
            const blob = new Blob([html], {
                type: 'text/html'
            });
            const blobUrl = URL.createObjectURL(blob);
            popup = window.open(blobUrl, "_blank");
            if (!popup || popup.closed) {
                if (typeof showToast === 'function') {
                     showToast('error', 'Please allow popups and refresh the page!', 'times-circle');
                }
                return;
            }
        }

        window.location.replace("https://classroom.google.com/");
    }


    function runInitialCloak(cloakLinkValue) {
        const decoyName = localStorage.getItem('decoy') || 'None';
        executeTabCloak(cloakLinkValue, decoyName);
    }

    const initialDecoy = localStorage.getItem('decoy') || 'None';
    const initialCloakLink = localStorage.getItem('cloakLink') || 'None';

    applyInitialDecoy(initialDecoy);
    
    window.addEventListener("load", () => runInitialCloak(initialCloakLink));
    
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
                    background-color: #181818;
                    border: 2px solid #ffffff00;
                    color: #e0e0e0;
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
                    background-color: #333; 
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
        const shortcutPrompt = document.getElementById('shortcut-prompt');
        const gamesMenu = document.getElementById('games-menu');

        let isToggling = false;

        const appSettings = {
            backend: localStorage.getItem('backend') || 'scramjet',
            transport: localStorage.getItem('transport') || 'libcurl',
            customWispUrl: localStorage.getItem('customWispUrl'),
            searchSuggestionsEnabled: localStorage.getItem('searchSuggestionsEnabled') !== 'false',
            cloakLink: localStorage.getItem('cloakLink') || 'None',
            decoy: localStorage.getItem('decoy') || 'None',
            searchEngine: localStorage.getItem('searchEngine') || 'DuckDuckGo',
            preventClosing: localStorage.getItem('preventClosing') === 'true'
        };

        if (appSettings.cloakLink.toLowerCase() === 'none') {
            appSettings.cloakLink = 'None';
            localStorage.setItem('cloakLink', 'None');
        }

        settingsMenu.innerHTML = `
            <h2>Settings</h2>
            <div class="settings-container">
                <div class="settings-tabs">
                    <button class="tab-button active" id="preferences-tab">
                        <i class="fa-regular fa-gear"></i> Preferences
                    </button>
                    <button class="tab-button" id="cloaking-tab">
                        <i class="fa-regular fa-ghost"></i> Cloaking
                    </button>
                    <button class="tab-button" id="advanced-tab">
                        <i class="fa-regular fa-server"></i> Advanced
                    </button>
                    <button class="tab-button" id="data-tab">
                        <i class="fa-regular fa-user"></i> Data
                    </button>
                    <button class="tab-button" id="about-tab">
                        <i class="fa-regular fa-heart"></i> Credits
                    </button>
                    <div class="settings-version-label" id="settings-version-label">Fetching...</div>
                </div>
                <div class="settings-content-wrapper">
                    <div id="preferences-content" class="tab-content active">
                        <div class="settings-item">
                            <label>Search Engine</label>
                            <p>The engine used for queries</p>
                            <div class="search-engine-selector">
                                <div class="search-engine-selected"></div>
                                <div class="search-engine-options"></div>
                            </div>
                        </div>
                        <div class="settings-item">
                            <label>Prevent Closing</label>
                            <p>Prevent the tab from being closed</p>
                            <input type="checkbox" id="prevent-closing-toggle">
                        </div>
                    </div>
                    <div id="cloaking-content" class="tab-content">
                        <div class="settings-item">
                            <label>Decoy</label>
                            <p>Cloak the title and icon as a different website</p>
                            <div class="decoy-selector">
                                <div class="decoy-selected"></div>
                                <div class="decoy-options"></div>
                            </div>
                        </div>
                        <div class="settings-item">
                            <label>Cloak Link</label>
                            <p>Cloak the website link on the URL bar</p>
                            <div class="cloak-link-selector">
                                <div class="cloak-link-selected"></div>
                                <div class="cloak-link-options"></div>
                            </div>
                        </div>
                    </div>
                    <div id="advanced-content" class="tab-content">
                        <div class="settings-item">
                            <label>Backend</label>
                            <p>Responsible for loading your sites</p>
                            <div class="backend-selector">
                                <div class="backend-selected"></div>
                                <div class="backend-options"></div>
                            </div>
                        </div>
                        <div class="settings-item">
                            <label>Transport</label>
                            <p>How information will be sent</p>
                            <div class="transport-selector">
                                <div class="transport-selected"></div>
                                <div class="transport-options"></div>
                            </div>
                        </div>
                        <div class="settings-item">
                            <label>Wisp Server</label>
                            <p>Configure the websocket endpoint</p>
                            <input type="text" id="wisp-server" placeholder="Wisp Server URL Here..." autocomplete="off">
                            <button id="save-wisp-url">Save</button>
                        </div>
                    </div>
                    <div id="data-content" class="tab-content">
                        <div class="settings-item">
                            <label>Data Management</label>
                            <p>Export or Import all your data</p>
                            <button id="export-data-btn" class="data-action-btn">
                                <i class="fa-solid fa-file-export"></i> Export Data
                            </button>
                            <button id="import-data-btn" class="data-action-btn">
                                <i class="fa-solid fa-file-import"></i> Import Data
                            </button>
                        </div>
                    </div>
                    <div id="about-content" class="tab-content">
                        <div class="settings-item">
                            <label>Credits</label>
                            <p>GN-Math - All of the games</p>
                            <p>Bog - Ports for Hollow Knight, RE:RUN, and Touhou Mother
                            <p>Titanium Network - Ultraviolet</p>
                            <p>Mercury Workshop - Scramjet, Epxoy, and Libcurl</p>
                        </div>
                        <div class="settings-item">
                            <label>You have reached the end!</label>
                            <p>
                                Thank you so much for using <a href="https://waves.lat/" target="_blank" class="hover-link">Waves!</a> 
                                If you have any suggestions or issues, please contact us on our <a href="https://discord.gg/dJvdkPRheV" target="_blank" class="hover-link">Discord server</a> 
                                or open an issue on our <a href="https://github.com/l4uy/Waves" target="_blank" class="hover-link">Github repository</a> <3
                            </p>
                        </div>
                    </div>
                </div>
            </div>
            <button id="close-settings">
                <i class="fa-regular fa-times"></i>
            </button>
        `;

        const closeSettingsBtn = document.getElementById('close-settings');
        const saveWispBtn = document.getElementById('save-wisp-url');
        const preventClosingToggle = document.getElementById('prevent-closing-toggle');
        const wispInput = document.querySelector("#wisp-server");
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
        const decoySelector = document.querySelector('.decoy-selector');
        const decoySelected = decoySelector.querySelector('.decoy-selected');
        const decoyOptions = decoySelector.querySelector('.decoy-options');
        const cloakLinkSelector = document.querySelector('.cloak-link-selector');
        const cloakLinkSelected = cloakLinkSelector.querySelector('.cloak-link-selected');
        const cloakLinkOptions = cloakLinkSelector.querySelector('.cloak-link-options');

        const defaultWispUrl = `${window.location.protocol === "https:" ? "wss" : "ws"}://${window.location.host}/w/`;
        const allBackendOptions = ['Ultraviolet', 'Scramjet'];
        const allTransportOptions = ['Epoxy', 'Libcurl'];
        const allSearchEngineOptions = ['DuckDuckGo', 'Google', 'Bing', 'Startpage'];
        const allDecoyOptions = ['None', 'Google', 'Google Docs', 'Youtube', 'Google Drive', 'Schoology'];
        const allCloakLinkOptions = ['None', 'about:blank', 'blob:'];

        let currentWispUrl = appSettings.customWispUrl || defaultWispUrl;

        window.toggleSettingsMenu = function() {
            if (isToggling) return;
            isToggling = true;
            const icon = document.querySelector('#settings i.settings'); 
            const isOpen = settingsMenu.classList.contains('open');

            if (isOpen) {
                settingsMenu.classList.add('close');
                if(icon) icon.classList.remove('active-icon');
                if (overlay) {
                    const sharePrompt = document.getElementById('sharePrompt');
                    const updateSuccess = document.getElementById('updateSuccess');
                    const bookmarkPrompt = document.getElementById('bookmark-prompt');
                    const isOtherModalOpen = (gamesMenu && gamesMenu.classList.contains('open')) ||
                                             (sharePrompt && sharePrompt.style.display === 'block' && !sharePrompt.classList.contains('fade-out')) ||
                                             (updateSuccess && updateSuccess.style.display === 'block' && !updateSuccess.classList.contains('fade-out')) ||
                                             (bookmarkPrompt && bookmarkPrompt.style.display === 'block' && !bookmarkPrompt.classList.contains('fade-out-prompt')) ||
                                             (shortcutPrompt && shortcutPrompt.style.display === 'block');
    
                    if (!isOtherModalOpen) {
                        overlay.classList.remove('show');
                    }
                }
            } else {
                if (window.hideGamesMenu) window.hideGamesMenu(true);
                if (window.xinUpdate && typeof window.xinUpdate.hideSuccess === 'function' && document.getElementById('updateSuccess')?.style.display === 'block') {
                    window.xinUpdate.hideSuccess(true);
                }
                if (window.SharePromoter && typeof window.SharePromoter.hideSharePrompt === 'function' && document.getElementById('sharePrompt')?.style.display === 'block') {
                    window.SharePromoter.hideSharePrompt(true);
                }
                if (window.hideBookmarkPrompt && document.getElementById('bookmark-prompt')?.style.display === 'block') {
                    window.hideBookmarkPrompt(true);
                }

                settingsMenu.classList.add('open');
                if(icon) icon.classList.add('active-icon');
                if (overlay) {
                    overlay.classList.add('show');
                }
            }
            
            if (isOpen) {
                settingsMenu.addEventListener('animationend', (e) => {
                    if (e.animationName !== 'closeMenu') return;
                    settingsMenu.classList.remove('open', 'close');
                    isToggling = false;
                }, { once: true });
            } else {
                settingsMenu.addEventListener('animationend', (e) => {
                    if (e.animationName !== 'openMenu') return;
                    settingsMenu.classList.remove('close');
                    isToggling = false;
                }, { once: true });
            }
        }

        function isValidUrl(url) {
            try {
                const p = new URL(url);
                return (p.protocol === "wss:" || p.protocol === "ws:") && url.endsWith('/');
            } catch (_) {
                return false;
            }
        }
        
        function runMenuCloak() {
            executeTabCloak(appSettings.cloakLink, appSettings.decoy);
        }

        function updateWispServerUrl(url) {
            if (isValidUrl(url)) {
                currentWispUrl = url;
                appSettings.customWispUrl = url;
                localStorage.setItem('customWispUrl', url);
                document.dispatchEvent(new CustomEvent('wispUrlUpdated', {
                    detail: currentWispUrl
                }));
                showToast('success', 'Successfully updated Wisp Server! Reloading...', 'check-circle');
            } else {
                currentWispUrl = defaultWispUrl;
                appSettings.customWispUrl = defaultWispUrl;
                localStorage.setItem('customWispUrl', defaultWispUrl);
                document.dispatchEvent(new CustomEvent('wispUrlUpdated', {
                    detail: currentWispUrl
                }));
                showToast('error', "Invalid URL. Reverting to default...", 'times-circle');
            }
        }

        function closeAllSelectors() {
            document.querySelectorAll('.backend-show, .transport-show, .search-engine-show, .decoy-show, .cloak-link-show').forEach(el => el.classList.remove('backend-show', 'transport-show', 'search-engine-show', 'decoy-show', 'cloak-link-show'));
            document.querySelectorAll('.backend-arrow-active, .transport-arrow-active, .search-engine-arrow-active, .decoy-arrow-active, .cloak-link-arrow-active').forEach(el => el.classList.remove('backend-arrow-active', 'transport-arrow-active', 'search-engine-arrow-active', 'decoy-arrow-active', 'cloak-link-arrow-active'));
        }

        function changeTab(targetId) {
            closeAllSelectors();
            document.querySelectorAll('.tab-button.active').forEach(button => button.classList.remove('active'));
            document.getElementById(targetId).classList.add('active');

            const contentId = targetId.replace('-tab', '-content');
            document.querySelectorAll('.tab-content.active').forEach(content => content.classList.remove('active'));
            document.getElementById(contentId).classList.add('active');
        }

        function createSelector(selectorType, selectedEl, optionsEl, allOptions, currentVal, storageKey, eventName, successMsg) {
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
                            div.addEventListener('click', function(e) {
                                e.stopPropagation();
                                const val = this.textContent;
                                selectedEl.textContent = val;

                                const storageVal = (storageKey === 'backend' || storageKey === 'transport') ? val.toLowerCase() : val;
                                
                                appSettings[storageKey] = storageVal;
                                localStorage.setItem(storageKey, storageVal);
                                closeAllSelectors();
                                if (eventName) document.dispatchEvent(new CustomEvent(eventName, {
                                    detail: storageVal
                                }));
                                if (successMsg) showToast('success', successMsg, 'check-circle');

                                if (storageKey === 'cloakLink') {
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

        wispInput.value = currentWispUrl;
        preventClosingToggle.checked = appSettings.preventClosing;

        createSelector('backend', backendSelected, backendOptions, allBackendOptions, appSettings.backend.charAt(0).toUpperCase() + appSettings.backend.slice(1), 'backend', 'backendUpdated', 'Successfully updated Backend! Reloading...');
        createSelector('transport', transportSelected, transportOptions, allTransportOptions, appSettings.transport.charAt(0).toUpperCase() + appSettings.transport.slice(1), 'transport', 'newTransport', 'Successfully updated Transport! Reloading...');
        createSelector('cloak-link', cloakLinkSelected, cloakLinkOptions, allCloakLinkOptions, appSettings.cloakLink, 'cloakLink', null, 'Successfully updated Cloak Link method!');
        createSelector('search-engine', searchEngineSelected, searchEngineOptions, allSearchEngineOptions, appSettings.searchEngine, 'searchEngine', null, 'Successfully updated Search Engine!');
        createSelector('decoy', decoySelected, decoyOptions, allDecoyOptions, appSettings.decoy, 'decoy', 'decoyUpdated', 'Successfully updated Decoy!');

        closeSettingsBtn.addEventListener('click', window.toggleSettingsMenu);
        saveWispBtn.addEventListener('click', () => updateWispServerUrl(wispInput.value.trim()));
        
        document.addEventListener('decoyUpdated', (e) => applyInitialDecoy(e.detail));

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
            if (!e.target.closest('.backend-selector, .transport-selector, .search-engine-selector, .decoy-selector, .cloak-link-selector')) {
                closeAllSelectors();
            }
        });

        document.querySelectorAll('.tab-button').forEach(button => {
            button.addEventListener('click', () => changeTab(button.id));
        });

        preventClosingToggle.addEventListener('change', function() {
            appSettings.preventClosing = this.checked;
            localStorage.setItem('preventClosing', this.checked.toString());
            showToast(this.checked ? 'success' : 'error', `Prevent Closing ${this.checked ? 'enabled!' : 'disabled!'}`, this.checked ? 'check-circle' : 'times-circle');
        });

        document.querySelectorAll('input[type="checkbox"]').forEach(toggle => {
            toggle.addEventListener('change', function() {
                this.classList.remove('animate-on', 'animate-off');
                void this.offsetWidth;
                this.classList.add(this.checked ? 'animate-on' : 'animate-off');
            });
        });

        fetch('/api/version', {
                cache: 'no-store'
            })
            .then(response => response.ok ? response.json() : null)
            .then(data => {
                if (data && data.version) {
                    const versionLabel = document.getElementById('settings-version-label');
                    if (versionLabel) versionLabel.textContent = `v${data.version}`;
                }
            })
            .catch(() => {});

        settingsInitialized = true;
    }

    window.initializeSettingsMenu = initializeSettingsMenu;

    settingsIcon.addEventListener('click', e => {
        e.preventDefault();
        initializeSettingsMenu();
        window.toggleSettingsMenu();
    });
});