import { render } from "preact";
import App from "./App.tsx";
import { store } from "../state/store.ts";
import { initUiSignals } from "../core/ui/uiSignals";
import { scheduleIdleTask } from "../core/runtime/scheduler.ts";
import { initCloaking } from "../features/cloaking.ts";
import "../features/cloudsync/syncBoundary.ts";
import { resolveTheme } from "../core/config/settingsOptions.ts";
import {
  applyMotionPreference,
  readAdvancedToggle,
  readMotionPreference,
} from "../core/config/advancedSettings.ts";
import { loadCloudSync } from "./loaders.ts";
import { warmProxyRuntime } from "../core/proxy/proxyRuntime.ts";
import "../assets/styles/base/themes.css";
import "../assets/styles/base/index.css";
import "../assets/styles/browser/tabs.css";
import "../assets/styles/browser/rivet.css";

const recoveryUrl = new URL(window.location.href);
if (recoveryUrl.searchParams.has("lyra-recovery")) {
  recoveryUrl.searchParams.delete("lyra-recovery");
  history.replaceState(history.state, "", recoveryUrl.href);
}

const savedTheme = resolveTheme(localStorage.getItem("theme"));
if (savedTheme === "default") {
  document.documentElement.removeAttribute("data-theme");
} else {
  document.documentElement.setAttribute("data-theme", savedTheme);
}

applyMotionPreference(readMotionPreference());

window.__lyraStuffData = fetch("/api/stuff", { cache: "no-store" })
  .then((response) => (response.ok ? response.json() : null))
  .then((serviceMetadata) => {
    if (serviceMetadata?.turn) {
      (
        window as typeof window & { __LYRA_WEBRTC_TURN__?: unknown }
      ).__LYRA_WEBRTC_TURN__ = serviceMetadata.turn;
    }
    return serviceMetadata;
  })
  .catch(() => null);

let cloudSyncLoadPromise: Promise<void> | null = null;
let cloudSyncReady = false;

function ensureCloudSyncLoaded() {
  if (cloudSyncReady) return Promise.resolve();
  if (cloudSyncLoadPromise) return cloudSyncLoadPromise;

  cloudSyncLoadPromise = loadCloudSync()
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

function initializeLyraApp() {
  const runtimeWindow = window as typeof window & {
    __lyraAppInitialized?: boolean;
  };
  const appRoot = document.querySelector<HTMLElement>(".meow");
  if (
    !appRoot ||
    runtimeWindow.__lyraAppInitialized ||
    appRoot.dataset.lyraAppInitialized === "true"
  ) {
    return;
  }
  runtimeWindow.__lyraAppInitialized = true;
  appRoot.dataset.lyraAppInitialized = "true";

  initUiSignals();
  initCloaking();
  store.setupWindowLyra();

  document.addEventListener(
    "toggleCloudSyncModal",
    (event: Event) => {
      if (cloudSyncReady) return;

      event.stopImmediatePropagation();
      void ensureCloudSyncLoaded()
        .then(() => {
          document.dispatchEvent(new CustomEvent("toggleCloudSyncModal"));
        })
        .catch((error) => {
          console.error(
            "failed to load cloud sync module:",
            error,
            "... /ᐠ - ˕ -マ",
          );
        });
    },
    true,
  );

  render(<App />, appRoot);

  requestAnimationFrame(() => {
    void import("../assets/styles/toast/toast.css");
    void import("../features/ui/toast.ts");
  });

  scheduleIdleTask(() => {
    void import("../core/runtime/load.ts").then((module) => {
      module.initializeLoad();
    });
  }, 1000);

  scheduleIdleTask(() => {
    if (!shouldPreloadCloudSync()) return;
    void ensureCloudSyncLoaded();
  }, 1500);

  scheduleIdleTask(() => {
    if (readAdvancedToggle("preloadProxy")) warmProxyRuntime();
  }, 750);

  const onSwMessage = (e: MessageEvent) => store.handleServiceWorkerMessage(e);
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.addEventListener("message", onSwMessage);
  }
  window.addEventListener("message", onSwMessage);

  store.initSplitResize();

  document.addEventListener("gameSourceUpdated", () => {
    store.allGames.length = 0;
  });

  store.addTab(null, "fetching data...", false, null, {
    applyNewTabOverride: false,
  });
  store.updateIframeView();
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initializeLyraApp, {
    once: true,
  });
} else {
  initializeLyraApp();
}
