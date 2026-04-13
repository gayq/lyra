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
      prefix: "/b/s/",
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

export function attachSearchLight(searchBar: HTMLElement): void {
  if (!searchBar || searchBar.dataset["lightAttached"] === "true") return;

  const lightBg = searchBar.querySelector(".light") as HTMLElement | null;
  const lightBorder = searchBar.querySelector(
    ".light-border",
  ) as HTMLElement | null;
  if (!lightBg || !lightBorder) return;

  searchBar.dataset["lightAttached"] = "true";
  const lightSize = 300;

  let targetX: number = 0,
    currentX: number = 0,
    lastX: number = 0,
    velocityX: number = 0;
  let targetY: number = 0,
    currentY: number = 0,
    lastY: number = 0,
    velocityY: number = 0;
  let raf: number | null = null;
  let rect: DOMRect = searchBar.getBoundingClientRect();
  let isHovering: boolean = false;
  let isSettled: boolean = false;
  let rectRaf: number | null = null;

  const updateRect = (): void => {
    rect = searchBar.getBoundingClientRect();
  };

  const scheduleRectUpdate = (): void => {
    if (rectRaf) return;
    rectRaf = requestAnimationFrame(() => {
      rectRaf = null;
      if (isHovering) updateRect();
    });
  };

  const setBgPosition = (x: string, y: string): void => {
    lightBg.style.setProperty("--bg-x", x);
    lightBg.style.setProperty("--bg-y", y);
    lightBorder.style.setProperty("--bg-x", x);
    lightBorder.style.setProperty("--bg-y", y);
  };

  function animate(): void {
    const deltaX = targetX - currentX;
    const deltaY = targetY - currentY;

    currentX += deltaX * 0.15;
    currentY += deltaY * 0.15;

    const elasticX = Math.min(Math.max(velocityX * 0.5, -20), 20);
    const elasticY = Math.min(Math.max(velocityY * 0.5, -20), 20);

    if (
      Math.abs(deltaX) < 0.1 &&
      Math.abs(deltaY) < 0.1 &&
      Math.abs(elasticX) < 0.1 &&
      Math.abs(elasticY) < 0.1
    ) {
      isSettled = true;
      raf = null;

      const finalBgX = `${targetX}px`;
      const finalBgY = `${targetY}px`;

      setBgPosition(finalBgX, finalBgY);
      return;
    }

    const bgX = `${currentX + elasticX}px`;
    const bgY = `${currentY + elasticY}px`;

    setBgPosition(bgX, bgY);

    raf = requestAnimationFrame(animate);
  }

  searchBar.addEventListener("mouseenter", () => {
    isHovering = true;
    updateRect();
    if (raf) cancelAnimationFrame(raf);
    isSettled = false;
    raf = requestAnimationFrame(animate);

    lightBg.style.opacity = "1";
    lightBorder.style.opacity = "1";
    lightBg.style.transition =
      "opacity 0.4s ease, transform 0.4s ease, filter 0.6s ease";
    lightBorder.style.transition =
      "opacity 0.4s ease, transform 0.4s ease, filter 0.6s ease";
    lightBg.style.filter = "blur(20px)";
    lightBorder.style.filter = "blur(6px)";

    setTimeout(() => {
      lightBg.style.transform = "scale(1)";
      lightBg.style.filter = "blur(12px)";
      lightBorder.style.transform = "scale(1)";
      lightBorder.style.filter = "blur(4px)";
    }, 300);
  });

  searchBar.addEventListener("mouseleave", () => {
    isHovering = false;
    if (raf) {
      cancelAnimationFrame(raf);
      raf = null;
    }
    lightBg.style.transition =
      "opacity 0.6s ease, transform 0.6s ease, filter 0.6s ease";
    lightBorder.style.transition =
      "opacity 0.6s ease, transform 0.6s ease, filter 0.6s ease";
    lightBg.style.opacity = "0";
    lightBorder.style.opacity = "0";
    lightBg.style.transform = "scale(0.95)";
    lightBorder.style.transform = "scale(0.95)";
    lightBg.style.filter = "blur(30px)";
    lightBorder.style.filter = "blur(12px)";
  });

  searchBar.addEventListener("mousemove", (e: MouseEvent) => {
    targetX = e.clientX - rect.left - lightSize / 2;
    targetY = e.clientY - rect.top - lightSize / 2;

    velocityX = targetX - lastX;
    velocityY = targetY - lastY;
    lastX = targetX;
    lastY = targetY;

    const glowStrength = Math.min(
      1.2,
      1.2 + ((e.clientX - rect.left) / rect.width) * 0.4,
    );
    lightBg.style.transform = `scale(${glowStrength})`;

    if (isSettled && !raf) {
      isSettled = false;
      raf = requestAnimationFrame(animate);
    }
  });

  window.addEventListener("scroll", scheduleRectUpdate, { passive: true });
  window.addEventListener("resize", scheduleRectUpdate, { passive: true });
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
      if (document.getElementById("ixl-cloak")) return false;
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