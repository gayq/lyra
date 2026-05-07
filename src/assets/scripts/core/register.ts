type ConnectionState =
  | "IDLE"
  | "CONNECTING"
  | "CONNECTED"
  | "FAILED"
  | "RECONNECTING";

interface AppConfig {
  backend: string;
  transport: string;
}

interface ResolvablePromise<T = void> extends Promise<T> {
  _resolve: (value: T | PromiseLike<T>) => void;
  _reject: (reason?: unknown) => void;
  _settled: boolean;
}

interface BareMuxConnectionInstance {
  getTransport(): Promise<string>;
  setTransport(module: string, options: Array<{ wisp: string }>): Promise<void>;
}

declare global {
  interface Window {
    wavesConnection: WavesConnectionManager;
    BareMux?: {
      BareMuxConnection: new (path: string) => BareMuxConnectionInstance;
    };
  }
}

declare const BareMux: Window["BareMux"];

const STATES = Object.freeze({
  IDLE: "IDLE",
  CONNECTING: "CONNECTING",
  CONNECTED: "CONNECTED",
  FAILED: "FAILED",
  RECONNECTING: "RECONNECTING",
} as const);

const TRANSPORT_MAP: Record<string, string> = {
  epoxy: "/epoxy/index.mjs",
  libcurl: "/libcurl/index.mjs",
};

const SCOPE_MAP: Record<string, string> = {
  ultraviolet: "/b/u/r/",
  scramjet: "/b/s/r/",
};

function createResolvablePromise<T = void>(): ResolvablePromise<T> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  }) as ResolvablePromise<T>;
  promise._settled = false;
  promise._resolve = (value: T | PromiseLike<T>) => {
    promise._settled = true;
    resolve(value);
  };
  promise._reject = (reason?: unknown) => {
    promise._settled = true;
    reject(reason);
  };
  return promise;
}

class WavesConnectionManager {
  state: ConnectionState;
  appConfig: AppConfig;
  bareMuxConnection: BareMuxConnectionInstance | null;
  currentWispUrl: string;
  healthCheckInterval: ReturnType<typeof setInterval> | null;
  isInitialLoad: boolean;
  _transportReadyPromise: ResolvablePromise;
  _retryCount: number;
  _isRecovering: boolean;
  _tabWasHiddenWhileConnected: boolean;

  constructor() {
    this.state = STATES.IDLE;
    this.appConfig = { backend: "scramjet", transport: "epoxy" };
    this.bareMuxConnection = null;
    this.currentWispUrl = "";
    this.healthCheckInterval = null;
    this.isInitialLoad = true;
    this._transportReadyPromise = createResolvablePromise();
    this._retryCount = 0;
    this._isRecovering = false;
    this._tabWasHiddenWhileConnected = false;

    const app = ((window as unknown as Record<string, unknown>)["WavesApp"] ??= {}) as typeof window.WavesApp;
    app.transportReady = this._transportReadyPromise;

    app.waitForTransport = async (timeoutMs = 10000) => {
      if (this._transportReadyPromise._settled && this.state !== STATES.CONNECTED) {
        this._resetTransportReady();
      } else if (this._transportReadyPromise._settled && this.state === STATES.CONNECTED) {
        const verified = await this._verifyTransport();
        if (!verified) {
          this._resetTransportReady();
          await this.recoverOnWake({ forceReapply: true });
        }
      }
      return Promise.race([
        this._transportReadyPromise,
        new Promise<void>((_, reject) =>
          setTimeout(() => reject(new Error("transport setup timed out")), timeoutMs),
        ),
      ]);
    };

    if (document.readyState === "complete" || document.readyState === "interactive") {
      this.start();
    } else {
      window.addEventListener("DOMContentLoaded", () => this.start());
    }
  }

  start(): void {
    if (!this.preFlightChecks()) return;
    this.loadConfig();
    this.initializeApp();
    this.startHealthCheck();
    this.setupEventListeners();
  }

  _resetTransportReady(): void {
    if (this._transportReadyPromise._settled) {
      this._transportReadyPromise = createResolvablePromise();
      window.WavesApp.transportReady = this._transportReadyPromise;
    }
  }

  _resolveTransportReady(): void {
    this._transportReadyPromise._resolve(undefined);
  }

  setState(newState: ConnectionState): void {
    if (!Object.values(STATES).includes(newState)) return;
    this.state = newState;
  }

  preFlightChecks(): boolean {
    if (!navigator.serviceWorker) {
      this.updateStatus("fatal: service workers are not supported!", "error");
      this.setState(STATES.FAILED);
      return false;
    }
    if (typeof BareMux !== "object" || !BareMux.BareMuxConnection) {
      this.updateStatus("fatal: baremux library not found!", "error");
      this.setState(STATES.FAILED);
      return false;
    }
    return true;
  }

  updateStatus(message: string, type: string = "info"): void {
    const statusEl = document.getElementById("connection-status");
    if (statusEl) {
      statusEl.textContent = message;
      statusEl.className = `status-${type}`;
    }
    if (type === "error") {
      console.error(`Status: ${message}`);
    }
  }

  loadConfig(): void {
    try {
      this.appConfig.backend = localStorage.getItem("backend") || "scramjet";
      this.appConfig.transport = localStorage.getItem("transport") || "epoxy";
    } catch {
      this.updateStatus("could not access localStorage! using defaults...", "error");
    }
  }

  async unregisterAllServiceWorkers(): Promise<void> {
    try {
      const cacheNames = await caches.keys();
      await Promise.all(cacheNames.map((name) => caches.delete(name)));

      const registrations = await navigator.serviceWorker.getRegistrations();
      for (const registration of registrations) {
        await registration.unregister();
      }
    } catch (e) {
      this.updateStatus(`sw unregistration failed: ${(e as Error).message}`, "error");
    }
  }

  async ensureWispServerConnection(url: string, timeout: number = 1500): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      let ws: WebSocket | undefined;
      try {
        ws = new WebSocket(url);
      } catch {
        return reject(new Error("invalid websocket url!"));
      }

      const connectionTimeout = setTimeout(() => {
        ws?.close();
        reject(new Error("wisp connection timed out!"));
      }, timeout);

      ws.onopen = () => {
        clearTimeout(connectionTimeout);
        ws!.close();
        resolve();
      };
      ws.onerror = () => {
        clearTimeout(connectionTimeout);
        reject(new Error("wisp connection failed!"));
      };
    });
  }

  async _verifyTransport(): Promise<boolean> {
    if (!this.bareMuxConnection) return false;
    try {
      const name = await Promise.race([
        this.bareMuxConnection.getTransport(),
        new Promise<string>((_, reject) =>
          setTimeout(() => reject(new Error("transport verify timed out!")), 4000),
        ),
      ]);
      return name.length > 0;
    } catch (e) {
      console.warn("transport verification failed:", e);
      return false;
    }
  }

  async _reapplyTransport(): Promise<boolean> {
    if (!this.bareMuxConnection) return false;
    try {
      const transportModule = TRANSPORT_MAP[this.appConfig.transport];
      if (!transportModule) return false;

      await this.bareMuxConnection.setTransport(transportModule, [
        { wisp: this.currentWispUrl },
      ]);

      const verified = await this._verifyTransport();
      if (verified) {
        this._resolveTransportReady();
        return true;
      }
      return false;
    } catch (e) {
      console.error("failed to re-apply transport:", e);
      return false;
    }
  }

  async initializeApp(isRetry: boolean = false): Promise<boolean | undefined> {
    if (this.state === STATES.CONNECTING && !isRetry) return;
    this.setState(isRetry ? STATES.RECONNECTING : STATES.CONNECTING);

    this._resetTransportReady();

    if (!isRetry) this.updateStatus("connecting...", "info");

    try {
      if (!this.bareMuxConnection) {
        this.bareMuxConnection = new BareMux!.BareMuxConnection("/bmux/worker.js");
        window.WavesApp.bareMuxConnection = this.bareMuxConnection;
      }

      const protocol = window.location.protocol === "https:" ? "wss" : "ws";
      this.currentWispUrl = `${protocol}://${window.location.host}/w/`;

      await this.ensureWispServerConnection(this.currentWispUrl, 5000);

      const scope = SCOPE_MAP[this.appConfig.backend];
      if (!scope) throw new Error(`unknown backend: ${this.appConfig.backend}`);

      const registration = await navigator.serviceWorker.register("./b/sw.js", { scope });
      const pendingSw = registration.installing || registration.waiting;
      if (pendingSw && pendingSw.state !== "activated") {
        await new Promise<void>((resolve) => {
          const onStateChange = (e: Event) => {
            if ((e.target as ServiceWorker | null)?.state === "activated") {
              pendingSw.removeEventListener("statechange", onStateChange);
              resolve();
            }
          };
          pendingSw.addEventListener("statechange", onStateChange);
          setTimeout(resolve, 8000);
        });
      }

      const transportModule = TRANSPORT_MAP[this.appConfig.transport];
      if (!transportModule) throw new Error(`unknown transport: ${this.appConfig.transport}`);

      await this.bareMuxConnection.setTransport(transportModule, [
        { wisp: this.currentWispUrl },
      ]);

      const transportVerified = await this._verifyTransport();
      if (!transportVerified) {
        throw new Error("transport was set but verification failed");
      }

      this._resolveTransportReady();
      this.updateStatus("successfully connected!", "success");
      this.setState(STATES.CONNECTED);
      this._retryCount = 0;
      this.isInitialLoad = false;

      const el = document.querySelector(".transport-selected");
      if (el) el.textContent = this.appConfig.transport;

      return true;
    } catch (error) {
      this.updateStatus(`connection failed: ${(error as Error).message}`, "error");
      console.error("full error object:", error);
      await this.handleConnectionFailure();
      return false;
    }
  }

  async handleConnectionFailure(): Promise<void> {
    this.setState(STATES.RECONNECTING);
    if (this._retryCount < 10) {
      const delay = Math.min(Math.pow(2, this._retryCount) * 500, 15000);
      this._retryCount++;
      this.updateStatus(`retrying in ${delay / 1000}s... (attempt ${this._retryCount}/10)`, "info");
      await new Promise<void>((res) => setTimeout(res, delay));
      await this.initializeApp(true);
    } else {
      this.updateStatus("connection failed after multiple retries!", "error");
      this.setState(STATES.FAILED);
      this._retryCount = 0;
    }
  }

  startHealthCheck(): void {
    if (this.healthCheckInterval) clearInterval(this.healthCheckInterval);
    let isChecking = false;
    this.healthCheckInterval = setInterval(async () => {
      if (document.hidden) return;
      if (
        isChecking ||
        this._isRecovering ||
        this.state === STATES.CONNECTING ||
        this.state === STATES.RECONNECTING
      )
        return;

      if (window.WavesApp?.isLoading) return;
      if (this.state !== STATES.CONNECTED) return;

      isChecking = true;
      try {
        await this.ensureWispServerConnection(this.currentWispUrl, 3000);

        const transportAlive = await this._verifyTransport();
        if (!transportAlive) {
          console.warn("health check: transport lost in sharedWorker, re-applying...");
          this._resetTransportReady();
          const recovered = await this._reapplyTransport();
          if (!recovered) {
            this.updateStatus("transport lost. reconnecting...", "error");
            await this.initializeApp();
          } else {
            console.log("health check: transport recovered successfully!");
          }
        }
      } catch {
        this.updateStatus("health check failed. reconnecting...", "error");
        await this.initializeApp();
      } finally {
        isChecking = false;
      }
    }, 8000);
  }

  async recoverOnWake(options?: { forceReapply?: boolean }): Promise<void> {
    if (
      this._isRecovering ||
      this.state === STATES.CONNECTING ||
      this.state === STATES.RECONNECTING
    )
      return;

    if (this.state === STATES.IDLE) return;
    if (!navigator.onLine) return;

    const forceReapply = options?.forceReapply === true;

    this._isRecovering = true;
    try {
      await this.ensureWispServerConnection(this.currentWispUrl, 3000);

      if (forceReapply && this.state === STATES.CONNECTED && this.bareMuxConnection) {
        this._resetTransportReady();
        const reapplied = await this._reapplyTransport();
        if (reapplied) {
          this.setState(STATES.CONNECTED);
          this.updateStatus("successfully connected!", "success");
          return;
        }
        console.warn("wake recovery: re-apply failed after resume, full re-init");
        this._retryCount = 0;
        await this.initializeApp(true);
        return;
      }

      const alive = await this._verifyTransport();
      if (alive) {
        if (!this._transportReadyPromise._settled) {
          this._resolveTransportReady();
        }
        if (this.state !== STATES.CONNECTED) {
          this.setState(STATES.CONNECTED);
          this.updateStatus("successfully connected!", "success");
        }
        return;
      }

      console.warn("wake recovery: transport dead, re-applying...");
      this._resetTransportReady();
      const recovered = await this._reapplyTransport();
      if (recovered) {
        console.log("wake recovery: transport recovered via re-apply");
        this.setState(STATES.CONNECTED);
        return;
      }

      console.warn("wake recovery: full re-init required");
      this._retryCount = 0;
      await this.initializeApp(true);
    } catch (err) {
      console.warn("wake recovery: wisp unreachable, full re-init", err);
      this._retryCount = 0;
      this._resetTransportReady();
      await this.initializeApp(true);
    } finally {
      this._isRecovering = false;
    }
  }

  setupEventListeners(): void {
    window.addEventListener("message", (ev: MessageEvent) => {
      if (ev.origin !== window.location.origin) return;
      const data = ev.data as { type?: string; url?: string } | null;
      if (!data || data.type !== "waves-prefetch-bridge") return;
      if (typeof data.url !== "string") return;
      try {
        const u = new URL(data.url);
        if (u.origin !== window.location.origin) return;
        if (!u.pathname.startsWith("/b/s/") && !u.pathname.startsWith("/b/u/")) return;
      } catch {
        return;
      }
      const ctrl = navigator.serviceWorker.controller;
      if (!ctrl) return;
      try {
        ctrl.postMessage({ type: "waves-prefetch", url: data.url });
      } catch (e) {
        console.warn("failed to postMessage to service worker:", e);
      }
    });

    const applyLiveChanges = async (updateFn: () => Promise<void>): Promise<void> => {
      if (this.state === STATES.CONNECTING || this.state === STATES.RECONNECTING) return;

      this.updateStatus("switching engine...", "info");
      this._resetTransportReady();

      await updateFn();
      await this.unregisterAllServiceWorkers();
      await new Promise<void>((res) => setTimeout(res, 800));

      const success = await this.initializeApp();
      if (success) {
        this.updateStatus("switched successfully!", "success");
      }
    };

    window.addEventListener("online", () => {
      this._retryCount = 0;
      if (
        this.state !== STATES.CONNECTED &&
        this.state !== STATES.CONNECTING &&
        this.state !== STATES.RECONNECTING
      ) {
        this.initializeApp();
      } else if (this.state === STATES.CONNECTED) {
        this._resetTransportReady();
        void this.recoverOnWake({ forceReapply: true });
      }
    });

    window.addEventListener("offline", () => {
      this.updateStatus("network offline!", "error");
      this.setState(STATES.FAILED);
      this._resetTransportReady();
    });

    document.addEventListener("visibilitychange", () => {
      if (document.hidden) {
        this._tabWasHiddenWhileConnected = this.state === STATES.CONNECTED;
      } else {
        const resumeFromHidden = this._tabWasHiddenWhileConnected;
        this._tabWasHiddenWhileConnected = false;
        if (resumeFromHidden && this.state === STATES.CONNECTED) {
          this._resetTransportReady();
        }
        setTimeout(
          () => void this.recoverOnWake(resumeFromHidden ? { forceReapply: true } : undefined),
          0,
        );
      }
    });

    window.addEventListener("pageshow", (ev: PageTransitionEvent) => {
      if (!ev.persisted) return;
      if (this.state !== STATES.CONNECTED) return;
      this._resetTransportReady();
      void this.recoverOnWake({ forceReapply: true });
    });

    if (navigator.serviceWorker) {
      navigator.serviceWorker.addEventListener("message", (event: MessageEvent) => {
        const data = event.data as { type?: string; failures?: number } | null;
        if (data?.type !== "transport-error") return;
        if (this.state !== STATES.CONNECTED) return;

        const failures = data.failures ?? 1;
        console.warn(`transport error reported by service worker (${failures} consecutive failures), recovering...`);
        this._resetTransportReady();
        this._reapplyTransport().then((recovered) => {
          if (!recovered && failures >= 3) {
            console.warn("multiple consecutive failures, full reconnect...");
            this.initializeApp();
          }
        });
      });
    }

    document.addEventListener("newTransport", (e) =>
      applyLiveChanges(async () => {
        this.appConfig.transport = (e as CustomEvent<string>).detail;
      }),
    );
    document.addEventListener("backendUpdated", (e) =>
      applyLiveChanges(async () => {
        this.appConfig.backend = (e as CustomEvent<string>).detail;
      }),
    );
  }
}

window.wavesConnection = new WavesConnectionManager();
export {};