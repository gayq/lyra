import {
  cancelExtensionPageMount,
  extensionPageReloadTarget,
  mountExtensionPage,
} from "./pageMount";
import type { RivetRegistry } from "./registry";
import type { RivetHostBindings } from "./types";

export const EXTENSION_POPUP_MOUNTED_EVENT = "rivet-extension-popup-mounted";

interface PopupRecoveryState {
  beforeUnloadListener: (() => void) | null;
  beforeUnloadWindow: Window | null;
  cancelled: boolean;
  currentPage: string;
  loadListener: (() => void) | null;
  mountVersion: number;
}

const popupRecoveryStates = new WeakMap<
  HTMLIFrameElement,
  PopupRecoveryState
>();

function removePopupRecoveryListeners(
  frame: HTMLIFrameElement,
  state: PopupRecoveryState,
): void {
  if (state.loadListener) {
    frame.removeEventListener("load", state.loadListener);
    state.loadListener = null;
  }
  if (state.beforeUnloadWindow && state.beforeUnloadListener) {
    state.beforeUnloadWindow.removeEventListener(
      "beforeunload",
      state.beforeUnloadListener,
    );
  }
  state.beforeUnloadWindow = null;
  state.beforeUnloadListener = null;
}

function abandonPopupRecovery(frame: HTMLIFrameElement): void {
  const state = popupRecoveryStates.get(frame);
  if (!state) return;
  state.cancelled = true;
  removePopupRecoveryListeners(frame, state);
  popupRecoveryStates.delete(frame);
}

function resolvePopupPage(
  registry: RivetRegistry,
  extId: string,
): string | null {
  const ext = registry.get(extId);
  if (!ext) return null;
  const manifest = ext.manifest;
  return (
    ext.popupPage ??
    manifest.action?.default_popup ??
    manifest.browser_action?.default_popup ??
    manifest.page_action?.default_popup ??
    null
  );
}

export function getExtensionPopupPage(
  registry: RivetRegistry,
  extId: string,
): string | null {
  return resolvePopupPage(registry, extId);
}

export async function mountExtensionPopup(
  frame: HTMLIFrameElement,
  extId: string,
  tabId: number | null,
  registry: RivetRegistry,
  host: RivetHostBindings,
): Promise<boolean> {
  abandonPopupRecovery(frame);
  const popupPage = resolvePopupPage(registry, extId);
  if (!popupPage) return false;

  const state: PopupRecoveryState = {
    beforeUnloadListener: null,
    beforeUnloadWindow: null,
    cancelled: false,
    currentPage: popupPage,
    loadListener: null,
    mountVersion: 0,
  };
  popupRecoveryStates.set(frame, state);

  const isCurrent = () =>
    !state.cancelled && popupRecoveryStates.get(frame) === state;

  const mountPage = async (
    page: string,
    recovering = false,
  ): Promise<boolean> => {
    removePopupRecoveryListeners(frame, state);
    state.currentPage = page;
    const mountVersion = ++state.mountVersion;
    const isMountCurrent = () =>
      isCurrent() && state.mountVersion === mountVersion;
    const mounted = await mountExtensionPage(
      frame,
      extId,
      page,
      tabId,
      registry,
      host,
      true,
    );
    if (!mounted || !isMountCurrent()) {
      if (recovering && isMountCurrent()) frame.style.visibility = "";
      return false;
    }

    const popupWindow = frame.contentWindow;
    state.beforeUnloadWindow = popupWindow;
    state.beforeUnloadListener = () => {
      if (isCurrent()) frame.style.visibility = "hidden";
    };
    popupWindow?.addEventListener("beforeunload", state.beforeUnloadListener);

    state.loadListener = () => {
      if (!isCurrent()) return;
      let currentUrl = "";
      try {
        currentUrl = frame.contentWindow?.location.href ?? "";
      } catch {}
      const reloadTarget = extensionPageReloadTarget(
        state.currentPage,
        currentUrl,
        globalThis.location.origin,
        extId,
      );
      if (!reloadTarget) {
        frame.style.visibility = "";
        return;
      }
      frame.style.visibility = "hidden";
      void mountPage(reloadTarget, true);
    };
    frame.addEventListener("load", state.loadListener);
    frame.dispatchEvent(new Event(EXTENSION_POPUP_MOUNTED_EVENT));
    if (recovering) {
      requestAnimationFrame(() => {
        if (isMountCurrent()) frame.style.visibility = "";
      });
    }
    return true;
  };

  return mountPage(popupPage);
}

export function cancelExtensionPopupMount(frame: HTMLIFrameElement): void {
  abandonPopupRecovery(frame);
  frame.style.visibility = "";
  cancelExtensionPageMount(frame);
}
