;(function () {
  const STATES = Object.freeze({
    IDLE: 'IDLE',
    CONNECTING: 'CONNECTING',
    CONNECTED: 'CONNECTED',
    FAILED: 'FAILED',
    RECONNECTING: 'RECONNECTING'
  });

  class WavesConnectionManager {
    constructor() {
      this.state = STATES.IDLE;
      this.appConfig = { backend: 'scramjet', transport: 'libcurl', customWispUrl: null };
      this.bareMuxConnection = null;
      this.currentWispUrl = '';
      this.healthCheckInterval = null;
      this.isInitialLoad = true;

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

    setState(newState) {
      if (!Object.values(STATES).includes(newState)) return;
      this.state = newState;
    }
    
    preFlightChecks() {
      if (!navigator.serviceWorker) {
        this.updateStatus("Fatal: Service Workers are not supported.", 'error');
        this.setState(STATES.FAILED);
        return false;
      }
      if (typeof BareMux !== 'object' || !BareMux.BareMuxConnection) {
        this.updateStatus("Fatal: BareMux library not found.", 'error');
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
        this.appConfig.transport = localStorage.getItem("transport") || "libcurl";
        this.appConfig.customWispUrl = localStorage.getItem("customWispUrl");
      } catch (e) {
        this.updateStatus('Could not access localStorage. Using defaults.', 'error');
      }
    }

    async unregisterAllServiceWorkers() {
      try {
        const registrations = await navigator.serviceWorker.getRegistrations();
        await Promise.all(registrations.map(reg => reg.unregister()));
      } catch (e) {
        this.updateStatus(`SW unregistration failed: ${e.message}`, 'error');
      }
    }

    async ensureWispServerConnection(url, timeout = 1500) {
      return new Promise((resolve, reject) => {
        let ws;
        try {
          ws = new WebSocket(url);
        } catch (e) {
          return reject(new Error("Invalid WebSocket URL."));
        }

        const connectionTimeout = setTimeout(() => {
          if (ws) ws.close();
          reject(new Error("Wisp connection timed out."));
        }, timeout);

        ws.onopen = () => {
          clearTimeout(connectionTimeout);
          ws.close();
          resolve();
        };
        ws.onerror = () => {
          clearTimeout(connectionTimeout);
          reject(new Error("Wisp connection failed."));
        };
      });
    }

    async initializeApp(isRetry = false) {
      if (this.state === STATES.CONNECTING && !isRetry) return;
      this.setState(isRetry ? STATES.RECONNECTING : STATES.CONNECTING);
      
      if(!isRetry) this.updateStatus('Connecting...', 'info');

      try {
        if (!this.bareMuxConnection) {
          this.bareMuxConnection = new BareMux.BareMuxConnection("/bmux/worker.js");
          window.WavesApp = window.WavesApp || {};
          window.WavesApp.bareMuxConnection = this.bareMuxConnection;
        }

        const defaultWispUrl = `${window.location.protocol === "https:" ? "wss" : "ws"}://${window.location.host}/w/`;
        this.currentWispUrl = this.appConfig.customWispUrl || defaultWispUrl;

        const scope = { 'ultraviolet': "/b/u/hi/", 'scramjet': "/b/s/" }[this.appConfig.backend];
        if (!scope) throw new Error(`Unknown backend: ${this.appConfig.backend}`);

        await navigator.serviceWorker.register("./b/sw.js", { scope });

        const transportMap = { epoxy: "/epoxy/index.mjs", libcurl: "/libcurl/index.mjs" };
        const transportModule = transportMap[this.appConfig.transport];
        if (!transportModule) throw new Error(`Unknown transport: ${this.appConfig.transport}`);
        
        this.bareMuxConnection.setTransport(transportModule, [{ wisp: this.currentWispUrl }]);

        const transportName = this.appConfig.transport.charAt(0).toUpperCase() + this.appConfig.transport.slice(1);
        this.updateStatus(`Successfully connected!`, 'success');
        this.setState(STATES.CONNECTED);
        this.isInitialLoad = false;

        const el = document.querySelector(".transport-selected");
        if (el) el.textContent = transportName;
        
        return true;

      } catch (error) {
        this.updateStatus(`Connection failed: ${error.message}`, 'error');
        console.error("Full error object:", error);
        await this.handleConnectionFailure();
        return false;
      }
    }
    
    async handleConnectionFailure(retryCount = 0) {
      this.setState(STATES.RECONNECTING);
      if (retryCount < 5) {
        const delay = Math.pow(2, retryCount) * 250;
        this.updateStatus(`Retrying in ${delay}ms...`, 'info');
        await new Promise(res => setTimeout(res, delay));
        await this.initializeApp(true);
      } else {
        this.updateStatus('Connection failed after multiple retries.', 'error');
        this.setState(STATES.FAILED);
      }
    }

    startHealthCheck() {
      if (this.healthCheckInterval) clearInterval(this.healthCheckInterval);
      let isChecking = false;
      this.healthCheckInterval = setInterval(async () => {
        if (isChecking || this.state === STATES.CONNECTING || this.state === STATES.RECONNECTING) return;
        
        if (window.WavesApp && window.WavesApp.isLoading) return; 

        if (this.state !== STATES.CONNECTED) return;
        
        isChecking = true;
        try {
            await this.ensureWispServerConnection(this.currentWispUrl, 2000);
        } catch (err) {
          this.updateStatus('Health check failed. Reconnecting...', 'error');
          await this.initializeApp();
        } finally {
          isChecking = false;
        }
      }, 15000);
    }
    
    setupEventListeners() {
      const reconnect = async (updateFn) => {
        if (this.state === STATES.CONNECTING || this.state === STATES.RECONNECTING) {
          this.updateStatus('Changes will apply after connection is established.', 'info');
          return;
        }

        await updateFn();
        
        const success = await this.initializeApp();
        
        if (success) {
            location.reload();
        }
      };
      
      window.addEventListener('online', () => {
        if (this.state !== STATES.CONNECTED && this.state !== STATES.CONNECTING && this.state !== STATES.RECONNECTING) {
          this.initializeApp();
        }
      });
      window.addEventListener('offline', () => this.updateStatus('Network offline.', 'error'));

      document.addEventListener("wispUrlUpdated", (e) => reconnect(async () => {
        this.appConfig.customWispUrl = e.detail;
      }));
      document.addEventListener("newTransport", (e) => reconnect(async () => {
        this.appConfig.transport = e.detail;
      }));
      document.addEventListener("backendUpdated", (e) => reconnect(async () => {
        this.appConfig.backend = e.detail;
      }));
    }
  }

  window.wavesConnection = new WavesConnectionManager();
})();