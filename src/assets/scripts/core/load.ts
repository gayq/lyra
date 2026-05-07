import { attachSearchLight } from "./searchLight.js";

declare global {
  interface Window {
    wavesUpdater: {
      successEl: HTMLElement | null;
      overlay: HTMLElement | null;
      closeBtn: HTMLElement | null;
      init(): void;
      showSuccess(): void;
      hideSuccess(calledByOther: boolean): void;
      performUpdate(): Promise<void>;
      checkVersion(): Promise<void>;
    };
    SharePromoter: {
      shareEl: HTMLElement | null;
      overlay: HTMLElement | null;
      closeBtn: HTMLElement | null;
      init(): void;
      showWarningPrompt(): boolean;
      hideWarningPrompt(calledByOther: boolean): void;
    };
    toggleSettingsMenu?: () => void;
    hideBookmarkPrompt?: (calledByOther: boolean) => void;
    __wavesUpdatePollerStarted?: boolean;
  }
}

type StuffResponse = {
  version: string;
  build?: string;
};

function parseStuffResponse(input: unknown): StuffResponse {
  if (!input || typeof input !== "object") {
    throw new Error("invalid /api/stuff response payload");
  }

  const payload = input as Record<string, unknown>;
  if (typeof payload.version !== "string" || payload.version.length === 0) {
    throw new Error("invalid /api/stuff response: version must be a non-empty string");
  }

  if (payload.build !== undefined && typeof payload.build !== "string") {
    throw new Error("invalid /api/stuff response: build must be a string when present");
  }

  const parsed: StuffResponse = { version: payload.version };
  if (typeof payload.build === "string") parsed.build = payload.build;
  return parsed;
}

try {
  if (
    localStorage.getItem("backend") !== "ultraviolet" &&
    typeof (window as unknown as Record<string, unknown>)[
      "$scramjetLoadController"
    ] === "function"
  ) {
    const controllerFactory = (
      (window as unknown as Record<string, unknown>)[
        "$scramjetLoadController"
      ] as () => Record<string, unknown>
    )();
    const ScramjetControllerRef = controllerFactory[
      "ScramjetController"
    ] as new (config: unknown) => { init(): Promise<void> };
    const scramjet = new ScramjetControllerRef({
      prefix: "/b/s/r/",
      files: {
        wasm: "/b/s/jetty.wasm.wasm",
        all: "/b/s/jetty.all.js",
        sync: "/b/s/jetty.sync.js",
      },
      flags: {
        sourcemaps: false,
        captureErrors: false,
        rewriterLogs: false,
        strictRewrites: false,
        destructureRewrites: false,
      },
    });
    (window as unknown as Record<string, unknown>)["scramjetReady"] =
      scramjet.init();
  } else {
    (window as unknown as Record<string, unknown>)["scramjetReady"] =
      Promise.resolve();
  }
} catch (e) {
  (window as unknown as Record<string, unknown>)["scramjetReady"] =
    Promise.resolve();
}

let _scrollShadowInitialized = false;
let _loadInitialized = false;

function setupScrollShadow(): void {
  if (_scrollShadowInitialized) return;
  _scrollShadowInitialized = true;
  const meow = document.querySelector(".meow");
  const threshold = 48;
  let raf: number | null = null;

  const readScrollTop = (): number =>
    Math.max(window.scrollY || 0, meow?.scrollTop || 0);

  const updateShadow = (): void => {
    raf = null;
    const isGamesView = document.body.classList.contains("games-view");
    const isWatchView = document.body.classList.contains("watch-view");
    const shouldShow =
      (isGamesView || isWatchView) && readScrollTop() > threshold;
    document.body.classList.toggle("has-scroll-shadow", shouldShow);
  };

  const requestUpdate = (): void => {
    if (raf) return;
    raf = requestAnimationFrame(updateShadow);
  };

  window.addEventListener("scroll", requestUpdate, { passive: true });
  meow?.addEventListener("scroll", requestUpdate, { passive: true });

  requestUpdate();
}

export function initializeLoad(): void {
  if (_loadInitialized) return;
  _loadInitialized = true;

  document
    .querySelectorAll<HTMLElement>(".search-bar")
    .forEach(attachSearchLight);
  setupScrollShadow();

  window.wavesUpdater = {
    successEl: null,
    overlay: document.getElementById("overlay"),
    closeBtn: null,
    init() {
      this.successEl = document.getElementById("updateSuccess");
      if (!this.successEl) {
        this.successEl = document.createElement("div");
        this.successEl.id = "updateSuccess";
        document.body.appendChild(this.successEl);
        this.successEl.innerHTML = `
            <i class="fa-solid fa-check-circle" style="font-size:40px;margin-bottom:15px;"></i>
            <label>successfully updated ฅ^>⩊<^ฅ</label>
            <p>if you don't see any changes or the site breaks, do Ctrl + Shift + R a few times.</p>
            <button class="prompt-close-btn" id="updateSuccessClose">okay!!</button>
          `;
      }
      this.closeBtn = document.getElementById("updateSuccessClose");

      this.closeBtn?.addEventListener("click", () => this.hideSuccess(false));
      if (localStorage.getItem("justUpdated") === "true") {
        localStorage.removeItem("justUpdated");
        this.showSuccess();
      }

      document.addEventListener("keydown", (e: KeyboardEvent) => {
        if (
          e.key === "Escape" &&
          this.successEl &&
          this.successEl.style.display === "block" &&
          !this.successEl.classList.contains("fade-out")
        ) {
          this.hideSuccess(false);
        }
      });
    },
    showSuccess() {
      this.overlay = document.getElementById("overlay");
      if (!this.successEl || !this.overlay) return;

      if (!this.overlay.dataset["wavesUpdateOverlayBound"]) {
        this.overlay.addEventListener("click", (e: MouseEvent) => {
          const activeOverlay = document.getElementById("overlay");
          if (!activeOverlay || e.target !== activeOverlay) return;
          if (document.getElementById("updateSuccess")?.style.display === "block") {
            window.wavesUpdater.hideSuccess(false);
          }
        });
        this.overlay.dataset["wavesUpdateOverlayBound"] = "true";
      }

      if (
        window.toggleSettingsMenu &&
        document.getElementById("settings-menu")?.classList.contains("open")
      ) {
        window.toggleSettingsMenu();
      }
      if (
        window.SharePromoter &&
        typeof window.SharePromoter.hideWarningPrompt === "function" &&
        document.getElementById("warningPrompt")?.style.display === "block"
      ) {
        window.SharePromoter.hideWarningPrompt(true);
      }
      if (
        window.hideBookmarkPrompt &&
        document.getElementById("bookmark-prompt")?.style.display === "block"
      ) {
        window.hideBookmarkPrompt(true);
      }

      this.overlay.classList.add("show");
      this.successEl.style.display = "block";
      this.successEl.classList.remove("fade-out");
    },
    hideSuccess(calledByOther: boolean) {
      if (!this.successEl || this.successEl.style.display === "none") return;

      this.successEl.classList.add("fade-out");
      this.successEl.addEventListener(
        "animationend",
        () => {
          this.successEl!.style.display = "none";
          this.successEl!.classList.remove("fade-out");

          if (calledByOther) return;

          this.overlay?.classList.remove("show");
        },
        { once: true },
      );
    },
    async performUpdate() {
      localStorage.setItem("justUpdated", "true");
      try {
        if ("serviceWorker" in navigator) {
          await Promise.all(
            (await navigator.serviceWorker.getRegistrations()).map((e) =>
              e.unregister(),
            ),
          );
        }
        if ("caches" in window) {
          await Promise.all((await caches.keys()).map((e) => caches.delete(e)));
        }
      } catch (e) {
        console.error("automatic update failed:", e);
        localStorage.removeItem("justUpdated");
      }
      location.reload();
    },
    async checkVersion() {
      try {
        const res = await fetch("/api/stuff", { cache: "no-store" });
        if (!res.ok) return;
        const { version, build } = parseStuffResponse(await res.json());
        const currentStamp = `${version}:${build || ""}`;
        const prevStamp = localStorage.getItem("wavesVersionStamp");
        const prev = localStorage.getItem("wavesVersion");
        localStorage.setItem("wavesVersion", version);
        localStorage.setItem("wavesVersionStamp", currentStamp);
        if (prevStamp && prevStamp !== currentStamp) {
          await this.performUpdate();
          return;
        }
        if (!prevStamp && prev && version !== prev) await this.performUpdate();
      } catch (e) {
        console.warn("version check failed:", e);
      }
    },
  };
  window.wavesUpdater.init();
  window.wavesUpdater.checkVersion();
  if (!window.__wavesUpdatePollerStarted) {
    window.__wavesUpdatePollerStarted = true;
    window.setInterval(() => {
      if (document.visibilityState === "visible") {
        void window.wavesUpdater.checkVersion();
      }
    }, 5 * 60 * 1000);
  }

  window.SharePromoter = {
    shareEl: null,
    overlay: null,
    closeBtn: null,
    init() {
      this.overlay = document.getElementById("overlay");
      this.shareEl = document.getElementById("warningPrompt");
      if (!this.shareEl) {
        this.shareEl = document.createElement("div");
        this.shareEl.id = "warningPrompt";
        this.shareEl.style.display = "none";
        document.body.appendChild(this.shareEl);
        this.shareEl.innerHTML = `
            <i class="fa-solid fa-triangle-exclamation" style="font-size:40px;margin-bottom:15px;"></i>
            <label>warning ( •̯́ ^ •̯̀)</label>
            <p>please close any new tabs that open up randomly; those are ads!</p>
            <button class="prompt-close-btn" id="warningPromptClose">okay!!</button>
          `;
      }
      this.closeBtn = document.getElementById("warningPromptClose");

      this.closeBtn?.addEventListener("click", () =>
        this.hideWarningPrompt(false),
      );

      const trigger = () => {
        const visited = localStorage.getItem("wavesWarningPromptSeen");
        if (!visited) {
          const shown = this.showWarningPrompt();
          if (shown) {
            localStorage.setItem("wavesWarningPromptSeen", "true");
            return;
          }

          let tries = 0;
          const maxTries = 20;
          const retryTimer = window.setInterval(() => {
            tries += 1;
            const retryShown = this.showWarningPrompt();
            if (retryShown) {
              localStorage.setItem("wavesWarningPromptSeen", "true");
              window.clearInterval(retryTimer);
              return;
            }
            if (tries >= maxTries) {
              window.clearInterval(retryTimer);
            }
          }, 120);
        } else {
          if (Math.random() < 0.1) {
            void this.showWarningPrompt();
          }
        }
      };

      trigger();

      document.addEventListener("keydown", (e: KeyboardEvent) => {
        if (
          e.key === "Escape" &&
          this.shareEl &&
          this.shareEl.style.display === "block" &&
          !this.shareEl.classList.contains("fade-out")
        ) {
          this.hideWarningPrompt(false);
        }
      });
    },
    showWarningPrompt() {
      if (!this.shareEl) return false;
      if (document.getElementById("root")) return false;
      if (!this.overlay) this.overlay = document.getElementById("overlay");
      if (!this.overlay) return false;

      if (!this.overlay.dataset["wavesShareOverlayBound"]) {
        this.overlay.addEventListener("click", (e: MouseEvent) => {
          const activeOverlay = document.getElementById("overlay");
          if (!activeOverlay || e.target !== activeOverlay) return;
          if (document.getElementById("warningPrompt")?.style.display === "block") {
            window.SharePromoter.hideWarningPrompt(false);
          }
        });
        this.overlay.dataset["wavesShareOverlayBound"] = "true";
      }

      {
        if (
          window.toggleSettingsMenu &&
          document.getElementById("settings-menu")?.classList.contains("open")
        ) {
          window.toggleSettingsMenu();
        }
        if (
          window.wavesUpdater &&
          typeof window.wavesUpdater.hideSuccess === "function" &&
          document.getElementById("updateSuccess")?.style.display === "block"
        ) {
          window.wavesUpdater.hideSuccess(true);
        }
        if (
          window.hideBookmarkPrompt &&
          document.getElementById("bookmark-prompt")?.style.display === "block"
        ) {
          window.hideBookmarkPrompt(true);
        }

        this.overlay?.classList.add("show");
        this.shareEl.style.display = "block";
        this.shareEl.classList.remove("fade-out");
        return true;
      }
    },
    hideWarningPrompt(calledByOther: boolean) {
      if (!this.shareEl || this.shareEl.style.display === "none") return;

      this.shareEl.classList.add("fade-out");
      this.shareEl.addEventListener(
        "animationend",
        () => {
          this.shareEl!.style.display = "none";
          this.shareEl!.classList.remove("fade-out");

          if (calledByOther) return;

          this.overlay?.classList.remove("show");
        },
        { once: true },
      );
    },
  };

  window.SharePromoter.init();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", () => initializeLoad(), {
    once: true,
  });
} else {
  initializeLoad();
}