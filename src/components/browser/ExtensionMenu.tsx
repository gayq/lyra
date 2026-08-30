import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import {
  EXTENSION_POPUP_MOUNTED_EVENT,
  getRivet,
} from "../../core/proxy/rivetBridge";
import { applyRivetAppearance } from "../../core/proxy/rivetAppearance";
import { NEGATIVE } from "../../core/runtime/messages.ts";
import { store } from "../../state/store.ts";
import {
  type InstalledExtensionSummary,
} from "../../../packages/rivet/src";
import { IconPuzzle } from "../icons";

interface ExtensionMenuProps {
  tabId: number | null;
}

export interface PopupSize {
  width: number;
  height: number;
}

export interface PopupPlacement extends PopupSize {
  left: number;
  top: number;
  anchorX: number;
}

type ObserverWindow = Window & {
  ResizeObserver?: typeof ResizeObserver;
  MutationObserver?: typeof MutationObserver;
};

const DEFAULT_POPUP_SIZE: PopupSize = { width: 320, height: 287 };
const DEFAULT_POPUP_PLACEMENT: PopupPlacement = {
  ...DEFAULT_POPUP_SIZE,
  left: 8,
  top: 52,
  anchorX: 24,
};
const MIN_POPUP_WIDTH = 260;
const MIN_POPUP_CONTENT_HEIGHT = 48;
const POPUP_EDGE_GAP = 8;
const POPUP_TRIGGER_GAP = 12;
const POPUP_INITIAL_SETTLE_DELAY = 80;
const POPUP_REVEAL_DEADLINE = 750;
const popupSizeCache = new Map<string, PopupSize>();

function cssPixels(value: string): number {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function measurePopup(frame: HTMLIFrameElement): PopupSize | null {
  const doc = frame.contentDocument;
  const root = doc?.documentElement;
  if (!doc || !root) return null;
  const body = doc.body;
  const bodyRect = body?.getBoundingClientRect();
  const bodyStyle = body ? frame.contentWindow?.getComputedStyle(body) : null;
  const horizontalMargins = bodyStyle
    ? Math.max(0, cssPixels(bodyStyle.marginLeft)) +
      Math.max(0, cssPixels(bodyStyle.marginRight))
    : 0;
  const verticalMargins = bodyStyle
    ? Math.max(0, cssPixels(bodyStyle.marginTop)) +
      Math.max(0, cssPixels(bodyStyle.marginBottom))
    : 0;
  const contentWidth = body
    ? Math.max(body.scrollWidth, body.offsetWidth, bodyRect?.width ?? 0) +
      horizontalMargins
    : root.offsetWidth;
  const contentHeight = body
    ? Math.max(body.scrollHeight, body.offsetHeight, bodyRect?.height ?? 0) +
      verticalMargins
    : root.offsetHeight;
  const maxWidth = Math.max(1, Math.min(800, window.innerWidth - 32));
  const maxHeight = Math.max(1, Math.min(647, window.innerHeight - 76));
  return {
    width: Math.min(
      maxWidth,
      Math.max(MIN_POPUP_WIDTH, Math.ceil(contentWidth)),
    ),
    height: Math.min(
      maxHeight,
      Math.max(MIN_POPUP_CONTENT_HEIGHT, Math.ceil(contentHeight)),
    ),
  };
}

function placePopup(
  trigger: HTMLButtonElement,
  size: PopupSize,
): PopupPlacement {
  const triggerRect = trigger.getBoundingClientRect();
  const width = Math.min(
    size.width,
    Math.max(1, window.innerWidth - POPUP_EDGE_GAP * 2),
  );
  const top = triggerRect.bottom + POPUP_TRIGGER_GAP;
  const height = Math.min(
    size.height,
    Math.max(1, window.innerHeight - top - POPUP_EDGE_GAP),
  );
  const centeredLeft = triggerRect.left + triggerRect.width / 2 - width / 2;
  const left = Math.min(
    Math.max(POPUP_EDGE_GAP, centeredLeft),
    Math.max(POPUP_EDGE_GAP, window.innerWidth - width - POPUP_EDGE_GAP),
  );
  const anchorX = Math.min(
    Math.max(16, triggerRect.left + triggerRect.width / 2 - left),
    width - 16,
  );
  return { width, height, left, top, anchorX };
}

export default function ExtensionMenu({ tabId }: ExtensionMenuProps) {
  const toolbarRef = useRef<HTMLDivElement>(null);
  const activeTriggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const popupRef = useRef<HTMLIFrameElement>(null);
  const [visible, setVisible] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [popupTabId, setPopupTabId] = useState<number | null>(null);
  const [extensions, setExtensions] = useState<InstalledExtensionSummary[]>([]);
  const [popupSize, setPopupSize] = useState<PopupSize>(DEFAULT_POPUP_SIZE);
  const [popupPlacement, setPopupPlacement] = useState<PopupPlacement>(
    DEFAULT_POPUP_PLACEMENT,
  );
  const [popupReady, setPopupReady] = useState(false);

  const requestClose = useCallback(() => {
    if (!visible) return;
    setVisible(false);
    setSelectedId(null);
    setPopupTabId(null);
    setPopupReady(false);
    requestAnimationFrame(() => activeTriggerRef.current?.focus());
  }, [visible]);

  useEffect(() => {
    let unsubscribe: (() => void) | undefined;
    const refresh = () => {
      const rivet = getRivet();
      if (!rivet) return;
      setExtensions(
        rivet.getInstalledExtensions().filter((extension) => extension.enabled),
      );
      unsubscribe ??= rivet.onChange(refresh);
    };
    refresh();
    window.addEventListener("rivet-ready", refresh);
    return () => {
      window.removeEventListener("rivet-ready", refresh);
      unsubscribe?.();
    };
  }, []);

  useEffect(() => {
    const closePopup = (event: Event) => {
      const extId = (event as CustomEvent<{ extId?: string }>).detail?.extId;
      if (extId && extId !== selectedId) return;
      requestClose();
    };
    window.addEventListener("rivet-close-extension-popup", closePopup);
    return () =>
      window.removeEventListener("rivet-close-extension-popup", closePopup);
  }, [requestClose, selectedId]);

  useEffect(() => {
    if (!visible || popupTabId !== tabId) return;
    const closeOutside = (event: PointerEvent) => {
      const target = event.target as Node;
      if (
        panelRef.current?.contains(target) ||
        toolbarRef.current?.contains(target)
      ) {
        return;
      }
      requestClose();
    };
    window.addEventListener("pointerdown", closeOutside);
    return () => window.removeEventListener("pointerdown", closeOutside);
  }, [popupTabId, requestClose, tabId, visible]);

  useEffect(() => {
    if (!visible || popupTabId !== tabId || popupTabId === null) return;
    const pageFrame = store.tabs.find((tab) => tab.id === popupTabId)?.iframe;
    if (!pageFrame) return;
    const closeFromPage = () => requestClose();
    pageFrame.addEventListener("iframe-focus", closeFromPage);
    return () => pageFrame.removeEventListener("iframe-focus", closeFromPage);
  }, [popupTabId, requestClose, tabId, visible]);

  useEffect(() => {
    if (!visible || popupTabId !== tabId) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") requestClose();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [popupTabId, requestClose, tabId, visible]);

  useEffect(() => {
    if (!visible || popupTabId !== tabId) return;
    const reposition = () => {
      const trigger = activeTriggerRef.current;
      if (trigger) setPopupPlacement(placePopup(trigger, popupSize));
    };
    reposition();
    window.addEventListener("resize", reposition);
    window.addEventListener("scroll", reposition, true);
    return () => {
      window.removeEventListener("resize", reposition);
      window.removeEventListener("scroll", reposition, true);
    };
  }, [popupSize, popupTabId, tabId, visible]);

  useEffect(() => {
    const frame = popupRef.current;
    const rivet = getRivet();
    if (!visible || popupTabId !== tabId || !selectedId || !frame || !rivet)
      return;
    let stopped = false;
    let popupHasSettled = false;
    let settleTimer = 0;
    let liveResizeFrame = 0;
    let revealTimer = 0;
    let resizeObserver: ResizeObserver | null = null;
    let mutationObserver: MutationObserver | null = null;
    let themeObserver: MutationObserver | null = null;
    let observedDocument: Document | null = null;
    const initialSize = popupSizeCache.get(selectedId) ?? DEFAULT_POPUP_SIZE;

    const commitMeasuredSize = (allowFallback = false) => {
      if (stopped) return;
      settleTimer = 0;
      const size = measurePopup(frame) ?? (allowFallback ? initialSize : null);
      if (!size) return;
      popupSizeCache.set(selectedId, size);
      setPopupSize((current) =>
        current.width === size.width && current.height === size.height
          ? current
          : size,
      );
      const trigger = activeTriggerRef.current;
      if (trigger) {
        const placement = placePopup(trigger, size);
        setPopupPlacement((current) =>
          current.width === placement.width &&
          current.height === placement.height &&
          current.left === placement.left &&
          current.top === placement.top &&
          current.anchorX === placement.anchorX
            ? current
            : placement,
        );
      }
      if (!popupHasSettled) {
        popupHasSettled = true;
        if (revealTimer) window.clearTimeout(revealTimer);
        revealTimer = 0;
        setPopupReady(true);
      }
    };
    const scheduleResize = () => {
      if (stopped) return;
      if (popupHasSettled) {
        if (liveResizeFrame) return;
        liveResizeFrame = window.requestAnimationFrame(() => {
          liveResizeFrame = 0;
          commitMeasuredSize();
        });
        return;
      }
      if (settleTimer) window.clearTimeout(settleTimer);
      settleTimer = window.setTimeout(
        commitMeasuredSize,
        POPUP_INITIAL_SETTLE_DELAY,
      );
    };

    setPopupReady(false);
    setPopupSize(initialSize);
    const trigger = activeTriggerRef.current;
    if (trigger) setPopupPlacement(placePopup(trigger, initialSize));
    const disconnectPopupObservers = () => {
      resizeObserver?.disconnect();
      mutationObserver?.disconnect();
      themeObserver?.disconnect();
      resizeObserver = null;
      mutationObserver = null;
      themeObserver = null;
    };
    const observePopup = () => {
      if (stopped) return;
      const doc = frame.contentDocument;
      if (!doc?.documentElement) return;
      if (doc === observedDocument) {
        scheduleResize();
        return;
      }
      disconnectPopupObservers();
      observedDocument = doc;
      const popupWindow = frame.contentWindow as ObserverWindow | null;
      const ResizeObserverCtor =
        popupWindow?.ResizeObserver ??
        (window as ObserverWindow).ResizeObserver;
      const MutationObserverCtor =
        popupWindow?.MutationObserver ??
        (window as ObserverWindow).MutationObserver;
      applyRivetAppearance(doc);
      if (typeof ResizeObserverCtor === "function") {
        resizeObserver = new ResizeObserverCtor(scheduleResize);
        resizeObserver.observe(doc.documentElement);
        if (doc.body) resizeObserver.observe(doc.body);
      }
      if (typeof MutationObserverCtor === "function") {
        mutationObserver = new MutationObserverCtor(scheduleResize);
        mutationObserver.observe(doc.documentElement, {
          attributes: true,
          childList: true,
          subtree: true,
        });
        themeObserver = new MutationObserverCtor(() =>
          applyRivetAppearance(doc),
        );
        themeObserver.observe(document.documentElement, {
          attributes: true,
          attributeFilter: ["data-theme", "data-motion"],
        });
      }
      if (popupHasSettled) commitMeasuredSize(true);
      else {
        scheduleResize();
        revealTimer = window.setTimeout(
          () => commitMeasuredSize(true),
          POPUP_REVEAL_DEADLINE,
        );
      }
      void doc.fonts?.ready.then(scheduleResize);
    };

    frame.addEventListener(EXTENSION_POPUP_MOUNTED_EVENT, observePopup);
    void rivet
      .mountExtensionPopup(frame, selectedId, tabId)
      .then((mounted) => {
        if (stopped) return;
        if (!mounted) {
          requestClose();
          return;
        }
        observePopup();
      })
      .catch((error) => {
        console.error("[rivet] failed to mount extension popup:", error, NEGATIVE);
        if (!stopped) requestClose();
      });

    return () => {
      stopped = true;
      frame.removeEventListener(EXTENSION_POPUP_MOUNTED_EVENT, observePopup);
      if (settleTimer) window.clearTimeout(settleTimer);
      if (liveResizeFrame) window.cancelAnimationFrame(liveResizeFrame);
      if (revealTimer) window.clearTimeout(revealTimer);
      disconnectPopupObservers();
      rivet.unmountExtensionPopup(selectedId, frame);
    };
  }, [visible, selectedId, popupTabId, requestClose, tabId]);

  useEffect(() => {
    if (visible && popupTabId !== tabId) requestClose();
  }, [popupTabId, requestClose, tabId, visible]);

  const selected =
    extensions.find((extension) => extension.id === selectedId) ?? null;

  useEffect(() => {
    if (visible && selectedId && !selected) requestClose();
  }, [requestClose, selected, selectedId, visible]);

  if (extensions.length === 0 && !visible) return null;

  return (
    <div class="rivet-toolbar" ref={toolbarRef}>
      {extensions.map((extension) => {
        const isOpen =
          visible && popupTabId === tabId && selectedId === extension.id;
        return (
          <button
            type="button"
            key={extension.id}
            class={`rivet-toolbar-trigger${isOpen ? " active" : ""}`}
            aria-expanded={extension.hasPopup ? isOpen : undefined}
            aria-haspopup={extension.hasPopup ? "dialog" : undefined}
            onClick={(event) => {
              activeTriggerRef.current = event.currentTarget;
              const rivet = getRivet();
              if (!extension.hasPopup) {
                rivet?.triggerActionClicked(extension.id, tabId);
                if (visible) requestClose();
                return;
              }
              if (isOpen) {
                requestClose();
                return;
              }
              const initialSize =
                popupSizeCache.get(extension.id) ?? DEFAULT_POPUP_SIZE;
              setSelectedId(extension.id);
              setPopupTabId(tabId);
              setPopupReady(false);
              setPopupSize(initialSize);
              setPopupPlacement(placePopup(event.currentTarget, initialSize));
              setVisible(true);
            }}
          >
            {extension.iconUrl ? (
              <img
                class="rivet-toolbar-extension-icon"
                src={extension.iconUrl}
                alt=""
              />
            ) : (
              <IconPuzzle />
            )}
            {extension.badgeText ? (
              <span class="rivet-toolbar-badge">{extension.badgeText}</span>
            ) : null}
          </button>
        );
      })}
      {visible && popupTabId === tabId && selected ? (
        <>
          <div
            class="rivet-popup-backdrop"
            aria-hidden="true"
            onPointerDown={(event) => {
              event.preventDefault();
              requestClose();
            }}
          />
          <div
            ref={panelRef}
            class={`rivet-toolbar-panel${popupReady ? "" : " measuring"}`}
            style={`width:${popupPlacement.width}px;height:${popupPlacement.height}px;left:${popupPlacement.left}px;top:${popupPlacement.top}px;--rivet-popup-anchor-x:${popupPlacement.anchorX}px`}
            role="dialog"
            aria-busy={!popupReady}
          >
            <iframe ref={popupRef} />
          </div>
        </>
      ) : null}
    </div>
  );
}
