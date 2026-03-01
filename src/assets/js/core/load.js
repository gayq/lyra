try {
  if (localStorage.getItem('backend') !== 'ultraviolet' && typeof window['$scramjetLoadController'] === 'function') {
    const controllerFactory = window['$scramjetLoadController']();
    const ScramjetControllerRef = controllerFactory['ScramjetController'];
    const scramjet = new ScramjetControllerRef({
      prefix: "/b/s/",
      files: {
        wasm: "/b/s/jetty.wasm.wasm",
        all: "/b/s/jetty.all.js",
        sync: "/b/s/jetty.sync.js"
      },
      flags: {
        rewriterLogs: true
      }
    });
    window.scramjetReady = scramjet.init();
  } else {
    window.scramjetReady = Promise.resolve();
  }
} catch (e) {
  window.scramjetReady = Promise.resolve();
}

export function attachSearchLight(searchBar) {
  if (!searchBar || searchBar.dataset.lightAttached === 'true') return;

  const lightBg = searchBar.querySelector('.light');
  const lightBorder = searchBar.querySelector('.light-border');
  if (!lightBg || !lightBorder) return;

  searchBar.dataset.lightAttached = 'true';
  const lightSize = 300;

  let targetX = 0, currentX = 0, lastX = 0, velocityX = 0;
  let targetY = 0, currentY = 0, lastY = 0, velocityY = 0;
  let raf = null;
  let rect = searchBar.getBoundingClientRect();
  let isHovering = false;
  let isSettled = false;
  let rectRaf = null;

  const updateRect = () => {
    rect = searchBar.getBoundingClientRect();
  };

  const scheduleRectUpdate = () => {
    if (rectRaf) return;
    rectRaf = requestAnimationFrame(() => {
      rectRaf = null;
      if (isHovering) updateRect();
    });
  };

  const setBgPosition = (x, y) => {
    lightBg.style.setProperty('--bg-x', x);
    lightBg.style.setProperty('--bg-y', y);
    lightBorder.style.setProperty('--bg-x', x);
    lightBorder.style.setProperty('--bg-y', y);
  };

  function animate() {
    const deltaX = targetX - currentX;
    const deltaY = targetY - currentY;

    currentX += deltaX * 0.15;
    currentY += deltaY * 0.15;

    const elasticX = Math.min(Math.max(velocityX * 0.5, -20), 20);
    const elasticY = Math.min(Math.max(velocityY * 0.5, -20), 20);

    if (Math.abs(deltaX) < 0.1 && Math.abs(deltaY) < 0.1 &&
      Math.abs(elasticX) < 0.1 && Math.abs(elasticY) < 0.1) {
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

  searchBar.addEventListener('mouseenter', () => {
    isHovering = true;
    updateRect();
    if (raf) cancelAnimationFrame(raf);
    isSettled = false;
    raf = requestAnimationFrame(animate);

    lightBg.style.opacity = 1;
    lightBorder.style.opacity = 1;
    lightBg.style.transition = "opacity 0.4s ease, transform 0.4s ease, filter 0.6s ease";
    lightBorder.style.transition = "opacity 0.4s ease, transform 0.4s ease, filter 0.6s ease";
    lightBg.style.filter = "blur(20px)";
    lightBorder.style.filter = "blur(6px)";

    setTimeout(() => {
      lightBg.style.transform = "scale(1)";
      lightBg.style.filter = "blur(12px)";
      lightBorder.style.transform = "scale(1)";
      lightBorder.style.filter = "blur(4px)";
    }, 300);
  });

  searchBar.addEventListener('mouseleave', () => {
    isHovering = false;
    if (raf) {
      cancelAnimationFrame(raf);
      raf = null;
    }
    lightBg.style.transition = "opacity 0.6s ease, transform 0.6s ease, filter 0.6s ease";
    lightBorder.style.transition = "opacity 0.6s ease, transform 0.6s ease, filter 0.6s ease";
    lightBg.style.opacity = 0;
    lightBorder.style.opacity = 0;
    lightBg.style.transform = "scale(0.95)";
    lightBorder.style.transform = "scale(0.95)";
    lightBg.style.filter = "blur(30px)";
    lightBorder.style.filter = "blur(12px)";
  });

  searchBar.addEventListener('mousemove', (e) => {
    targetX = (e.clientX - rect.left) - (lightSize / 2);
    targetY = (e.clientY - rect.top) - (lightSize / 2);

    velocityX = targetX - lastX;
    velocityY = targetY - lastY;
    lastX = targetX;
    lastY = targetY;

    const glowStrength = Math.min(1.2, 1.2 + (e.clientX - rect.left) / rect.width * 0.4);
    lightBg.style.transform = `scale(${glowStrength})`;

    if (isSettled && !raf) {
      isSettled = false;
      raf = requestAnimationFrame(animate);
    }
  });

  window.addEventListener('scroll', scheduleRectUpdate, { passive: true });
  window.addEventListener('resize', scheduleRectUpdate, { passive: true });
}

function setupScrollShadow() {
  const yay = document.querySelector('.yay');
  const threshold = 48;
  let raf = null;

  const readScrollTop = () => Math.max(window.scrollY || 0, yay?.scrollTop || 0);

  const updateShadow = () => {
    raf = null;
    const isGamesView = document.body.classList.contains('games-view');
    const isWatchView = document.body.classList.contains('watch-view');
    const shouldShow = (isGamesView || isWatchView) && readScrollTop() > threshold;
    document.body.classList.toggle('has-scroll-shadow', shouldShow);
  };

  const requestUpdate = () => {
    if (raf) return;
    raf = requestAnimationFrame(updateShadow);
  };

  window.addEventListener('scroll', requestUpdate, { passive: true });
  yay?.addEventListener('scroll', requestUpdate, { passive: true });

  requestUpdate();
}

export function initializeLoad() {
  document.querySelectorAll('.search-bar').forEach(attachSearchLight);
  setupScrollShadow();

  window.wavesUpdater = {
    successEl: null,
    overlay: document.getElementById("overlay"),
    closeBtn: null,
    init() {
      this.successEl = document.getElementById("updateSuccess");
      if (!this.successEl) {
        this.successEl = document.createElement('div');
        this.successEl.id = 'updateSuccess';
        document.body.appendChild(this.successEl);
        this.successEl.innerHTML = `
            <i class="fa-solid fa-check-circle" style="font-size:40px;margin-bottom:15px;"></i>
            <label>successfully updated ฅ^>⩊<^ฅ</label>
            <p>if you don’t see any changes or the site breaks, do Ctrl + Shift + R a few times.</p>
            <button class="prompt-close-btn" id="updateSuccessClose">okay!!</button>
          `;
      }
      this.closeBtn = document.getElementById("updateSuccessClose");

      this.closeBtn?.addEventListener('click', () => this.hideSuccess(false));
      this.overlay?.addEventListener('click', (e) => {
        if (e.target === this.overlay && this.successEl.style.display === "block") {
          this.hideSuccess(false);
        }
      });
      if (localStorage.getItem("justUpdated") === "true") {
        localStorage.removeItem("justUpdated");
        this.showSuccess();
      }

      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && this.successEl && this.successEl.style.display === 'block' && !this.successEl.classList.contains('fade-out')) {
          this.hideSuccess(false);
        }
      });
    },
    showSuccess() {
      if (this.successEl && this.overlay) {
        if (window.toggleSettingsMenu && document.getElementById('settings-menu')?.classList.contains('open')) {
          window.toggleSettingsMenu();
        }
        if (window.SharePromoter && typeof window.SharePromoter.hideWarningPrompt === 'function' && document.getElementById('warningPrompt')?.style.display === 'block') {
          window.SharePromoter.hideWarningPrompt(true);
        }
        if (window.hideBookmarkPrompt && document.getElementById('bookmark-prompt')?.style.display === 'block') {
          window.hideBookmarkPrompt(true);
        }

        this.overlay.classList.add("show");
        this.successEl.style.display = "block";
        this.successEl.classList.remove("fade-out");
      }
    },
    hideSuccess(calledByOther) {
      if (!this.successEl || this.successEl.style.display === 'none') return;

      this.successEl.classList.add("fade-out");
      this.successEl.addEventListener("animationend", () => {
        this.successEl.style.display = "none";
        this.successEl.classList.remove("fade-out");

        if (calledByOther) return;

        this.overlay.classList.remove("show");
      }, { once: true });
    },
    async performUpdate() {
      localStorage.setItem("justUpdated", "true");
      try {
        if ("serviceWorker" in navigator) {
          await Promise.all((await navigator.serviceWorker.getRegistrations()).map(e => e.unregister()));
        }
        if ("caches" in window) {
          await Promise.all((await caches.keys()).map(e => caches.delete(e)));
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
        const { version } = await res.json();
        const prev = localStorage.getItem("wavesVersion");
        localStorage.setItem("wavesVersion", version);
        if (prev && version !== prev) await this.performUpdate();
      } catch (e) {
        console.warn("version check failed:", e);
      }
    }
  };
  window.wavesUpdater.init();
  window.wavesUpdater.checkVersion();

  window.SharePromoter = {
    shareEl: null,
    overlay: document.getElementById("overlay"),
    closeBtn: null,
    init() {
      this.shareEl = document.getElementById("warningPrompt");
      if (!this.shareEl) {
        this.shareEl = document.createElement('div');
        this.shareEl.id = 'warningPrompt';
        this.shareEl.style.display = 'none';
        document.body.appendChild(this.shareEl);
        this.shareEl.innerHTML = `
            <i class="fa-solid fa-triangle-exclamation" style="font-size:40px;margin-bottom:15px;"></i>
            <label>warning ( •̯́ ^ •̯̀)</label>
            <p>please close any new tabs that open up randomly; those are ads.</p>
            <button class="prompt-close-btn" id="warningPromptClose">okay!!</button>
          `;
      }
      this.closeBtn = document.getElementById("warningPromptClose");

      this.closeBtn?.addEventListener('click', () => this.hideWarningPrompt(false));
      this.overlay?.addEventListener('click', (e) => {
        if (e.target === this.overlay && this.shareEl.style.display === "block") {
          this.hideWarningPrompt(false);
        }
      });

      const trigger = () => {
        const visited = localStorage.getItem("wavesVisited");
        if (!visited) {
          localStorage.setItem("wavesVisited", "true");
          this.showWarningPrompt();
        } else {
          if (Math.random() < 0.10) {
            this.showWarningPrompt();
          }
        }
      };

      trigger();

      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && this.shareEl && this.shareEl.style.display === 'block' && !this.shareEl.classList.contains('fade-out')) {
          this.hideWarningPrompt(false);
        }
      });
    },
    showWarningPrompt() {
      if (this.shareEl && this.overlay) {
        if (window.toggleSettingsMenu && document.getElementById('settings-menu')?.classList.contains('open')) {
          window.toggleSettingsMenu();
        }
        if (window.wavesUpdater && typeof window.wavesUpdater.hideSuccess === 'function' && document.getElementById('updateSuccess')?.style.display === 'block') {
          window.wavesUpdater.hideSuccess(true);
        }
        if (window.hideBookmarkPrompt && document.getElementById('bookmark-prompt')?.style.display === 'block') {
          window.hideBookmarkPrompt(true);
        }

        this.overlay.classList.add("show");
        this.shareEl.style.display = "block";
        this.shareEl.classList.remove("fade-out");
      }
    },
    hideWarningPrompt(calledByOther) {
      if (!this.shareEl || this.shareEl.style.display === 'none') return;

      this.shareEl.classList.add("fade-out");
      this.shareEl.addEventListener("animationend", () => {
        this.shareEl.style.display = "none";
        this.shareEl.classList.remove("fade-out");

        if (calledByOther) return;

        this.overlay.classList.remove("show");
      }, { once: true });
    }
  };

  const searchInput = document.getElementById('searchInput');
  const placeholders = [
    "have anything in mind?",
    "( • ̀ω•́ )✧",
    "join the discord server!",
    "1 update per year",
    "waves is such a good site!!"
  ];

  if (searchInput) {
    searchInput.placeholder = placeholders[Math.floor(Math.random() * placeholders.length)];
  }

  window.SharePromoter.init();
}