import { render } from "preact";
import App from "./App.tsx";
import { store } from "./state/store.ts";
import { initUiSignals } from "./core/uiSignals";
import { initClickParticles } from "./core/particles.ts";
import "../css/themes.css";
import "../css/index.css";
import "../css/tabs.css";

window.__wavesStuffData = fetch("/api/stuff", { cache: "no-store" })
  .then((res) => (res.ok ? res.json() : null))
  .catch(() => null);

let cloudSyncLoadPromise: Promise<void> | null = null;
let cloudSyncReady = false;

function ensureCloudSyncLoaded() {
  if (cloudSyncReady) return Promise.resolve();
  if (cloudSyncLoadPromise) return cloudSyncLoadPromise;

  cloudSyncLoadPromise = Promise.all([
    import("../css/cloudsync.css"),
    import("./features/cloudsync.ts"),
  ])
    .then(() => {
      cloudSyncReady = true;
    })
    .catch((error) => {
      cloudSyncLoadPromise = null;
      throw error;
    });

  return cloudSyncLoadPromise;
}

function shouldPreloadCloudSync() {
  try {
    const raw = localStorage.getItem("auth_user");
    if (!raw) return false;
    const user = JSON.parse(raw);
    return typeof user?.username === "string" && user.username.length > 0;
  } catch {
    return false;
  }
}

function scheduleIdleLoad(callback: () => void) {
  if (typeof window.requestIdleCallback === "function") {
    const idleId = window.requestIdleCallback(callback, { timeout: 1500 });
    return () => window.cancelIdleCallback(idleId);
  }
  const timeoutId = window.setTimeout(callback, 250);
  return () => window.clearTimeout(timeoutId);
}

document.addEventListener("DOMContentLoaded", () => {
  initUiSignals();
  initClickParticles();
  store.setupWindowWavesApp();

  document.addEventListener(
    "toggleAuthModal",
    (event: Event) => {
      if (cloudSyncReady) return;

      event.stopImmediatePropagation();
      void ensureCloudSyncLoaded()
        .then(() => {
          document.dispatchEvent(new CustomEvent("toggleAuthModal"));
        })
        .catch((error) => {
          console.error("failed to load cloud sync module", error);
        });
    },
    true,
  );

  const meow = document.querySelector<HTMLElement>(".meow");
  if (meow) {
    render(<App />, meow);
  }

  requestAnimationFrame(() => {
    window.dispatchEvent(new Event("styles-ready"));

    void import("../css/settings.css");
    void import("../css/games.css");
    void import("../css/bookmarks.css");
    void import("../css/newtab.css");
    void import("../css/toast.css");
    void import("./core/register.ts");
    void import("./core/load.ts").then((module) => {
      module.initializeLoad();
    });
    void import("./features/settings.ts");
    void import("./features/toast.ts");
  });

  scheduleIdleLoad(() => {
    if (!shouldPreloadCloudSync()) return;
    void ensureCloudSyncLoaded();
  });

  const onSwMessage = (e: MessageEvent) => store.handleServiceWorkerMessage(e);
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.addEventListener("message", onSwMessage);
  }
  window.addEventListener("message", onSwMessage);

  store.initSplitResize();

  document.addEventListener("gameSourceUpdated", () => {
    store.allGames.length = 0;
  });

  store.addTab(null, "fetching data...");
  store.updateIframeView();
});