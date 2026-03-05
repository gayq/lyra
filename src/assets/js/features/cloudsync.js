const LOADING_SCREEN = `
    <div id="loading-screen" style="position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: #000; z-index: 99999; display: flex; justify-content: center; align-items: center; color: #858585; font-family: 'Lexend', sans-serif;">
        <h1 style="margin: 0; font-size: 1.2rem; font-weight: 300;">syncing data...</h1>
    </div>
`;

function fetchWithTimeout(url, options = {}, timeoutMs = 8000) {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), timeoutMs);
    return fetch(url, { ...options, signal: controller.signal }).finally(() => clearTimeout(id));
}

export class CloudSync {
    constructor() {
        this.user = JSON.parse(localStorage.getItem('auth_user') || '{}');
        try {
            this.syncMeta = JSON.parse(localStorage.getItem('waves-sync-meta') || '{"dirty": false, "last_synced": null}');
        } catch (e) {
            this.syncMeta = { dirty: false, last_synced: null };
        }

        this.syncTimeout = null;
        this.isSyncing = false;
        this.isAuthenticated = false;

        this.init();
    }

    async init() {
        if (!this.user || Object.keys(this.user).length === 0) {
            this.isAuthenticated = false;
            this.updateModalState();

            document.addEventListener('toggleAuthModal', () => this.toggleModal());
            this.hookStorage();
            return;
        }

        let needsLoadingScreen = false;
        let safetyTimer = null;

        try {
            const [authRes, metaRes] = await Promise.all([
                fetchWithTimeout('/api/auth/me', { cache: 'no-store' }),
                fetchWithTimeout('/api/sync/meta', { cache: 'no-store' })
            ]);

            if (authRes.ok) {
                const data = await authRes.json();
                this.user = data.user;
                this.isAuthenticated = true;
                localStorage.setItem('auth_user', JSON.stringify(this.user));
            } else {
                this.isAuthenticated = false;
                this.user = {};
                localStorage.removeItem('auth_user');
            }
            this.updateModalState();

            if (this.isAuthenticated && metaRes.ok) {
                const metaData = await metaRes.json();
                const serverUpdatedAt = metaData.updated_at;

                if (this.syncMeta.dirty) {
                    await this.syncData(true);
                } else if (serverUpdatedAt && serverUpdatedAt !== this.syncMeta.last_synced) {
                    needsLoadingScreen = true;
                    this.showLoadingScreen();
                    safetyTimer = setTimeout(() => this.hideLoadingScreen(), 10000);
                    await this.restoreData(true);
                } else {
                    this.updateStatus('synced', 'success');
                }
            }
        } catch (e) {
            console.warn("[cloudsync] startup check failed", e);
        } finally {
            if (safetyTimer) clearTimeout(safetyTimer);
            if (needsLoadingScreen) this.hideLoadingScreen();
        }

        document.addEventListener('toggleAuthModal', () => this.toggleModal());
        this.hookStorage();

        if (this.isAuthenticated) {
            setInterval(() => this.checkForChanges(), 5000);
        }
    }

    async sync() {
        try {
            if (!this.isAuthenticated) return;
            const metaRes = await fetchWithTimeout('/api/sync/meta', { cache: 'no-store' });
            if (!metaRes.ok) return;

            const metaData = await metaRes.json();
            const serverUpdatedAt = metaData.updated_at;

            if (this.syncMeta.dirty) {
                await this.syncData(true);
            } else if (serverUpdatedAt && serverUpdatedAt !== this.syncMeta.last_synced) {
                await this.restoreData(true);
            } else {
                this.updateStatus('synced', 'success');
            }
        } catch (e) {
            console.warn("[cloudsync] sync error", e);
        }
    }

    showLoadingScreen() {
        if (!document.getElementById('loading-screen')) {
            const div = document.createElement('div');
            div.innerHTML = LOADING_SCREEN.trim();
            document.body.appendChild(div.firstChild);
        }
    }

    hideLoadingScreen() {
        const screen = document.getElementById('loading-screen');
        if (screen) {
            screen.remove();
        }
    }

    async checkAuthStatus() {
        try {
            const res = await fetchWithTimeout('/api/auth/me', { cache: 'no-store' });
            if (res.ok) {
                const data = await res.json();
                this.user = data.user;
                this.isAuthenticated = true;
                localStorage.setItem('auth_user', JSON.stringify(this.user));
            } else {
                this.isAuthenticated = false;
                this.user = {};
                localStorage.removeItem('auth_user');
            }
            this.updateModalState();
        } catch (e) {
            console.warn("auth check failed!", e);
            this.isAuthenticated = false;
        }
    }

    saveMeta() {
        localStorage.setItem('waves-sync-meta', JSON.stringify(this.syncMeta));
    }

    hookStorage() {
        const originalSetItem = localStorage.setItem;
        const self = this;
        localStorage.setItem = function (key, value) {
            originalSetItem.apply(this, arguments);
            if (key !== 'auth_user' && key !== 'auth_token' && key !== 'waves-sync-meta') {
                self.markDirty();
            }
        };

        const originalRemoveItem = localStorage.removeItem;
        localStorage.removeItem = function (key) {
            originalRemoveItem.apply(this, arguments);
            if (key !== 'auth_user' && key !== 'auth_token' && key !== 'waves-sync-meta') {
                self.markDirty();
            }
        };

        if (window.IDBObjectStore) {
            const hookIDB = (method) => {
                const original = IDBObjectStore.prototype[method];
                IDBObjectStore.prototype[method] = function (...args) {
                    self.markDirty();
                    return original.apply(this, args);
                };
            };
            hookIDB('put');
            hookIDB('add');
            hookIDB('delete');
            hookIDB('clear');
        }
    }

    markDirty() {
        if (!this.isAuthenticated || this.isRestoring) return;
        if (this.syncMeta.dirty) {
            this.notifyChange();
            return;
        }

        this.syncMeta.dirty = true;
        this.saveMeta();
        this.notifyChange();
    }

    notifyChange() {
        if (!this.isAuthenticated) return;

        if (this.syncTimeout) clearTimeout(this.syncTimeout);

        this.updateStatus('syncing...', 'loading');

        this.syncTimeout = setTimeout(() => {
            this.syncData();
        }, 1500);
    }

    checkForChanges() {
        if (this.isAuthenticated && !this.isSyncing && this.syncMeta.dirty) {
            this.syncData();
        }
    }

    async createAuthModal() {
        if (document.getElementById('auth-modal')) return;

        const modal = document.createElement('div');
        modal.id = 'auth-modal';
        modal.className = 'popup';
        modal.innerHTML = `
                <h2 id="auth-title" style="text-align: center; margin-top: 0; margin-bottom: 15px;">login</h2>
                <div id="auth-forms" class="input-container">
                    <form id="login-form">
                        <label>username</label>
                        <input type="text" id="login-username" placeholder="enter username" autocomplete="off">
                        
                        <label style="margin-top: 15px;">password</label>
                        <div style="position: relative;">
                            <input type="password" id="login-password" placeholder="enter password" style="width: 100%; padding-right: 35px; box-sizing: border-box;">
                            <i class="fa-regular fa-eye password-toggle" data-target="login-password" style="position: absolute; right: 10px; top: 59%; transform: translateY(-50%); cursor: pointer; color: var(--text-muted); font-size: 13px;"></i>
                        </div>
                        
                        <div style="text-align: center;">
                            <button type="submit" class="auth-action-btn" style="width: 50%; margin-top: 15px;">login</button>
                        </div>
                    </form>
                    
                    <form id="register-form" style="display: none;">
                        <label>username</label>
                        <input type="text" id="reg-username" placeholder="create username" autocomplete="off">
                        <div id="reg-username-feedback" style="font-size: 11px; color: var(--text-muted); margin-top: 4px; text-align: left; min-height: 14px;">3-20 chars, letters/numbers</div>
                        
                        <label style="margin-top: 15px;">password</label>
                        <div style="position: relative;">
                            <input type="password" id="reg-password" placeholder="create password" style="width: 100%; padding-right: 35px; box-sizing: border-box;">
                            <i class="fa-regular fa-eye password-toggle" data-target="reg-password" style="position: absolute; right: 10px; top: 59%; transform: translateY(-50%); cursor: pointer; color: var(--text-muted); font-size: 13px;"></i>
                        </div>
                        <div id="reg-password-feedback" style="font-size: 11px; color: var(--text-muted); margin-top: 4px; text-align: left; min-height: 14px;">8+ chars, 1 number, 1 symbol</div>
                        
                        <div style="text-align: center;">
                            <button type="submit" class="auth-action-btn" style="width: 60%; margin-top: 15px;">create account</button>
                            <p style="font-size: 11.5px; color: #ff5555; margin-top: 10px; max-width: 80%; margin-left: auto; margin-right: auto;">
                                save your password somewhere safe! all data will be forever lost if you forget your password ( •̯́ ^ •̯̀)
                            </p>
                        </div>
                    </form>

                    <div style="margin-top: 15px; margin-bottom: -20px; font-size: 13px; color: var(--text-muted); text-align: center;" id="auth-switch-container">
                        <span id="auth-prompt-text">don't have an account?</span> <span id="auth-action-text" class="hover-link">create an account!</span>
                    </div>
                    <div id="auth-error" style="color: #ff5555; margin-top: 10px; font-size: 13px; min-height: 18px; text-align: center;"></div>
                </div>
                <div id="auth-logged-in" style="display: none; text-align: center;">
                    <p style="margin-bottom: 20px; font-size: 16px;">logged in as <strong id="auth-user-display" style="color: var(--text-white);"></strong></p>
                    
                    <div style="margin-bottom: 20px;">
                        <span id="sync-status-indicator" style="color: var(--text-muted); font-size: 14px;">
                            <i class="fa-solid fa-check" style="color: var(--text-white)"></i> synced
                        </span>
                    </div>

                    <button id="logout-btn" class="auth-action-btn auth-secondary-btn">
                        logout
                    </button>
                    
                    <button id="delete-account-btn" class="auth-action-btn auth-secondary-btn">
                        delete account
                    </button>
                </div>
            <button id="close-auth-modal" class="cloudsync-close-btn">
                <i class="fa-regular fa-times"></i>
            </button>
        `;

        document.body.appendChild(modal);
        this.attachModalListeners(modal);
        this.updateModalState();
    }

    attachModalListeners(modal) {
        modal.querySelector('#close-auth-modal').addEventListener('click', () => this.toggleModal());
        const loginForm = modal.querySelector('#login-form');
        const regForm = modal.querySelector('#register-form');

        const regUsername = modal.querySelector('#reg-username');
        const regUsernameFeedback = modal.querySelector('#reg-username-feedback');
        const regPassword = modal.querySelector('#reg-password');
        const regPasswordFeedback = modal.querySelector('#reg-password-feedback');

        regUsername.addEventListener('input', () => {
            const val = regUsername.value;
            const len = val.length;
            const validChar = /^[a-zA-Z0-9_]+$/.test(val);

            if (len === 0) {
                regUsernameFeedback.textContent = "3-20 chars, letters/numbers";
                regUsernameFeedback.style.color = "var(--text-muted)";
            } else if (len < 3 || len > 20) {
                regUsernameFeedback.textContent = `${len}/20 chars (must be 3-20)`;
                regUsernameFeedback.style.color = "#ff5555";
            } else if (!validChar) {
                regUsernameFeedback.textContent = "letters, numbers, underscores only";
                regUsernameFeedback.style.color = "#ff5555";
            } else {
                regUsernameFeedback.textContent = `${len}/20 chars - looks good`;
                regUsernameFeedback.style.color = "#55ff55";
            }
        });

        regPassword.addEventListener('input', () => {
            const val = regPassword.value;
            const len = val.length;
            const hasNum = /[0-9]/.test(val);
            const hasSym = /[!@#$%^&*]/.test(val);

            if (len === 0) {
                regPasswordFeedback.textContent = "8+ chars, 1 number, 1 symbol";
                regPasswordFeedback.style.color = "var(--text-muted)";
            } else if (len < 8) {
                regPasswordFeedback.textContent = `${len}/8 chars`;
                regPasswordFeedback.style.color = "#ff5555";
            } else if (!hasNum) {
                regPasswordFeedback.textContent = "needs a number";
                regPasswordFeedback.style.color = "#ff5555";
            } else if (!hasSym) {
                regPasswordFeedback.textContent = "needs a symbol (!@#$%^&*)";
                regPasswordFeedback.style.color = "#ff5555";
            } else {
                regPasswordFeedback.textContent = "looks good";
                regPasswordFeedback.style.color = "#55ff55";
            }
        });

        const container = modal.querySelector('#auth-switch-container');
        const promptText = modal.querySelector('#auth-prompt-text');
        const actionText = modal.querySelector('#auth-action-text');
        const authTitle = modal.querySelector('#auth-title');

        actionText.addEventListener('click', () => {
            const isLogin = loginForm.style.display !== 'none';
            if (isLogin) {
                loginForm.style.display = 'none';
                regForm.style.display = 'block';
                authTitle.textContent = 'create account';
                promptText.textContent = 'already have an account?';
                actionText.textContent = 'login!';
            } else {
                loginForm.style.display = 'block';
                regForm.style.display = 'none';
                authTitle.textContent = 'login';
                promptText.textContent = "don't have an account?";
                actionText.textContent = 'create an account!';
            }
            this.showError('');
        });

        loginForm.addEventListener('submit', (e) => this.handleLogin(e));
        regForm.addEventListener('submit', (e) => this.handleRegister(e));

        modal.querySelector('#logout-btn').addEventListener('click', () => this.logout());

        const deleteBtn = modal.querySelector('#delete-account-btn');
        deleteBtn.addEventListener('click', () => {
            this.deleteAccount();
        });

        document.addEventListener('click', (e) => {
            const overlay = document.getElementById('overlay');
            if (overlay && e.target === overlay && modal.style.display === 'flex') {
                this.toggleModal();
            }
        });

        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && modal.style.display === 'flex') {
                this.toggleModal();
            }
        });

        const toggles = modal.querySelectorAll('.password-toggle');
        toggles.forEach(toggle => {
            toggle.addEventListener('click', () => {
                const targetId = toggle.getAttribute('data-target');
                const input = document.getElementById(targetId);
                if (!input) return;

                if (input.type === 'password') {
                    input.type = 'text';
                    toggle.classList.remove('fa-eye');
                    toggle.classList.add('fa-eye-slash');
                } else {
                    input.type = 'password';
                    toggle.classList.remove('fa-eye-slash');
                    toggle.classList.add('fa-eye');
                }
            });
        });
    }

    async toggleModal() {
        if (!document.getElementById('auth-modal')) {
            await this.createAuthModal();
        }

        const modal = document.getElementById('auth-modal');
        const overlay = document.getElementById('overlay');

        if (modal.style.display === 'flex' && !modal.classList.contains('fade-out-prompt')) {
            modal.classList.remove('fade-in-prompt');
            modal.classList.add('fade-out-prompt');
            overlay.classList.remove('show');
            setTimeout(() => {
                modal.style.display = 'none';
                modal.classList.remove('fade-out-prompt');
            }, 100);
        } else {
            modal.style.display = 'flex';
            modal.classList.remove('fade-out-prompt');
            modal.classList.add('fade-in-prompt');
            overlay.classList.add('show');
        }
    }

    updateModalState() {
        const loggedInView = document.getElementById('auth-logged-in');
        const formsView = document.getElementById('auth-forms');
        const userDisplay = document.getElementById('auth-user-display');
        const authTitle = document.getElementById('auth-title');

        if (this.isAuthenticated) {
            if (loggedInView) loggedInView.style.display = 'block';
            if (formsView) formsView.style.display = 'none';
            if (userDisplay) userDisplay.textContent = this.user.username;
            if (authTitle) authTitle.textContent = 'cloud sync';
        } else {
            if (loggedInView) loggedInView.style.display = 'none';
            if (formsView) formsView.style.display = 'block';
            if (authTitle) authTitle.textContent = 'login';
        }

        const statusEl = document.querySelector('#auth-status');
        if (statusEl) statusEl.textContent = this.isAuthenticated ? this.user.username : 'cloud sync';
    }

    updateStatus(text, type) {
        const ind = document.getElementById('sync-status-indicator');
        if (!ind) return;

        if (type === 'loading') {
            ind.innerHTML = `<i class="fa-solid fa-rotate" style="color: var(--text-white);"></i> ${text}`;
        } else if (type === 'error') {
            ind.innerHTML = `<i class="fa-solid fa-triangle-exclamation" style="color: #ff5555;"></i> ${text}`;
        } else {
            ind.innerHTML = `<i class="fa-solid fa-check" style="color: var(--text-white);"></i> ${text}`;
        }
    }

    async handleLogin(e) {
        e.preventDefault();
        const username = document.getElementById('login-username').value;
        const password = document.getElementById('login-password').value;

        let toastController = null;
        if (window.showToast) toastController = window.showToast('info', 'logging in...', 'right-to-bracket', 0);

        try {
            const res = await fetch('/api/auth/login', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username, password })
            });
            const data = await res.json();

            if (res.ok) {
                if (toastController) toastController.hide();
                this.setSession(data);
                this.toggleModal();
                await this.restoreData();
            } else {
                if (toastController) toastController.hide();
                if (window.showToast) window.showToast('error', data.error || 'login failed!', 'warning');
                else this.showError(data.error);
            }
        } catch (err) {
            if (toastController) toastController.hide();
            if (window.showToast) window.showToast('error', 'connection error!', 'warning');
            else this.showError('login failed!');
            console.error(err);
        }
    }

    async handleRegister(e) {
        e.preventDefault();
        const username = document.getElementById('reg-username').value;
        const password = document.getElementById('reg-password').value;

        if (!username || !password) {
            if (window.showToast) window.showToast('error', 'please fill in both username and password!', 'triangle-exclamation');
            else this.showError('please fill in both fields!');
            return;
        }

        let toastController = null;
        if (window.showToast) toastController = window.showToast('info', 'creating account...', 'user-plus', 0);

        try {
            const res = await fetch('/api/auth/register', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username, password })
            });
            const data = await res.json();

            if (res.ok) {
                if (toastController) toastController.hide();
                this.setSession(data);
                this.toggleModal();
                this.syncMeta.dirty = true;
                this.saveMeta();
                await this.syncData();
            } else {
                if (toastController) toastController.hide();
                if (window.showToast) window.showToast('error', data.error || 'registration failed!', 'warning');
                else this.showError(data.error);
            }
        } catch (err) {
            if (toastController) toastController.hide();
            if (window.showToast) window.showToast('error', 'connection error!', 'warning');
            else this.showError('registration failed!');
        }
    }

    setSession(data) {
        this.isAuthenticated = true;
        this.user = data.user;
        localStorage.setItem('auth_user', JSON.stringify(this.user));
        this.updateModalState();
    }

    async logout() {
        if (window.showToast) {
            window.showToast('info', 'confirm logout?', 'sign-out-alt', [
                {
                    text: 'cancel',
                    dismiss: true
                },
                {
                    text: 'logout',
                    class: 'danger-btn',
                    dismiss: true,
                    callback: async () => {
                        this.performLogout();
                    }
                }
            ]);
        } else {
            if (!confirm("confirm logout?")) return;
            this.performLogout();
        }
    }

    async performLogout() {
        try {
            await fetch('/api/auth/logout', { method: 'POST' });
        } catch (e) {
            console.warn("server logout failed!", e);
        }

        this.isAuthenticated = false;
        this.user = {};
        localStorage.removeItem('auth_user');
        localStorage.removeItem('waves-sync-meta');

        await this.wipeLocalData();

        window.bypassPreventClosing = true;
        window.location.reload();
    }

    async deleteAccount() {
        if (!this.isAuthenticated) return;

        if (window.showToast) {
            window.showToast('info', 'confirm deletion?', 'trash-alt', [
                {
                    text: 'cancel',
                    dismiss: true
                },
                {
                    text: 'delete',
                    class: 'danger-btn',
                    dismiss: true,
                    callback: () => {
                        this.performDelete();
                    }
                }
            ]);
        } else {
            if (confirm("are you sure? this will delete your account and all synced data permanently.")) {
                this.performDelete();
            }
        }
    }

    async performDelete() {
        let toastController = null;
        if (window.showToast) toastController = window.showToast('info', 'deleting account...', 'trash-alt', 0);

        try {
            const res = await fetch('/api/auth/me', {
                method: 'DELETE'
            });

            if (res.ok) {
                if (toastController) toastController.hide();
                this.isAuthenticated = false;
                this.user = {};
                localStorage.removeItem('auth_user');
                localStorage.removeItem('waves-sync-meta');

                await this.wipeLocalData();

                window.bypassPreventClosing = true;
                window.location.reload();
            } else {
                if (toastController) toastController.hide();
                const data = await res.json();
                if (window.showToast) window.showToast('error', data.error || 'deletion failed!', 'warning');
                else alert("failed to delete account: " + (data.error || "unknown error"));
            }
        } catch (err) {
            if (toastController) toastController.hide();
            if (window.showToast) window.showToast('error', 'deletion failed!', 'warning');
            else alert("failed to delete account!");
        }
    }

    showError(msg) {
        const el = document.getElementById('auth-error');
        if (el) {
            el.textContent = msg;
            setTimeout(() => el.textContent = '', 3000);
        }
    }

    async wipeLocalData() {
        try {
            const preserveKeys = [
                'alertClosed', 'wavesVisited', 'wavesVersion'
            ];

            const preservedData = {};
            preserveKeys.forEach(key => {
                const val = localStorage.getItem(key);
                if (val !== null) preservedData[key] = val;
            });

            localStorage.clear();
            sessionStorage.clear();

            localStorage.removeItem('waves-bookmarks');
            const sourceKey = preservedData['gameSource'] || 'gn-math';
            sessionStorage.removeItem(`waves-game-cache${sourceKey}`);

            Object.keys(preservedData).forEach(key => {
                localStorage.setItem(key, preservedData[key]);
            });
        } catch (e) {
            console.error("[cloudsync] error during storage wipe:", e);
        }

        try {
            document.cookie.split(";").forEach((c) => {
                document.cookie = c.replace(/^ +/, "").replace(/=.*/, "=;expires=" + new Date().toUTCString() + ";path=/");
            });
        } catch (e) {
            console.warn("cookie clear failed!", e);
        }

        if ('indexedDB' in window && typeof indexedDB.databases === 'function') {
            try {
                const dbs = await indexedDB.databases();
                for (const dbInfo of dbs) {
                    if (dbInfo.name) {
                        const req = indexedDB.deleteDatabase(dbInfo.name);
                    }
                }
            } catch (e) {
                console.warn("[cloudsync] error wiping idb:", e);
            }
        }

        if ('serviceWorker' in navigator) {
            try {
                const registrations = await navigator.serviceWorker.getRegistrations();
                await Promise.all(registrations.map(r => r.unregister()));
            } catch (e) {
                console.warn("[cloudsync] error unregistering service workers:", e);
            }
        }

        if ('caches' in window) {
            try {
                const keys = await caches.keys();
                await Promise.all(keys.map(k => caches.delete(k)));
            } catch (e) {
                console.warn("[cloudsync] error clearing caches:", e);
            }
        }
    }

    async syncData(manual = false, _retryCount = 0) {
        if (!manual && (!this.isAuthenticated || this.isSyncing)) return;
        this.isSyncing = true;

        try {
            if (typeof window.wavesExportAllData !== 'function') {
                if (_retryCount >= 3) {
                    console.warn('[cloudsync] wavesExportAllData not available after 3 retries, aborting sync');
                    this.isSyncing = false;
                    this.updateStatus('sync skipped', 'error');
                    return;
                }
                console.warn(`[cloudsync] wavesExportAllData not available yet, retry ${_retryCount + 1}/3...`);
                this.isSyncing = false;
                setTimeout(() => this.syncData(manual, _retryCount + 1), 2000);
                return;
            }

            const data = await window.wavesExportAllData();

            const res = await fetchWithTimeout('/api/sync/upload', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(data)
            }, 15000);

            if (res.ok) {
                const result = await res.json();
                this.syncMeta.dirty = false;
                this.syncMeta.last_synced = result.updated_at || new Date().toISOString().replace('T', ' ').slice(0, 19);
                this.saveMeta();

                this.updateStatus('synced', 'success');
                this._uploadRetries = 0;
            } else {
                console.warn('[cloudsync] upload failed:', res.status);
                if ((res.status === 429 || res.status >= 500) && (!this._uploadRetries || this._uploadRetries < 3)) {
                    this._uploadRetries = (this._uploadRetries || 0) + 1;
                    const delay = Math.min(2000 * Math.pow(2, this._uploadRetries - 1), 8000);
                    console.warn(`[cloudsync] retrying upload in ${delay}ms (attempt ${this._uploadRetries}/3)`);
                    this.updateStatus('retrying sync...', 'loading');
                    this.isSyncing = false;
                    setTimeout(() => this.syncData(manual, _retryCount), delay);
                    return;
                }
                this._uploadRetries = 0;
                this.updateStatus('sync failed', 'error');
            }
        } catch (err) {
            console.error("sync error!", err);
            if (!this._uploadRetries || this._uploadRetries < 3) {
                this._uploadRetries = (this._uploadRetries || 0) + 1;
                const delay = Math.min(2000 * Math.pow(2, this._uploadRetries - 1), 8000);
                console.warn(`[cloudsync] retrying upload in ${delay}ms (attempt ${this._uploadRetries}/3)`);
                this.updateStatus('retrying sync...', 'loading');
                this.isSyncing = false;
                setTimeout(() => this.syncData(manual, _retryCount), delay);
                return;
            }
            this._uploadRetries = 0;
            this.updateStatus('connection error', 'error');
        } finally {
            this.isSyncing = false;
        }
    }

    async restoreData(silent = false) {
        if (!this.isAuthenticated) return;
        if (!silent) this.updateStatus('restoring...', 'loading');
        this.isRestoring = true;

        let restoreToast = null;
        let reloading = false;

        if (!silent && window.showToast) {
            restoreToast = window.showToast('info', 'restoring data...', 'rotate', 0);
        }

        try {
            const res = await fetchWithTimeout('/api/sync/download', {}, 15000);

            if (res.status === 429) {
                if (!silent) this.updateStatus('too many requests', 'error');
                console.warn("[cloudsync] too many requests, retrying later");
                return;
            }

            if (!res.ok && res.status !== 404) {
                if (!silent) this.updateStatus('server error', 'error');
                return;
            }

            const json = await res.json();

            if (res.ok && json.data) {
                if (typeof window.wavesImportDataFromObject === 'function') {
                    await window.wavesImportDataFromObject(json.data, (progressText) => {
                        const loadingH1 = document.querySelector('#loading-screen h1');
                        if (loadingH1) loadingH1.textContent = progressText;
                    });

                    this.syncMeta.dirty = false;
                    this.syncMeta.last_synced = json.updated_at;
                    this.saveMeta();

                    if (!silent) {
                        reloading = true;
                        window.bypassPreventClosing = true;
                        window.location.reload();
                    } else {
                        document.dispatchEvent(new CustomEvent('cloudsync-restored'));
                        this.updateStatus('synced', 'success');
                    }
                }
            } else if (res.status === 404) {
                if (!silent) this.updateStatus('no data found', 'success');
            }
        } catch (err) {
            console.error("restore error!", err);
            if (!silent) this.updateStatus('restore failed', 'error');
        } finally {
            this.isRestoring = false;
            if (restoreToast && !reloading) {
                restoreToast.hide();
            }
        }
    }
}

document.addEventListener('DOMContentLoaded', () => {
    window.cloudSync = new CloudSync();
});