try {
  if (localStorage.getItem('backend') !== 'ultraviolet' && typeof window['$scramjetLoadController'] === 'function') {
    const controllerFactory = window['$scramjetLoadController']();
    const ScramjetControllerRef = controllerFactory['ScramjetController'];
    const scramjet = new ScramjetControllerRef({
      prefix: "/b/s/",
      files: {
        wasm: "/b/s/scramjet.wasm.wasm",
        all: "/b/s/scramjet.all.js",
        sync: "/b/s/scramjet.sync.js"
      },
      flags: {
        rewriterLogs: true
      }
    });
    window.scramjetReady = scramjet.init();
  } else {
    window.scramjetReady = Promise.resolve();
  }
} catch(e) {
    window.scramjetReady = Promise.resolve();
}

export function initializeLoad() {
  const searchBar = document.querySelector('.search-bar');
  
  if (searchBar) {
    const lightBg = searchBar.querySelector('.light');
    const lightBorder = searchBar.querySelector('.light-border');
    const lightSize = 400;

    let targetX = 0, currentX = 0, lastX = 0, velocityX = 0;
    let targetY = 0, currentY = 0, lastY = 0, velocityY = 0;
    let raf = null;
    let rect = searchBar.getBoundingClientRect();
    let isHovering = false;
    let isSettled = false;

    const updateRect = () => {
        if (isHovering) rect = searchBar.getBoundingClientRect();
    };

    window.addEventListener('scroll', updateRect, { passive: true });
    window.addEventListener('resize', updateRect, { passive: true });

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
          
          const finalBgX = `${targetX - lightSize / 2}px`;
          const finalBgY = `${targetY - lightSize / 2}px`;
          lightBg.style.setProperty('--bg-x', finalBgX);
          lightBg.style.setProperty('--bg-y', finalBgY);
          lightBorder.style.setProperty('--bg-x', finalBgX);
          lightBorder.style.setProperty('--bg-y', finalBgY);
          return;
      }

      const bgX = `${currentX - lightSize / 2 + elasticX}px`;
      const bgY = `${currentY - lightSize / 2 + elasticY}px`;

      lightBg.style.setProperty('--bg-x', bgX);
      lightBg.style.setProperty('--bg-y', bgY);
      lightBorder.style.setProperty('--bg-x', bgX);
      lightBorder.style.setProperty('--bg-y', bgY);

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
      targetX = e.clientX - rect.left;
      targetY = e.clientY - rect.top;
      
      velocityX = targetX - lastX;
      velocityY = targetY - lastY;
      lastX = targetX;
      lastY = targetY;

      const glowStrength = Math.min(1.2, 1.2 + targetX / rect.width * 0.4);
      lightBg.style.transform = `scale(${glowStrength})`;

      if (isSettled && !raf) {
          isSettled = false;
          raf = requestAnimationFrame(animate);
      }
    });
  }

  window.xinUpdater = {
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
            <label>Successfully Updated!</label>
            <p>If you don’t see any changes or the site breaks, do Ctrl + Shift + R a few times</p>
            <button class="prompt-close-btn" id="updateSuccessClose">Okay</button>
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
      this.checkVersion();

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
        if (window.SharePromoter && typeof window.SharePromoter.hideSharePrompt === 'function' && document.getElementById('sharePrompt')?.style.display === 'block') {
            window.SharePromoter.hideSharePrompt(true); 
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
        console.error("Automatic update failed:", e);
        localStorage.removeItem("justUpdated");
      }
      location.reload();
    },
    async checkVersion() {
      try {
        const res = await fetch("/api/version", { cache: "no-store" });
        if (!res.ok) return;
        const { version } = await res.json();
        this.versionEl && (this.versionEl.textContent = "Version " + version);
        const prev = localStorage.getItem("wVersion");
        localStorage.setItem("wVersion", version);
        if (prev && version !== prev) await this.performUpdate();
      } catch (e) {
        console.warn("Version check failed:", e);
      }
    }
  };
  window.xinUpdater.init();

  window.SharePromoter = {
    shareEl: null,
    overlay: document.getElementById("overlay"),
    closeBtn: null,
    init() {
      this.shareEl = document.getElementById("sharePrompt");
      if (!this.shareEl) {
          this.shareEl = document.createElement('div');
          this.shareEl.id = 'sharePrompt';
          this.shareEl.style.display = 'none';
          document.body.appendChild(this.shareEl);
          this.shareEl.innerHTML = `
            <i class="fa-solid fa-seedling" style="font-size:40px;margin-bottom:15px;"></i>
            <label>Help The Website Grow!</label>
            <p>Share this website with all your friends to help keep the traffic up and everything else running smoothly!</p>
            <button class="prompt-close-btn" id="sharePromptClose">Okay</button>
          `;
      }
      this.closeBtn = document.getElementById("sharePromptClose");

      this.closeBtn?.addEventListener('click', () => this.hideSharePrompt(false));
      this.overlay?.addEventListener('click', (e) => {
        if (e.target === this.overlay && this.shareEl.style.display === "block") {
          this.hideSharePrompt(false);
        }
      });
      
      const trigger = () => {
        const visited = localStorage.getItem("xinVisited");
        if (!visited) {
          localStorage.setItem("xinVisited", "true");
          this.showSharePrompt();
        } else {
          if (Math.random() < 0.10) { 
            this.showSharePrompt();
          }
        }
      };

      trigger();

      document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape' && this.shareEl && this.shareEl.style.display === 'block' && !this.shareEl.classList.contains('fade-out')) {
          this.hideSharePrompt(false);
        }
      });
    },
    showSharePrompt() {
      if (this.shareEl && this.overlay) {
        if (window.toggleSettingsMenu && document.getElementById('settings-menu')?.classList.contains('open')) {
            window.toggleSettingsMenu();
        }
        if (window.xinUpdater && typeof window.xinUpdater.hideSuccess === 'function' && document.getElementById('updateSuccess')?.style.display === 'block') {
            window.xinUpdater.hideSuccess(true);
        }
        if (window.hideBookmarkPrompt && document.getElementById('bookmark-prompt')?.style.display === 'block') {
            window.hideBookmarkPrompt(true);
        }

        this.overlay.classList.add("show");
        this.shareEl.style.display = "block";
        this.shareEl.classList.remove("fade-out");
      }
    },
    hideSharePrompt(calledByOther) {
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

  const phrasesElement = document.querySelector(".phrases");
  const phrases = ["hihihi", "<33", "Uhh....", "Xin chào!"];
  if (phrasesElement) {
    phrasesElement.textContent = phrases[Math.floor(Math.random() * phrases.length)];
  }

  const searchInput = document.getElementById('searchInput');
  const placeholders = [
      "Have anything in mind?",
      "(˶˃ ᵕ ˂˶)",
      "Join the Discord server!",
      "1 update per year",
      "Waves is such a good website!!"
  ];

  if (searchInput) {
      searchInput.placeholder = placeholders[Math.floor(Math.random() * placeholders.length)];
  }

  window.SharePromoter.init();
}