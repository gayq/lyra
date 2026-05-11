export {};

interface ToastController {
  id: ReturnType<typeof setTimeout> | null;
  remaining: number;
  startTime: number | null;
  pause(): void;
  start(): void;
  clear(): void;
  hide(): void;
  update(newType?: string, newMessage?: string, newIcon?: string): void;
}

interface ToastAction {
  text: string;
  class?: string;
  dismiss?: boolean;
  callback?: () => void;
}

declare global {
  interface Window {
    showToast: (
      type: string,
      message: string,
      iconName?: string,
      arg4?: number | ToastAction[],
      arg5?: ToastAction[],
    ) => ToastController;
  }
}

function initToast(): void {
  const overlay = document.getElementById("overlay");

  let toastContainer = document.querySelector<HTMLElement>(".toast-container");
  if (!toastContainer) {
    toastContainer = document.createElement("div");
    toastContainer.className = "toast-container";
    document.body.appendChild(toastContainer);
  }

  const activeToasts = new Map<HTMLElement, ToastController>();
  let hoverTimeout: ReturnType<typeof setTimeout> | undefined;

  toastContainer.addEventListener("mouseenter", () => {
    clearTimeout(hoverTimeout);
    activeToasts.forEach((controller) => controller.pause());
    updateToastPositions(true);
  });

  toastContainer.addEventListener("mouseleave", () => {
    hoverTimeout = setTimeout(() => {
      updateToastPositions(false);
    }, 100);
  });

  const updateToastPositions = (isHovered: boolean = false): void => {
    const toasts = Array.from(
      toastContainer!.querySelectorAll<HTMLElement>(".toast:not(.is-hiding)"),
    );
    const visibleStackedCount = 3;

    if (isHovered) {
      const hoverGap = 13;
      const heights = toasts.map((t) => t.offsetHeight);
      let cumulativeHeight = 0;
      toasts.forEach((toast, index) => {
        toast.style.zIndex = String(toasts.length - index);
        if (index < visibleStackedCount) {
          const tf = `translateY(-${cumulativeHeight}px) scale(1)`;
          toast.style.transform = tf;
          toast.dataset.baseTransform = tf;
          toast.style.opacity = "1";
          toast.style.visibility = "";
          toast.style.pointerEvents = "";
          cumulativeHeight += heights[index]! + hoverGap;
        } else {
          toast.style.transform = "translateY(0) scale(0.9)";
          toast.dataset.baseTransform = "translateY(0) scale(0.9)";
          toast.style.opacity = "0";
          toast.style.visibility = "hidden";
          toast.style.pointerEvents = "none";
          const ctrl = activeToasts.get(toast);
          if (ctrl) ctrl.pause();
        }
      });
    } else {
      toasts.forEach((toast, index) => {
        toast.style.zIndex = String(toasts.length - index);
        if (index < visibleStackedCount) {
          const scale = 1 - index * 0.05;
          const translateY = index * -12;
          const tf = `translateY(${translateY}px) scale(${scale})`;
          toast.style.transform = tf;
          toast.dataset.baseTransform = tf;
          toast.style.opacity = "1";
          toast.style.visibility = "";
          toast.style.pointerEvents = "";
          const ctrl = activeToasts.get(toast);
          if (ctrl && !ctrl.id && ctrl.remaining > 0) ctrl.start();
        } else {
          toast.style.transform = "translateY(0) scale(0.9)";
          toast.dataset.baseTransform = "translateY(0) scale(0.9)";
          toast.style.opacity = "0";
          toast.style.visibility = "hidden";
          toast.style.pointerEvents = "none";
          const ctrl = activeToasts.get(toast);
          if (ctrl) ctrl.pause();
        }
      });
    }
  };

  window.showToast = function (
    type: string,
    message: string,
    iconName?: string,
    arg4?: number | ToastAction[],
    arg5?: ToastAction[],
  ): ToastController {
    let duration = 3000;
    let actions: ToastAction[] = [];

    if (Array.isArray(arg4)) {
      actions = arg4;
    } else if (typeof arg4 === "number") {
      duration = arg4;
      if (Array.isArray(arg5)) actions = arg5;
    }

    const toast = document.createElement("div");
    toast.className = `toast ${type}`;
    toast.style.opacity = "0";
    toast.style.transform = "translateY(100%)";

    const icons: Record<string, string> = {
      success: "fa-solid fa-check-circle",
      error: "fa-solid fa-times-circle",
      info: "fa-solid fa-info-circle",
    };
    const iconClass = iconName
      ? `fa-solid fa-${iconName}`
      : icons[type] || "fa-solid fa-info-circle";

    const content = document.createElement("div");
    content.className = "toast-content";
    content.innerHTML = `<i class="${iconClass}"></i><span>${message}</span>`;
    toast.appendChild(content);

    if (actions && actions.length > 0) {
      const actionsContainer = document.createElement("div");
      actionsContainer.className = "toast-actions";

      actions.forEach((action) => {
        const btn = document.createElement("button");
        btn.className = "toast-btn";
        if (action.class) btn.classList.add(action.class);
        btn.textContent = action.text;
        btn.onclick = (e) => {
          e.stopPropagation();
          if (action.callback) action.callback();
          if (action.dismiss !== false) hideToast(toast);
        };
        actionsContainer.appendChild(btn);
      });

      toast.appendChild(actionsContainer);
    }

    const controller: ToastController = {
      id: null,
      remaining: duration,
      startTime: null,
      pause: function () {
        if (this.id) {
          clearTimeout(this.id);
          this.id = null;
          this.remaining -= Date.now() - (this.startTime ?? Date.now());
        }
      },
      start: function () {
        if (this.remaining === 0) return;
        if (this.id || this.remaining <= 0) return;
        this.startTime = Date.now();
        this.id = setTimeout(() => hideToast(toast), this.remaining);
      },
      clear: function () {
        clearTimeout(this.id ?? undefined);
      },
      hide: function () {
        hideToast(toast);
      },
      update: function (
        newType?: string,
        newMessage?: string,
        newIcon?: string,
      ) {
        if (newType) {
          toast.className = `toast ${newType}`;
        }
        if (newMessage || newIcon) {
          const i = toast.querySelector("i");
          const span = toast.querySelector("span");
          if (newIcon && i) i.className = `fa-solid fa-${newIcon}`;
          if (newMessage && span) span.textContent = newMessage;
        }
      },
    };

    activeToasts.set(toast, controller);

    let dragStartY = 0;
    let dragging = false;
    let dragDelta = 0;
    let lastY = 0;
    let lastTime = 0;
    let velocity = 0;

    const onPointerDown = (e: PointerEvent) => {
      if ((e.target as HTMLElement).closest(".toast-btn")) return;
      dragging = true;
      dragStartY = e.clientY;
      lastY = e.clientY;
      lastTime = Date.now();
      dragDelta = 0;
      velocity = 0;
      toast.setPointerCapture(e.pointerId);
      toast.style.transition = "none";
      controller.pause();
    };

    const onPointerMove = (e: PointerEvent) => {
      if (!dragging) return;
      const raw = Math.max(0, e.clientY - dragStartY);
      dragDelta = raw * (1 - raw / 400);

      const now = Date.now();
      const dt = now - lastTime;
      if (dt > 0) {
        velocity = (e.clientY - lastY) / dt;
        lastY = e.clientY;
        lastTime = now;
      }

      const progress = Math.min(dragDelta / 100, 1);
      const scale = 1 - progress * 0.08;
      const baseTransform = toast.dataset.baseTransform || "translateY(0) scale(1)";
      toast.style.transform = `${baseTransform} translateY(${dragDelta}px) scale(${scale})`;
      toast.style.opacity = String(1 - progress * 0.7);
    };

    const onPointerUp = () => {
      if (!dragging) return;
      dragging = false;
      const shouldDismiss = dragDelta > 50 || velocity > 0.5;
      if (shouldDismiss) {
        toast.style.transition = "transform 0.2s cubic-bezier(0.4, 0, 1, 1), opacity 0.2s cubic-bezier(0.4, 0, 1, 1)";
        toast.style.transform = `translateY(${dragDelta + 80}px) scale(0.9)`;
        toast.style.opacity = "0";
        const cleanup = () => { if (toast.parentNode) toast.remove(); };
        toast.addEventListener("transitionend", cleanup, { once: true });
        setTimeout(cleanup, 300);
        if (activeToasts.has(toast)) {
          activeToasts.get(toast)!.clear();
          activeToasts.delete(toast);
        }
        toast.classList.add("is-hiding");
        updateToastPositions(toastContainer!.matches(":hover"));
      } else {
        toast.style.transition = "transform 0.35s cubic-bezier(0.2, 0.9, 0.3, 1.2), opacity 0.1s ease-out";
        updateToastPositions(toastContainer!.matches(":hover"));
        toast.style.opacity = "1";
        controller.start();
      }
    };

    toast.addEventListener("pointerdown", onPointerDown);
    toast.addEventListener("pointermove", onPointerMove);
    toast.addEventListener("pointerup", onPointerUp);
    toast.addEventListener("pointercancel", onPointerUp);

    toastContainer!.prepend(toast);

    requestAnimationFrame(() => {
      updateToastPositions(toastContainer!.matches(":hover"));
    });

    controller.start();
    return controller;
  };

  function hideToast(toast: HTMLElement): void {
    if (!toast || !toast.parentNode || toast.classList.contains("is-hiding")) {
      return;
    }

    if (activeToasts.has(toast)) {
      activeToasts.get(toast)!.clear();
      activeToasts.delete(toast);
    }

    toast.style.transition = "none";
    toast.style.zIndex = "-1";
    toast.classList.add("is-hiding");

    const base = toast.dataset.baseTransform || "translateY(0) scale(1)";

    requestAnimationFrame(() => {
      toast.style.transition = "";
      toast.style.transform = `${base} translateY(80px)`;
      toast.style.opacity = "0";
    });

    const cleanup = () => { if (toast.parentNode) toast.remove(); };
    toast.addEventListener("transitionend", cleanup, { once: true });
    setTimeout(cleanup, 400);

    updateToastPositions(toastContainer!.matches(":hover"));
  }
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initToast, { once: true });
} else {
  initToast();
}
