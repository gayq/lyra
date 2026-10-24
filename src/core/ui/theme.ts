import type { ThemeKey } from "../config/settingsOptions.ts";
import { motionDuration } from "./motion.ts";

const TRANSITION_CLASS = "theme-transitioning";

let activeTransition: ViewTransition | null = null;

export function applyTheme(theme: ThemeKey): void {
  const root = document.documentElement;
  if (theme === "default") root.removeAttribute("data-theme");
  else root.setAttribute("data-theme", theme);
}

function currentTheme(): string {
  return document.documentElement.getAttribute("data-theme") ?? "default";
}

export function switchTheme(theme: ThemeKey): void {
  if (theme === currentTheme()) return;

  const duration = motionDuration("reveal");
  if (!document.startViewTransition || document.hidden || duration === 0) {
    activeTransition?.skipTransition();
    applyTheme(theme);
    return;
  }

  activeTransition?.skipTransition();

  const root = document.documentElement;
  root.classList.add(TRANSITION_CLASS);
  const transition = document.startViewTransition(() => applyTheme(theme));
  activeTransition = transition;

  transition.ready
    .then(() => {
      const radius = Math.hypot(window.innerWidth, window.innerHeight);
      root.animate(
        {
          clipPath: ["circle(0px at 0 0)", `circle(${radius}px at 0 0)`],
        },
        {
          duration,
          easing:
            getComputedStyle(root).getPropertyValue("--motion-ease").trim() ||
            "ease",
          pseudoElement: "::view-transition-new(root)",
        },
      );
    })
    .catch(() => {});

  transition.finished.finally(() => {
    if (activeTransition !== transition) return;
    activeTransition = null;
    root.classList.remove(TRANSITION_CLASS);
  });
}
