; (function () {
  const STATES = Object.freeze({
    IDLE: 'IDLE',
    CONNECTING: 'CONNECTING',
    CONNECTED: 'CONNECTED',
    FAILED: 'FAILED',
    RECONNECTING: 'RECONNECTING'
  });

  function createResolvablePromise() {
    let resolve, reject;
    const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
    promise._resolve = resolve;
    promise._reject = reject;
    promise._settled = false;
    const origResolve = resolve;
    const origReject = reject;
    promise._resolve = (...args) => { promise._settled = true; origResolve(...args); };
    promise._reject = (...args) => { promise._settled = true; origReject(...args); };
    return promise;
  }

  class WavesConnectionManager {
    constructor() {
      this.state = STATES.IDLE;
      this.appConfig = { backend: 'scramjet', transport: 'epoxy' };
      this.bareMuxConnection = null;
      this.currentWispUrl = '';
      this.healthCheckInterval = null;
      this.isInitialLoad = true;
      this._transportReadyPromise = createResolvablePromise();

      window.WavesApp = window.WavesApp || {};
      window.WavesApp.transportReady = this._transportReadyPromise;

      window.WavesApp.waitForTransport = (timeoutMs = 10000) => {
        return Promise.race([
          this._transportReadyPromise,
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('Transport setup timed out')), timeoutMs)
          )
        ]);
      };

      if (document.readyState === "complete" || document.readyState === "interactive") {
        this.start();
      } else {
        window.addEventListener("DOMContentLoaded", () => this.start());
      }
    }

    start() {
      if (!this.preFlightChecks()) return;
      this.loadConfig();
      this.initializeApp();
      this.startHealthCheck();
      this.setupEventListeners();
    }

    _resetTransportReady() {
      if (this._transportReadyPromise._settled) {
        this._transportReadyPromise = createResolvablePromise();
        window.WavesApp.transportReady = this._transportReadyPromise;
      }
    }

    _resolveTransportReady() {
      this._transportReadyPromise._resolve();
    }

    setState(newState) {
      if (!Object.values(STATES).includes(newState)) return;
      this.state = newState;
    }

    preFlightChecks() {
      if (!navigator.serviceWorker) {
        this.updateStatus("fatal: service workers are not supported.", 'error');
        this.setState(STATES.FAILED);
        return false;
      }
      if (typeof BareMux !== 'object' || !BareMux.BareMuxConnection) {
        this.updateStatus("fatal: baremux library not found.", 'error');
        this.setState(STATES.FAILED);
        return false;
      }
      return true;
    }

    updateStatus(message, type = 'info') {
      const statusEl = document.getElementById('connection-status');
      if (statusEl) {
        statusEl.textContent = message;
        statusEl.className = `status-${type}`;
      }
      const logMethod = type === 'error' ? console.error : console.log;
      if (type === 'error') logMethod(`Status: ${message}`);
    }

    loadConfig() {
      try {
        this.appConfig.backend = localStorage.getItem("backend") || "scramjet";
        this.appConfig.transport = localStorage.getItem("transport") || "epoxy";
      } catch (e) {
        this.updateStatus('Could not access localStorage. Using defaults.', 'error');
      }
    }

    async unregisterAllServiceWorkers() {
      try {
        const cacheNames = await caches.keys();
        await Promise.all(cacheNames.map(name => caches.delete(name)));

        const registrations = await navigator.serviceWorker.getRegistrations();
        for (const registration of registrations) {
          await registration.unregister();
        }

        if (navigator.serviceWorker.controller) {
        }
      } catch (e) {
        this.updateStatus(`sw unregistration failed: ${e.message}`, 'error');
      }
    }

    async ensureWispServerConnection(url, timeout = 1500) {
      return new Promise((resolve, reject) => {
        let ws;
        try {
          ws = new WebSocket(url);
        } catch (e) {
          return reject(new Error("invalid websocket url."));
        }

        const connectionTimeout = setTimeout(() => {
          if (ws) ws.close();
          reject(new Error("wisp connection timed out."));
        }, timeout);

        ws.onopen = () => {
          clearTimeout(connectionTimeout);
          ws.close();
          resolve();
        };
        ws.onerror = () => {
          clearTimeout(connectionTimeout);
          reject(new Error("wisp connection failed."));
        };
      });
    }

    async _verifyTransport() {
      if (!this.bareMuxConnection) return false;
      try {
        const name = await this.bareMuxConnection.getTransport();
        return !!(name && name.length > 0);
      } catch (e) {
        console.warn('transport verification failed:', e);
        return false;
      }
    }

    async _reapplyTransport() {
      if (!this.bareMuxConnection) return false;
      try {
        const transportMap = { epoxy: "/epoxy/index.mjs", libcurl: "/libcurl/index.mjs" };
        const transportModule = transportMap[this.appConfig.transport];
        if (!transportModule) return false;

        await this.bareMuxConnection.setTransport(transportModule, [{ wisp: this.currentWispUrl }]);

        const verified = await this._verifyTransport();
        if (verified) {
          this._resolveTransportReady();
          return true;
        }
        return false;
      } catch (e) {
        console.error('failed to re-apply transport:', e);
        return false;
      }
    }

    async initializeApp(isRetry = false) {
      if (this.state === STATES.CONNECTING && !isRetry) return;
      this.setState(isRetry ? STATES.RECONNECTING : STATES.CONNECTING);

      this._resetTransportReady();

      if (!isRetry) this.updateStatus('connecting...', 'info');

      try {
        if (!this.bareMuxConnection) {
          this.bareMuxConnection = new BareMux.BareMuxConnection("/bmux/worker.js");
          window.WavesApp.bareMuxConnection = this.bareMuxConnection;
        }

        const defaultWispUrl = `${window.location.protocol === "https:" ? "wss" : "ws"}://${window.location.host}/w/`;
        this.currentWispUrl = defaultWispUrl;

        const scope = { 'ultraviolet': "/b/u/hi/", 'scramjet': "/b/s/" }[this.appConfig.backend];
        if (!scope) throw new Error(`unknown backend: ${this.appConfig.backend}`);

        const registration = await navigator.serviceWorker.register("./b/sw.js", { scope });
        if (registration.installing) {
          const sw = registration.installing;
          await new Promise((resolve) => {
            sw.addEventListener('statechange', (e) => {
              if (e.target.state === 'activated') resolve();
            });
          });
        }

        const transportMap = { epoxy: "/epoxy/index.mjs", libcurl: "/libcurl/index.mjs" };
        const transportModule = transportMap[this.appConfig.transport];
        if (!transportModule) throw new Error(`unknown transport: ${this.appConfig.transport}`);

        await this.bareMuxConnection.setTransport(transportModule, [{ wisp: this.currentWispUrl }]);

        const transportVerified = await this._verifyTransport();
        if (!transportVerified) {
          throw new Error('transport was set but verification failed — SharedWorker may have lost state');
        }

        this._resolveTransportReady();

        this.updateStatus(`successfully connected!`, 'success');
        this.setState(STATES.CONNECTED);
        this.isInitialLoad = false;

        const el = document.querySelector(".transport-selected");
        if (el) el.textContent = this.appConfig.transport;

        return true;

      } catch (error) {
        this.updateStatus(`connection failed: ${error.message}`, 'error');
        console.error("full error object:", error);
        await this.handleConnectionFailure();
        return false;
      }
    }

    async handleConnectionFailure(retryCount = 0) {
      this.setState(STATES.RECONNECTING);
      if (retryCount < 8) {
        const delay = Math.min(Math.pow(2, retryCount) * 500, 30000);
        this.updateStatus(`retrying in ${delay}ms...`, 'info');
        await new Promise(res => setTimeout(res, delay));
        await this.initializeApp(true);
      } else {
        this.updateStatus('connection failed after multiple retries.', 'error');
        this.setState(STATES.FAILED);
      }
    }

    startHealthCheck() {
      if (this.healthCheckInterval) clearInterval(this.healthCheckInterval);
      let isChecking = false;
      this.healthCheckInterval = setInterval(async () => {
        if (document.hidden) return;
        if (isChecking || this.state === STATES.CONNECTING || this.state === STATES.RECONNECTING) return;

        if (window.WavesApp && window.WavesApp.isLoading) return;

        if (this.state !== STATES.CONNECTED) return;

        isChecking = true;
        try {
          await this.ensureWispServerConnection(this.currentWispUrl, 3000);

          const transportAlive = await this._verifyTransport();
          if (!transportAlive) {
            console.warn('health check: transport lost in SharedWorker, re-applying...');
            this._resetTransportReady();
            const recovered = await this._reapplyTransport();
            if (!recovered) {
              this.updateStatus('transport lost. reconnecting...', 'error');
              await this.initializeApp();
            } else {
              console.log('health check: transport recovered successfully');
            }
          }
        } catch (err) {
          this.updateStatus('health check failed. reconnecting...', 'error');
          await this.initializeApp();
        } finally {
          isChecking = false;
        }
      }, 30000);
    }

    setupEventListeners() {
      const applyLiveChanges = async (updateFn) => {
        if (this.state === STATES.CONNECTING || this.state === STATES.RECONNECTING) return;

        this.updateStatus('switching engine...', 'info');
        this._resetTransportReady();

        await updateFn();
        await this.unregisterAllServiceWorkers();
        await new Promise(res => setTimeout(res, 800));

        const success = await this.initializeApp();

        if (success) {
          this.updateStatus('switched successfully!', 'success');
        }
      };

      window.addEventListener('online', () => {
        if (this.state !== STATES.CONNECTED && this.state !== STATES.CONNECTING && this.state !== STATES.RECONNECTING) {
          this.initializeApp();
        }
      });
      window.addEventListener('offline', () => this.updateStatus('network offline.', 'error'));

      document.addEventListener("newTransport", (e) => applyLiveChanges(async () => {
        this.appConfig.transport = e.detail;
      }));
      document.addEventListener("backendUpdated", (e) => applyLiveChanges(async () => {
        this.appConfig.backend = e.detail;
      }));
    }
  }

  window.wavesConnection = new WavesConnectionManager();
})();