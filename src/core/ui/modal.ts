import { useCallback, useEffect, useLayoutEffect, useRef } from "preact/hooks";
import { hideOverlay, showOverlay } from "./overlay.ts";

const MODAL_VISIBLE_CLASS = "modal-visible";
const MODAL_CLOSING_CLASS = "modal-closing";
const MODAL_MOTION_CLASS = "modal-motion-paused";

let modalMotionUsers = 0;

interface ManagedModalOptions {
  visible: boolean;
  isClosing: boolean;
  onRequestClose: () => void;
  onCloseComplete?: () => void;
  closeOnEscape?: boolean;
  closeOnOverlay?: boolean;
  useOverlay?: boolean;
}

interface DomModalOptions {
  useOverlay?: boolean;
  onCloseComplete?: () => void;
}

function releaseOverlay(
  overlayBoundRef: { current: boolean },
  useOverlay: boolean,
): void {
  if (!useOverlay || !overlayBoundRef.current) return;
  hideOverlay();
  overlayBoundRef.current = false;
}

function holdModalMotion(boundRef: { current: boolean }): void {
  if (boundRef.current) return;
  modalMotionUsers += 1;
  boundRef.current = true;
  document.documentElement.classList.add(MODAL_MOTION_CLASS);
}

function releaseModalMotion(boundRef: { current: boolean }): void {
  if (!boundRef.current) return;
  modalMotionUsers = Math.max(0, modalMotionUsers - 1);
  boundRef.current = false;
  if (modalMotionUsers === 0) {
    document.documentElement.classList.remove(MODAL_MOTION_CLASS);
  }
}

export function useManagedModal({
  visible,
  isClosing,
  onRequestClose,
  onCloseComplete,
  closeOnEscape = true,
  closeOnOverlay = true,
  useOverlay = true,
}: ManagedModalOptions) {
  const overlayBoundRef = useRef(false);
  const motionBoundRef = useRef(false);

  useLayoutEffect(() => {
    if (visible) {
      holdModalMotion(motionBoundRef);
      if (useOverlay && !overlayBoundRef.current) {
        showOverlay();
        overlayBoundRef.current = true;
      }
    }
    if (isClosing) releaseOverlay(overlayBoundRef, useOverlay);
    if (!visible && !isClosing) {
      releaseOverlay(overlayBoundRef, useOverlay);
      releaseModalMotion(motionBoundRef);
    }
  }, [visible, isClosing, useOverlay]);

  useEffect(() => {
    return () => {
      releaseOverlay(overlayBoundRef, useOverlay);
      releaseModalMotion(motionBoundRef);
    };
  }, [useOverlay]);

  useEffect(() => {
    if (!visible || isClosing || !closeOnEscape) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onRequestClose();
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [visible, isClosing, closeOnEscape, onRequestClose]);

  useEffect(() => {
    if (!visible || isClosing || !closeOnOverlay) return;
    const overlay = document.getElementById("overlay");
    if (!overlay) return;
    const onClick = (e: MouseEvent) => {
      if (e.target === overlay) onRequestClose();
    };
    overlay.addEventListener("click", onClick);
    return () => overlay.removeEventListener("click", onClick);
  }, [visible, isClosing, closeOnOverlay, onRequestClose]);

  const onAnimationEnd = useCallback(
    (e: AnimationEvent) => {
      if (
        !isClosing ||
        e.target !== e.currentTarget ||
        e.animationName !== "modalOut"
      ) {
        return;
      }
      releaseOverlay(overlayBoundRef, useOverlay);
      releaseModalMotion(motionBoundRef);
      onCloseComplete?.();
    },
    [isClosing, onCloseComplete, useOverlay],
  );

  return {
    modalStateClass: isClosing ? MODAL_CLOSING_CLASS : MODAL_VISIBLE_CLASS,
    onAnimationEnd,
  };
}

export function isManagedModalOpen(el: HTMLElement | null): boolean {
  return !!el?.classList.contains(MODAL_VISIBLE_CLASS);
}

export function openManagedModal(
  el: HTMLElement,
  { useOverlay = true }: DomModalOptions = {},
): void {
  if (el.classList.contains(MODAL_VISIBLE_CLASS)) return;
  if (el.dataset.modalMotionBound !== "true") {
    const motionBoundRef = { current: false };
    holdModalMotion(motionBoundRef);
    el.dataset.modalMotionBound = "true";
  }
  if (useOverlay && el.dataset.modalOverlayBound !== "true") {
    showOverlay();
    el.dataset.modalOverlayBound = "true";
  }
  el.classList.remove(MODAL_CLOSING_CLASS);
  void el.offsetWidth;
  el.classList.add(MODAL_VISIBLE_CLASS);
}

export function closeManagedModal(
  el: HTMLElement,
  { useOverlay = true, onCloseComplete }: DomModalOptions = {},
): void {
  if (
    el.classList.contains(MODAL_CLOSING_CLASS) ||
    !el.classList.contains(MODAL_VISIBLE_CLASS)
  ) {
    return;
  }

  const finish = () => {
    el.classList.remove(MODAL_CLOSING_CLASS);
    if (el.dataset.modalMotionBound === "true") {
      releaseModalMotion({ current: true });
      delete el.dataset.modalMotionBound;
    }
    onCloseComplete?.();
  };

  const onAnimationEnd = (e: AnimationEvent) => {
    if (e.target !== el || e.animationName !== "modalOut") return;
    finish();
  };

  el.classList.remove(MODAL_VISIBLE_CLASS);
  if (useOverlay && el.dataset.modalOverlayBound === "true") {
    hideOverlay();
    delete el.dataset.modalOverlayBound;
  }
  el.classList.add(MODAL_CLOSING_CLASS);
  el.addEventListener("animationend", onAnimationEnd, { once: true });
}
