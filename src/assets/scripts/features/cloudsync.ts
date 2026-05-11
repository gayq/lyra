interface SyncMeta {
  dirty: boolean;
  last_synced: string | null;
}

interface AuthUser {
  username?: string;
  id?: string | number;
  [key: string]: unknown;
}

interface SyncPayload {
  localStorage: Record<string, string>;
  indexedDB: Record<string, unknown>;
  [key: string]: unknown;
}

interface DeltaPayload {
  _delta: boolean;
  localStorage: Record<string, string | null>;
  indexedDB?: Record<string, unknown>;
}

interface ToastController {
  update(type: string, message: string, icon?: string): void;
  hide(): void;
}

interface SessionData {
  user: AuthUser;
  token?: string;
  [key: string]: unknown;
}

interface DBExportRecord {
  key: unknown;
  value: unknown;
}

interface DBExportStore {
  __isExportFormatV2?: boolean;
  usesOutOfLineKeys?: boolean;
  data: DBExportRecord[];
}

type DBExport = Record<string, DBExportStore>;

interface IDBHashEntry {
  hash: string;
}

declare global {
  interface Window {
    wavesExportAllData?: () => Promise<SyncPayload>;
    wavesImportDataFromObject?: (
      data: unknown,
      callback: (progressText: string) => void,
    ) => Promise<void>;
    bypassPreventClosing?: boolean;
  }
}

const POLL_INTERVAL = 20000;
const POLL_MAX_INTERVAL = 60000;
const DIRTY_DEBOUNCE = 1500;
const DELTA_MAX_KEYS = 20;
const DELTA_FULL_INTERVAL = 10;
const SYNC_TIMEOUT = 60000;

const SKIP_KEYS = new Set(["auth_user", "auth_token", "waves-sync-meta"]);

const LOADING_SCREEN = `
    <div id="loading-screen" style="position: fixed; top: 0; left: 0; width: 100%; height: 100%; background: #000; z-index: 99999; display: flex; justify-content: center; align-items: center; color: #858585; font-family: 'Lexend', sans-serif;">
        <h1 style="margin: 0; font-size: 1.2rem; font-weight: 300;">syncing data...</h1>
    </div>
`;

function fetchWithTimeout(
  url: string,
  options: RequestInit = {},
  timeoutMs: number = 8000,
): Promise<Response> {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  return fetch(url, {
    credentials: "same-origin",
    ...options,
    signal: controller.signal,
  }).finally(() => clearTimeout(id));
}

export class CloudSync {
  user: AuthUser;
  syncMeta: SyncMeta;
  syncTimeout: ReturnType<typeof setTimeout> | null;
  isSyncing: boolean;
  isAuthenticated: boolean;
  isRestoring: boolean;
  _lastStatusText: string | undefined;
  _lastStatusType: string | undefined;
  _uploadRetries: number;
  _dirtyKeys: Map<string, string | null>;
  _idbHashes: Map<string, string>;
  _deltaCount: number;
  _pollInterval: number;
  _checkIntervalId: ReturnType<typeof setInterval> | null;

  constructor() {
    this.user = JSON.parse(localStorage.getItem("auth_user") || "{}");
    try {
      this.syncMeta = JSON.parse(
        localStorage.getItem("waves-sync-meta") ||
          '{"dirty": false, "last_synced": null}',
      );
    } catch (e) {
      this.syncMeta = { dirty: false, last_synced: null };
    }

    this.syncTimeout = null;
    this.isSyncing = false;
    this.isAuthenticated = false;
    this.isRestoring = false;
    this._lastStatusText = undefined;
    this._lastStatusType = undefined;
    this._uploadRetries = 0;
    this._dirtyKeys = new Map();
    this._idbHashes = new Map();
    this._deltaCount = 0;
    this._pollInterval = POLL_INTERVAL;
    this._checkIntervalId = null;

    this.init();
  }

  async init(): Promise<void> {
    if (!this.user || Object.keys(this.user).length === 0) {
      this.isAuthenticated = false;
      this.updateModalState();

      document.addEventListener("toggleAuthModal", () => this.toggleModal());
      this.hookStorage();
      return;
    }

    let needsLoadingScreen = false;
    let safetyTimer: ReturnType<typeof setTimeout> | null = null;

    try {
      const [authRes, metaRes] = await Promise.all([
        fetchWithTimeout("/api/auth/me", { cache: "no-store" }),
        fetchWithTimeout("/api/sync/meta", { cache: "no-store" }),
      ]);

      if (authRes.ok) {
        const data = await authRes.json();
        this.user = data.user;
        this.isAuthenticated = true;
        localStorage.setItem("auth_user", JSON.stringify(this.user));
      } else {
        this.isAuthenticated = false;
        this.user = {};
        localStorage.removeItem("auth_user");
      }
      this.updateModalState();

      if (this.isAuthenticated && metaRes.ok) {
        const metaData = await metaRes.json();
        const serverUpdatedAt: string = metaData.updated_at;

        if (this.syncMeta.dirty) {
          await this.syncData(true);
        } else if (
          serverUpdatedAt &&
          serverUpdatedAt !== this.syncMeta.last_synced
        ) {
          needsLoadingScreen = true;
          this.showLoadingScreen();
          safetyTimer = setTimeout(() => this.hideLoadingScreen(), 10000);
          await this.restoreData(true);
        } else {
          this.updateStatus("synced", "success");
        }
      }
    } catch (e) {
      console.warn("[cloudsync] startup check failed", e);
    } finally {
      if (safetyTimer) clearTimeout(safetyTimer);
      if (needsLoadingScreen) this.hideLoadingScreen();
    }

    document.addEventListener("toggleAuthModal", () => this.toggleModal());
    this.hookStorage();

    if (this.isAuthenticated) {
      this.startPolling();
    }
  }

  startPolling(): void {
    this.stopPolling();
    this._pollInterval = POLL_INTERVAL;
    this._checkIntervalId = setInterval(() => {
      if (this.isAuthenticated && !this.isSyncing && this.syncMeta.dirty) {
        this.syncData();
      }
    }, this._pollInterval);
  }

  stopPolling(): void {
    if (this._checkIntervalId) {
      clearInterval(this._checkIntervalId);
      this._checkIntervalId = null;
    }
  }

  onSyncError(): void {
    this._pollInterval = Math.min(this._pollInterval * 2, POLL_MAX_INTERVAL);
    this.startPolling();
  }

  onSyncSuccess(): void {
    if (this._pollInterval > POLL_INTERVAL) {
      this._pollInterval = POLL_INTERVAL;
      this.startPolling();
    }
  }

  async sync(): Promise<void> {
    try {
      if (!this.isAuthenticated) return;
      const metaRes = await fetchWithTimeout("/api/sync/meta", {
        cache: "no-store",
      });
      if (!metaRes.ok) return;

      const metaData = await metaRes.json();
      const serverUpdatedAt: string = metaData.updated_at;

      if (this.syncMeta.dirty) {
        await this.syncData(true);
      } else if (
        serverUpdatedAt &&
        serverUpdatedAt !== this.syncMeta.last_synced
      ) {
        await this.restoreData(true);
      } else {
        this.updateStatus("synced", "success");
      }
    } catch (e) {
      console.warn("[cloudsync] sync error", e);
    }
  }

  showLoadingScreen(): void {
    if (!document.getElementById("loading-screen")) {
      const div = document.createElement("div");
      div.innerHTML = LOADING_SCREEN.trim();
      document.body.appendChild(div.firstChild!);
    }
  }

  hideLoadingScreen(): void {
    const screen = document.getElementById("loading-screen");
    if (screen) {
      screen.remove();
    }
  }

  async checkAuthStatus(): Promise<void> {
    try {
      const res = await fetchWithTimeout("/api/auth/me", { cache: "no-store" });
      if (res.ok) {
        const data = await res.json();
        this.user = data.user;
        this.isAuthenticated = true;
        localStorage.setItem("auth_user", JSON.stringify(this.user));
      } else {
        this.isAuthenticated = false;
        this.user = {};
        localStorage.removeItem("auth_user");
      }
      this.updateModalState();
    } catch (e) {
      console.warn("auth check failed!", e);
      this.isAuthenticated = false;
    }
  }

  saveMeta(): void {
    localStorage.setItem("waves-sync-meta", JSON.stringify(this.syncMeta));
  }

  hookStorage(): void {
    const originalSetItem = localStorage.setItem;
    const self = this;
    localStorage.setItem = function (key: string, value: string): void {
      originalSetItem.call(localStorage, key, value);
      if (!SKIP_KEYS.has(key)) {
        self._dirtyKeys.set(key, value);
        self.markDirty();
      }
    };

    const originalRemoveItem = localStorage.removeItem;
    localStorage.removeItem = function (key: string): void {
      originalRemoveItem.call(localStorage, key);
      if (!SKIP_KEYS.has(key)) {
        self._dirtyKeys.set(key, null);
        self.markDirty();
      }
    };

    const originalClear = localStorage.clear;
    localStorage.clear = function (): void {
      originalClear.call(localStorage);
      if (!self.isAuthenticated || self.isRestoring) return;
      self._dirtyKeys.clear();
      self.markDirty();
    };

    window.addEventListener("storage", (e: StorageEvent) => {
      if (!self.isAuthenticated || self.isRestoring) return;
      if (e.storageArea !== localStorage) return;
      if (e.key === null) {
        self._dirtyKeys.clear();
        self.markDirty();
        return;
      }
      if (SKIP_KEYS.has(e.key)) return;
      self._dirtyKeys.set(e.key, e.newValue);
      self.markDirty();
    });

    if (typeof IDBObjectStore !== "undefined") {
      type IDBMutableMethod = "put" | "add" | "delete" | "clear";
      const hookIDB = (method: IDBMutableMethod): void => {
        const proto = IDBObjectStore.prototype as unknown as Record<
          string,
          unknown
        >;
        const original = proto[method] as (...args: unknown[]) => IDBRequest;
        if (!original) return;
        proto[method] = function (this: IDBObjectStore, ...args: unknown[]) {
          self.markDirty();
          return original.apply(this, args);
        };
      };
      hookIDB("put");
      hookIDB("add");
      hookIDB("delete");
      hookIDB("clear");
    }
  }

  markDirty(): void {
    if (!this.isAuthenticated || this.isRestoring) return;
    if (!this.syncMeta.dirty) {
      this.syncMeta.dirty = true;
      this.saveMeta();
    }

    if (this.syncTimeout) clearTimeout(this.syncTimeout);

    this.updateStatus("syncing...", "loading");

    this.syncTimeout = setTimeout(() => {
      this.syncData();
    }, DIRTY_DEBOUNCE);
  }

  checkForChanges(): void {
    if (this.isAuthenticated && !this.isSyncing && this.syncMeta.dirty) {
      this.syncData();
    }
  }

  async computeIDBHashes(): Promise<Map<string, string>> {
    const hashes = new Map<string, string>();
    if (!("indexedDB" in window) || typeof indexedDB.databases !== "function") {
      return hashes;
    }
    try {
      const dbs = await indexedDB.databases();
      for (const dbInfo of dbs) {
        if (!dbInfo.name) continue;
        try {
          const db = await new Promise<IDBDatabase>((resolve, reject) => {
            const req = indexedDB.open(dbInfo.name!);
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => reject(req.error);
            req.onblocked = () => reject(new Error("blocked"));
          });
          const storeNames = Array.from(db.objectStoreNames);
          for (const storeName of storeNames) {
            try {
              const tx = db.transaction(storeName, "readonly");
              const store = tx.objectStore(storeName);
              const count = await new Promise<number>((resolve, reject) => {
                const req = store.count();
                req.onsuccess = () => resolve(req.result);
                req.onerror = () => reject(req.error);
              });
              hashes.set(`${dbInfo.name}:${storeName}`, String(count));
            } catch {}
          }
          db.close();
        } catch {}
      }
    } catch {}
    return hashes;
  }

  async syncData(
    manual: boolean = false,
    _retryCount: number = 0,
  ): Promise<void> {
    if (!manual && (!this.isAuthenticated || this.isSyncing)) return;
    this.isSyncing = true;

    try {
      if (typeof window.wavesExportAllData !== "function") {
        if (_retryCount >= 3) {
          console.warn(
            "[cloudsync] wavesExportAllData not available after 3 retries, aborting sync",
          );
          this.isSyncing = false;
          this.updateStatus("sync skipped", "error");
          this.onSyncError();
          return;
        }
        console.warn(
          `[cloudsync] wavesExportAllData not available yet, retry ${_retryCount + 1}/3...`,
        );
        this.isSyncing = false;
        setTimeout(() => this.syncData(manual, _retryCount + 1), 2000);
        return;
      }

      this._deltaCount++;
      const shouldFullSync = this._deltaCount % DELTA_FULL_INTERVAL === 0;
      const dirtyKeyCount = this._dirtyKeys.size;

      let body: string;

      if (shouldFullSync || dirtyKeyCount === 0 || dirtyKeyCount > DELTA_MAX_KEYS) {
        const data = await window.wavesExportAllData();
        body = JSON.stringify(data);
      } else {
        const newIdbHashes = await this.computeIDBHashes();
        const delta: DeltaPayload = {
          _delta: true,
          localStorage: Object.fromEntries(this._dirtyKeys),
        };
        const changedDbs: Record<string, unknown> = {};
        let hasIdbChanges = false;

        for (const [key, hash] of newIdbHashes) {
          const oldHash = this._idbHashes.get(key);
          if (oldHash !== hash) {
            hasIdbChanges = true;
            const [dbName, storeName] = key.split(":");
            if (!dbName || !storeName) continue;
            if (!changedDbs[dbName]) changedDbs[dbName] = {};
          }
        }

        if (hasIdbChanges) {
          const fullData = await window.wavesExportAllData();
          const idbData = fullData.indexedDB || {};
          for (const dbName of Object.keys(changedDbs)) {
            if (idbData[dbName]) {
              changedDbs[dbName] = idbData[dbName];
            }
          }
          delta.indexedDB = changedDbs;
        }

        this._idbHashes = newIdbHashes;
        body = JSON.stringify(delta);
      }

      const res = await fetchWithTimeout(
        "/api/sync/upload",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body,
        },
        SYNC_TIMEOUT,
      );

      if (res.ok) {
        const result = await res.json();
        this.syncMeta.dirty = false;
        this.syncMeta.last_synced =
          result.updated_at ||
          new Date().toISOString().replace("T", " ").slice(0, 19);
        this.saveMeta();
        this._dirtyKeys.clear();

        this.updateStatus("synced", "success");
        this._uploadRetries = 0;
        this.onSyncSuccess();
      } else {
        console.warn("[cloudsync] upload failed:", res.status);
        if (
          (res.status === 429 || res.status >= 500) &&
          (!this._uploadRetries || this._uploadRetries < 3)
        ) {
          this._uploadRetries = (this._uploadRetries || 0) + 1;
          const delay = Math.min(
            2000 * Math.pow(2, this._uploadRetries - 1),
            8000,
          );
          console.warn(
            `[cloudsync] retrying upload in ${delay}ms (attempt ${this._uploadRetries}/3)`,
          );
          this.updateStatus("retrying sync...", "loading");
          this.isSyncing = false;
          setTimeout(() => this.syncData(manual, _retryCount), delay);
          return;
        }
        this._uploadRetries = 0;
        this.updateStatus("sync failed", "error");
        this.onSyncError();
      }
    } catch (err) {
      console.error("sync error!", err);
      if (!this._uploadRetries || this._uploadRetries < 3) {
        this._uploadRetries = (this._uploadRetries || 0) + 1;
        const delay = Math.min(
          2000 * Math.pow(2, this._uploadRetries - 1),
          8000,
        );
        console.warn(
          `[cloudsync] retrying upload in ${delay}ms (attempt ${this._uploadRetries}/3)`,
        );
        this.updateStatus("retrying sync...", "loading");
        this.isSyncing = false;
        setTimeout(() => this.syncData(manual, _retryCount), delay);
        return;
      }
      this._uploadRetries = 0;
      this.updateStatus("connection error", "error");
      this.onSyncError();
    } finally {
      this.isSyncing = false;
    }
  }

  async restoreData(
    silent: boolean = false,
    _retryCount: number = 0,
  ): Promise<void> {
    if (!this.isAuthenticated) return;
    if (this.isRestoring) return;
    if (!silent) this.updateStatus("restoring...", "loading");
    this.isRestoring = true;

    let restoreToast: ToastController | null = null;
    let reloading = false;

    if (!silent && window.showToast) {
      restoreToast = window.showToast("info", "restoring data...", "rotate", 0);
    }

    const maxRetries = 6;
    const jitter = (): number => Math.floor(Math.random() * 400);

    try {
      const res = await fetchWithTimeout("/api/sync/download", {}, SYNC_TIMEOUT);

      if (res.status === 429 || res.status >= 500) {
        if (_retryCount < maxRetries) {
          const delay =
            Math.min(1000 * Math.pow(2, _retryCount), 30000) + jitter();
          if (!silent) this.updateStatus("restore retrying...", "loading");
          console.warn(
            `[cloudsync] restore retry ${_retryCount + 1}/${maxRetries} after ${delay}ms (status ${res.status})`,
          );
          this.isRestoring = false;
          setTimeout(() => this.restoreData(silent, _retryCount + 1), delay);
          return;
        }
        if (!silent) this.updateStatus("server busy", "error");
        this.isRestoring = false;
        return;
      }

      if (!res.ok && res.status !== 404) {
        if (
          _retryCount < maxRetries &&
          res.status >= 400 &&
          res.status !== 401
        ) {
          const delay =
            Math.min(1000 * Math.pow(2, _retryCount), 30000) + jitter();
          if (!silent) this.updateStatus("restore retrying...", "loading");
          console.warn(
            `[cloudsync] restore retry ${_retryCount + 1}/${maxRetries} after ${delay}ms (status ${res.status})`,
          );
          this.isRestoring = false;
          setTimeout(() => this.restoreData(silent, _retryCount + 1), delay);
          return;
        }
        if (!silent) this.updateStatus("server error", "error");
        this.isRestoring = false;
        return;
      }

      const json = await res.json();

      if (res.ok && json.data) {
        if (typeof window.wavesImportDataFromObject === "function") {
          await window.wavesImportDataFromObject(
            json.data,
            (progressText: string) => {
              const loadingH1 =
                document.querySelector<HTMLElement>("#loading-screen h1");
              if (loadingH1) loadingH1.textContent = progressText;
            },
          );

          this.syncMeta.dirty = false;
          this.syncMeta.last_synced = json.updated_at;
          this.saveMeta();
          this._dirtyKeys.clear();

          if (!silent) {
            reloading = true;
            window.bypassPreventClosing = true;
            window.location.reload();
          } else {
            document.dispatchEvent(new CustomEvent("cloudsync-restored"));
            this.updateStatus("synced", "success");
          }
        }
      } else if (res.status === 404) {
        if (!silent) this.updateStatus("no data found", "success");
      }
    } catch (err) {
      console.error("restore error!", err);
      if (_retryCount < maxRetries) {
        const delay =
          Math.min(1000 * Math.pow(2, _retryCount), 30000) + jitter();
        if (!silent) this.updateStatus("restore retrying...", "loading");
        this.isRestoring = false;
        setTimeout(() => this.restoreData(silent, _retryCount + 1), delay);
        return;
      }
      if (!silent) this.updateStatus("restore failed", "error");
    } finally {
      this.isRestoring = false;
      if (restoreToast && !reloading) {
        restoreToast.hide();
      }
    }
  }

  async createAuthModal(): Promise<void> {
    if (document.getElementById("auth-modal")) return;

    const modal = document.createElement("div");
    modal.id = "auth-modal";
    modal.className = "popup";
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
                                save your password somewhere safe! all data will be forever lost if you forget your password ( \u2022\u032F\u0301 ^ \u2022\u0300)
                            </p>
                        </div>
                    </form>

                    <div style="margin-top: 15px; margin-bottom: -20px; font-size: 13px; color: var(--text-muted); text-align: center;" id="auth-switch-container">
                        <span id="auth-prompt-text">don't have an account?</span> <span id="auth-action-text" class="hover-link">create an account!</span>
                    </div>
                    <div id="auth-error" style="color: #ff5555; margin-top: 10px; font-size: 13px; min-height: 18px; text-align: center;"></div>
                </div>
                <div id="auth-logged-in" style="display: none; text-align: center;">
                    <p style="margin-bottom: 20px; font-size: 16px;">logged in as <span id="auth-user-display" style="color: var(--text-white);"></span></p>

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

  attachModalListeners(modal: HTMLElement): void {
    (modal.querySelector("#close-auth-modal") as HTMLElement).addEventListener(
      "click",
      () => this.toggleModal(),
    );
    const loginForm = modal.querySelector<HTMLFormElement>("#login-form")!;
    const regForm = modal.querySelector<HTMLFormElement>("#register-form")!;

    const regUsername = modal.querySelector<HTMLInputElement>("#reg-username")!;
    const regUsernameFeedback = modal.querySelector<HTMLElement>(
      "#reg-username-feedback",
    )!;
    const regPassword = modal.querySelector<HTMLInputElement>("#reg-password")!;
    const regPasswordFeedback = modal.querySelector<HTMLElement>(
      "#reg-password-feedback",
    )!;

    regUsername.addEventListener("input", () => {
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

    regPassword.addEventListener("input", () => {
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

    const promptText = modal.querySelector<HTMLElement>("#auth-prompt-text")!;
    const actionText = modal.querySelector<HTMLElement>("#auth-action-text")!;
    const authTitle = modal.querySelector<HTMLElement>("#auth-title")!;

    const loginUsername = modal.querySelector<HTMLInputElement>("#login-username")!;
    const loginPassword = modal.querySelector<HTMLInputElement>("#login-password")!;

    actionText.addEventListener("click", () => {
      const isLogin = loginForm.style.display !== "none";
      if (isLogin) {
        regUsername.value = loginUsername.value;
        regPassword.value = loginPassword.value;
        loginForm.style.display = "none";
        regForm.style.display = "block";
        authTitle.textContent = "create account";
        promptText.textContent = "already have an account?";
        actionText.textContent = "login!";
      } else {
        loginUsername.value = regUsername.value;
        loginPassword.value = regPassword.value;
        loginForm.style.display = "block";
        regForm.style.display = "none";
        authTitle.textContent = "login";
        promptText.textContent = "don't have an account?";
        actionText.textContent = "create an account!";
      }
      this.showError("");
    });

    loginForm.addEventListener("submit", (e) => this.handleLogin(e));
    regForm.addEventListener("submit", (e) => this.handleRegister(e));

    modal
      .querySelector<HTMLElement>("#logout-btn")!
      .addEventListener("click", () => this.logout());

    const deleteBtn = modal.querySelector<HTMLElement>("#delete-account-btn")!;
    deleteBtn.addEventListener("click", () => {
      void this.deleteAccount();
    });

    document.addEventListener("click", (e) => {
      const overlay = document.getElementById("overlay");
      if (overlay && e.target === overlay && modal.style.display === "flex") {
        this.toggleModal();
      }
    });

    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && modal.style.display === "flex") {
        this.toggleModal();
      }
    });

    const toggles = modal.querySelectorAll<HTMLElement>(".password-toggle");
    toggles.forEach((toggle) => {
      toggle.addEventListener("click", () => {
        const targetId = toggle.getAttribute("data-target");
        const input = document.getElementById(
          targetId!,
        ) as HTMLInputElement | null;
        if (!input) return;

        if (input.type === "password") {
          input.type = "text";
          toggle.classList.remove("fa-eye");
          toggle.classList.add("fa-eye-slash");
        } else {
          input.type = "password";
          toggle.classList.remove("fa-eye-slash");
          toggle.classList.add("fa-eye");
        }
      });
    });

  }

  async toggleModal(): Promise<void> {
    if (!document.getElementById("auth-modal")) {
      await this.createAuthModal();
    }

    const modal = document.getElementById("auth-modal") as HTMLElement;
    const overlay = document.getElementById("overlay") as HTMLElement;

    if (
      modal.style.display === "flex" &&
      !modal.classList.contains("fade-out-prompt")
    ) {
      modal.classList.remove("fade-in-prompt");
      modal.classList.add("fade-out-prompt");
      overlay.classList.remove("show");
      setTimeout(() => {
        modal.style.display = "none";
        modal.classList.remove("fade-out-prompt");
      }, 100);
    } else {
      modal.style.display = "flex";
      modal.classList.remove("fade-out-prompt");
      modal.classList.add("fade-in-prompt");
      overlay.classList.add("show");
    }
  }

  updateModalState(): void {
    const loggedInView = document.getElementById("auth-logged-in");
    const formsView = document.getElementById("auth-forms");
    const userDisplay = document.getElementById("auth-user-display");
    const authTitle = document.getElementById("auth-title");

    if (this.isAuthenticated) {
      if (loggedInView) loggedInView.style.display = "block";
      if (formsView) formsView.style.display = "none";
      if (userDisplay) userDisplay.textContent = this.user.username ?? "";
      if (authTitle) authTitle.textContent = "cloud sync";
    } else {
      if (loggedInView) loggedInView.style.display = "none";
      if (formsView) formsView.style.display = "block";
      if (authTitle) authTitle.textContent = "login";
    }

    const statusEl = document.querySelector<HTMLElement>("#auth-status");
    if (statusEl)
      statusEl.textContent = this.isAuthenticated
        ? (this.user.username ?? "")
        : "cloud sync";
  }

  updateStatus(text: string, cls?: string): void {
    const ind = document.getElementById("sync-status-indicator");

    const updateEl = (el: HTMLElement | null): void => {
      if (!el) return;
      if (this._lastStatusText === text && this._lastStatusType === cls) return;
      this._lastStatusText = text;
      this._lastStatusType = cls;

      if (cls === "loading") {
        el.innerHTML = `<i class="fa-solid fa-rotate" style="color: var(--text-white);"></i> ${text}`;
      } else if (cls === "error") {
        el.innerHTML = `<i class="fa-solid fa-triangle-exclamation" style="color: #ff5555;"></i> ${text}`;
      } else {
        el.innerHTML = `<i class="fa-solid fa-check" style="color: var(--text-white);"></i> ${text}`;
      }
    };

    updateEl(ind);
  }

  async handleLogin(e: Event): Promise<void> {
    e.preventDefault();
    const username = (
      document.getElementById("login-username") as HTMLInputElement
    ).value;
    const password = (
      document.getElementById("login-password") as HTMLInputElement
    ).value;

    let toastController: ToastController | null = null;
    if (window.showToast)
      toastController = window.showToast(
        "info",
        "logging in...",
        "right-to-bracket",
        0,
      );

    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ username, password }),
      });

      let data: Record<string, unknown>;
      try {
        data = await res.json();
      } catch {
        throw new Error(`server returned ${res.status}`);
      }

      if (res.ok) {
        if (toastController) toastController.hide();
        this.setSession(data as unknown as SessionData);
        this.toggleModal();
        await this.restoreData();
      } else {
        if (toastController) toastController.hide();
        const msg = (data.error as string) || "login failed!";
        if (window.showToast)
          window.showToast("error", msg, "warning");
        else this.showError(msg);
      }
    } catch (err) {
      if (toastController) toastController.hide();
      const msg = err instanceof Error ? err.message : "connection error!";
      if (window.showToast)
        window.showToast("error", msg, "warning");
      else this.showError(msg);
      console.error(err);
    }
  }

  async handleRegister(e: Event): Promise<void> {
    e.preventDefault();
    const username = (
      document.getElementById("reg-username") as HTMLInputElement
    ).value;
    const password = (
      document.getElementById("reg-password") as HTMLInputElement
    ).value;

    if (!username || !password) {
      if (window.showToast)
        window.showToast(
          "error",
          "please fill in both username and password!",
          "triangle-exclamation",
        );
      else this.showError("please fill in both fields!");
      return;
    }

    let toastController: ToastController | null = null;
    if (window.showToast)
      toastController = window.showToast(
        "info",
        "creating account...",
        "user-plus",
        0,
      );

    try {
      const res = await fetch("/api/auth/register", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ username, password }),
      });

      let data: Record<string, unknown>;
      try {
        data = await res.json();
      } catch {
        throw new Error(`server returned ${res.status}`);
      }

      if (res.ok) {
        if (toastController) toastController.hide();
        this.setSession(data as unknown as SessionData);
        this.toggleModal();
        this.syncMeta.dirty = true;
        this._dirtyKeys.clear();
        this.saveMeta();
        await this.syncData();
      } else {
        if (toastController) toastController.hide();
        const msg = (data.error as string) || "registration failed!";
        if (window.showToast)
          window.showToast("error", msg, "warning");
        else this.showError(msg);
      }
    } catch (err) {
      if (toastController) toastController.hide();
      const msg = err instanceof Error ? err.message : "connection error!";
      if (window.showToast)
        window.showToast("error", msg, "warning");
      else this.showError(msg);
    }
  }

  setSession(data: SessionData): void {
    this.isAuthenticated = true;
    this.user = data.user;
    localStorage.setItem("auth_user", JSON.stringify(this.user));
    this.updateModalState();
    this.startPolling();
  }

  async logout(): Promise<void> {
    if (window.showToast) {
      window.showToast("info", "confirm logout?", "sign-out-alt", [
        {
          text: "cancel",
          dismiss: true,
        },
        {
          text: "logout",
          class: "danger-btn",
          dismiss: true,
          callback: async () => {
            await this.performLogout();
          },
        },
      ]);
    } else {
      if (!confirm("confirm logout?")) return;
      void this.performLogout();
    }
  }

  async performLogout(): Promise<void> {
    let toastController: ToastController | null = null;
    if (window.showToast)
      toastController = window.showToast(
        "info",
        "logging out...",
        "right-from-bracket",
        0,
      );

    try {
      await fetch("/api/auth/logout", { method: "POST", credentials: "same-origin" });
    } catch (e) {
      console.warn("logout failed!", e);
    }

    if (toastController) toastController.hide();

    this.stopPolling();
    this.isAuthenticated = false;
    this.user = {};
    this._dirtyKeys.clear();
    localStorage.removeItem("auth_user");
    localStorage.removeItem("waves-sync-meta");

    await this.wipeLocalData();

    window.bypassPreventClosing = true;
    window.location.reload();
  }

  async deleteAccount(): Promise<void> {
    if (!this.isAuthenticated) return;

    if (window.showToast) {
      window.showToast("info", "confirm deletion?", "trash-alt", [
        {
          text: "cancel",
          dismiss: true,
        },
        {
          text: "delete",
          class: "danger-btn",
          dismiss: true,
          callback: async () => {
            await this.performDelete();
          },
        },
      ]);
    } else {
      if (
        confirm(
          "are you sure? this will delete your account and all synced data permanently.",
        )
      ) {
        void this.performDelete();
      }
    }
  }

  async performDelete(): Promise<void> {
    let toastController: ToastController | null = null;
    if (window.showToast)
      toastController = window.showToast(
        "info",
        "deleting account...",
        "trash-alt",
        0,
      );

    try {
      const res = await fetch("/api/auth/me", {
        method: "DELETE",
        credentials: "same-origin",
      });

      if (res.ok) {
        if (toastController) toastController.hide();
        this.stopPolling();
        this.isAuthenticated = false;
        this.user = {};
        this._dirtyKeys.clear();
        localStorage.removeItem("auth_user");
        localStorage.removeItem("waves-sync-meta");

        await this.wipeLocalData();

        window.bypassPreventClosing = true;
        window.location.reload();
      } else {
        if (toastController) toastController.hide();
        const data = await res.json();
        if (window.showToast)
          window.showToast(
            "error",
            data.error || "deletion failed!",
            "warning",
          );
        else
          alert("failed to delete account: " + (data.error || "unknown error"));
      }
    } catch (err) {
      if (toastController) toastController.hide();
      if (window.showToast)
        window.showToast("error", "deletion failed!", "warning");
      else alert("failed to delete account!");
    }
  }

  showError(msg: string): void {
    const el = document.getElementById("auth-error");
    if (el) {
      el.textContent = msg;
      setTimeout(() => (el.textContent = ""), 3000);
    }
  }

  async wipeLocalData(): Promise<void> {
    try {
      const preserveKeys = ["alertClosed", "wavesVisited", "wavesVersion"];

      const preservedData: Record<string, string> = {};
      preserveKeys.forEach((key) => {
        const val = localStorage.getItem(key);
        if (val !== null) preservedData[key] = val;
      });

      localStorage.clear();
      sessionStorage.clear();

      localStorage.removeItem("waves-bookmarks");
      const sourceKey = preservedData["gameSource"] || "selenite";
      sessionStorage.removeItem(`waves-game-cache${sourceKey}`);

      Object.keys(preservedData).forEach((key) => {
        localStorage.setItem(key, preservedData[key]!);
      });
    } catch (e) {
      console.error("[cloudsync] error during storage wipe:", e);
    }

    try {
      document.cookie.split(";").forEach((c) => {
        document.cookie = c
          .replace(/^ +/, "")
          .replace(/=.*/, "=;expires=" + new Date().toUTCString() + ";path=/");
      });
    } catch (e) {
      console.warn("cookie clear failed!", e);
    }

    if ("indexedDB" in window && typeof indexedDB.databases === "function") {
      try {
        const dbs = await indexedDB.databases();
        for (const dbInfo of dbs) {
          if (dbInfo.name) {
            indexedDB.deleteDatabase(
              dbInfo.name!,
            );
          }
        }
      } catch (e) {
        console.warn("[cloudsync] error wiping idb:", e);
      }
    }

    if ("serviceWorker" in navigator) {
      try {
        const registrations = await navigator.serviceWorker.getRegistrations();
        await Promise.all(registrations.map((r) => r.unregister()));
      } catch (e) {
        console.warn("[cloudsync] error unregistering service workers:", e);
      }
    }

    if ("caches" in window) {
      try {
        const keys = await caches.keys();
        await Promise.all(keys.map((k) => caches.delete(k)));
      } catch (e) {
        console.warn("[cloudsync] error clearing caches:", e);
      }
    }
  }
}

function initCloudSync(): void {
  void new CloudSync();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initCloudSync, {
    once: true,
  });
} else {
  initCloudSync();
}
