const LOADING_SCREEN = `
    <div id="loading-screen" style="position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: #000; z-index: 99999; display: flex; justify-content: center; align-items: center; color: #858585; font-family: 'Lexend', sans-serif;">
        <h1 style="margin: 0; font-size: 1.2rem; font-weight: 400;">syncing data...</h1>
    </div>
`;

export class CloudSync {
    constructor() {
        this.user = JSON.parse(localStorage.getItem('auth_user') || '{}');
        this.syncTimeout = null;
        this.isSyncing = false;
        this.isAuthenticated = false;

        this.init();
    }

    async init() {
        this.showLoadingScreen();

        try {
            await this.checkAuthStatus();

            if (this.isAuthenticated) {
                await this.restoreData(true);
            }
        } catch (e) {
            console.warn("[cloudsync] startup check failed", e);
        } finally {
            this.hideLoadingScreen();
        }

        document.addEventListener('toggleAuthModal', () => this.toggleModal());

        this.hookStorage();

        if (this.isAuthenticated) {
            setInterval(() => this.checkForChanges(), 10000);
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
            setTimeout(() => screen.remove(), 500);
        }
    }

    async checkAuthStatus() {
        try {
            const res = await fetch('/api/auth/me');
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
            console.warn("auth check failed", e);
            this.isAuthenticated = false;
        }
    }

    hookStorage() {
        const originalSetItem = localStorage.setItem;
        const self = this;
        localStorage.setItem = function (key, value) {
            originalSetItem.apply(this, arguments);
            if (key !== 'auth_user' && key !== 'auth_token') {
                self.notifyChange();
            }
        };

        const originalRemoveItem = localStorage.removeItem;
        localStorage.removeItem = function (key) {
            originalRemoveItem.apply(this, arguments);
            if (key !== 'auth_user' && key !== 'auth_token') {
                self.notifyChange();
            }
        };
    }

    notifyChange() {
        if (!this.isAuthenticated) return;

        if (this.syncTimeout) clearTimeout(this.syncTimeout);

        this.updateStatus('syncing...', 'loading');

        this.syncTimeout = setTimeout(() => {
            this.syncData();
        }, 500);
    }

    checkForChanges() {
        if (this.isAuthenticated && !this.isSyncing) {
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
                            <i class="fa-regular fa-eye password-toggle" data-target="login-password" style="position: absolute; right: 10px; top: 59%; transform: translateY(-50%); cursor: pointer; color: #888; font-size: 13px;"></i>
                        </div>
                        
                        <div style="text-align: center;">
                            <button type="submit" class="auth-action-btn" style="width: 50%; margin-top: 15px;">login</button>
                        </div>
                    </form>
                    
                    <form id="register-form" style="display: none;">
                        <label>choose username</label>
                        <input type="text" id="reg-username" placeholder="create username" autocomplete="off">
                        <div id="reg-username-feedback" style="font-size: 11px; color: #888; margin-top: 4px; text-align: left; min-height: 14px;">3-20 chars, letters/numbers</div>
                        
                        <label style="margin-top: 15px;">choose password</label>
                        <div style="position: relative;">
                            <input type="password" id="reg-password" placeholder="create password" style="width: 100%; padding-right: 35px; box-sizing: border-box;">
                            <i class="fa-regular fa-eye password-toggle" data-target="reg-password" style="position: absolute; right: 10px; top: 59%; transform: translateY(-50%); cursor: pointer; color: #888; font-size: 13px;"></i>
                        </div>
                        <div id="reg-password-feedback" style="font-size: 11px; color: #888; margin-top: 4px; text-align: left; min-height: 14px;">8+ chars, 1 number, 1 symbol</div>
                        
                        <div style="text-align: center;">
                            <button type="submit" class="auth-action-btn" style="width: 60%; margin-top: 15px;">create account</button>
                        </div>
                    </form>

                    <div style="margin-top: 15px; font-size: 13px; color: #888; text-align: center;" id="auth-switch-container">
                        <span id="auth-prompt-text">don't have an account?</span> <span id="auth-action-text" class="hover-link">create an account</span>
                    </div>
                    <div id="auth-error" style="color: #ff5555; margin-top: 10px; font-size: 13px; min-height: 18px; text-align: center;"></div>
                </div>
                <div id="auth-logged-in" style="display: none; text-align: center;">
                    <p style="margin-bottom: 20px; font-size: 16px;">logged in as <strong id="auth-user-display" style="color: white;"></strong></p>
                    
                    <div style="margin-bottom: 20px;">
                        <span id="sync-status-indicator" style="color: #888; font-size: 14px;">
                            <i class="fa-solid fa-check" style="color: #ffffffff"></i> synced
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
                regUsernameFeedback.style.color = "#888";
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
                regPasswordFeedback.style.color = "#888";
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
                actionText.textContent = 'login';
            } else {
                loginForm.style.display = 'block';
                regForm.style.display = 'none';
                authTitle.textContent = 'login';
                promptText.textContent = "don't have an account?";
                actionText.textContent = 'create an account';
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
        if (statusEl) statusEl.textContent = this.isAuthenticated ? this.user.username : 'sync to cloud';
    }

    updateStatus(text, type) {
        const ind = document.getElementById('sync-status-indicator');
        if (!ind) return;

        if (type === 'loading') {
            ind.innerHTML = `<i class="fa-solid fa-rotate" style="color: #ffffffff;"></i> ${text}`;
        } else if (type === 'error') {
            ind.innerHTML = `<i class="fa-solid fa-triangle-exclamation" style="color: #ff5555;"></i> ${text}`;
        } else {
            ind.innerHTML = `<i class="fa-solid fa-check" style="color: #ffffffff;"></i> ${text}`;
        }
    }

    async handleLogin(e) {
        e.preventDefault();
        const username = document.getElementById('login-username').value;
        const password = document.getElementById('login-password').value;

        if (window.showToast) window.showToast('info', 'logging in...', 'right-to-bracket');

        try {
            const res = await fetch('/api/auth/login', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username, password })
            });
            const data = await res.json();

            if (res.ok) {
                this.setSession(data);

                this.toggleModal();

                await this.restoreData();

            } else {
                if (window.showToast) window.showToast('error', data.error || 'login failed', 'warning');
                else this.showError(data.error);
            }
        } catch (err) {
            if (window.showToast) window.showToast('error', 'connection error', 'warning');
            else this.showError('login failed');
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

        if (window.showToast) window.showToast('info', 'creating account...', 'user-plus');

        try {
            const res = await fetch('/api/auth/register', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username, password })
            });
            const data = await res.json();

            if (res.ok) {
                this.setSession(data);
                this.toggleModal();

                await this.syncData();
            } else {
                if (window.showToast) window.showToast('error', data.error || 'registration failed', 'warning');
                else this.showError(data.error);
            }
        } catch (err) {
            if (window.showToast) window.showToast('error', 'connection error', 'warning');
            else this.showError('registration failed');
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
            console.warn("server logout failed", e);
        }

        this.isAuthenticated = false;
        this.user = {};
        localStorage.removeItem('auth_user');

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
        try {
            const res = await fetch('/api/auth/me', {
                method: 'DELETE'
            });

            if (res.ok) {
                this.isAuthenticated = false;
                this.user = {};
                localStorage.removeItem('auth_user');

                await this.wipeLocalData();

                window.bypassPreventClosing = true;
                window.location.reload();
            } else {
                const data = await res.json();
                if (window.showToast) window.showToast('error', data.error || 'delete failed', 'warning');
                else alert("failed to delete account: " + (data.error || "unknown error"));
            }
        } catch (err) {
            if (window.showToast) window.showToast('error', 'delete failed', 'warning');
            else alert("failed to delete account");
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
            console.warn("cookie clear failed", e);
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
    }

    async syncData() {
        if (!this.isAuthenticated || this.isSyncing) return;
        this.isSyncing = true;

        try {
            if (typeof window.wavesExportAllData !== 'function') {
                this.isSyncing = false;
                return;
            }

            const data = await window.wavesExportAllData();

            const res = await fetch('/api/sync/upload', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify(data)
            });

            if (res.ok) {
                this.updateStatus('synced', 'success');
            } else {
                this.updateStatus('sync failed', 'error');
            }
        } catch (err) {
            console.error("sync error", err);
            this.updateStatus('connection error', 'error');
        } finally {
            this.isSyncing = false;
        }
    }

    async restoreData(silent = false) {
        if (!this.isAuthenticated) return;
        if (!silent) this.updateStatus('restoring...', 'loading');

        try {
            const res = await fetch('/api/sync/download');

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
                    if (!silent) {
                        window.bypassPreventClosing = true;
                        window.location.reload();
                    }
                }
            } else if (res.status === 404) {
                if (!silent) this.updateStatus('no data found', 'success');
            }
        } catch (err) {
            console.error("restore error", err);
            if (!silent) this.updateStatus('restore failed', 'error');
        }
    }
}

document.addEventListener('DOMContentLoaded', () => {
    window.cloudSync = new CloudSync();
});