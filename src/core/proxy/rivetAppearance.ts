const RIVET_THEME_PROPERTIES = [
  "--bg-body",
  "--bg-surface-1",
  "--bg-surface-3",
  "--bg-surface-5",
  "--bg-surface-7",
  "--bg-surface-active",
  "--text-primary",
  "--text-secondary",
  "--text-muted",
  "--color-sublabel",
  "--border-faint",
  "--border-medium",
  "--accent-color",
  "--btn-primary-bg",
  "--btn-primary-bg-hover",
  "--btn-primary-text",
  "--hover-bg",
  "--toast-danger-bg",
  "--toast-danger-text",
  "--notif-dot-feature",
  "--notif-dot-update",
] as const;

const RIVET_MOTION_STYLE_ID = "lyra-rivet-motion";
const RIVET_MOTION_CSS = `
@media (prefers-reduced-motion: reduce) {
  html:not([data-motion="full"]) *,
  html:not([data-motion="full"]) *::before,
  html:not([data-motion="full"]) *::after {
    animation-duration: 0.001ms !important;
    animation-iteration-count: 1 !important;
    scroll-behavior: auto !important;
    transition-duration: 0.001ms !important;
  }
}

html[data-motion="reduced"] *,
html[data-motion="reduced"] *::before,
html[data-motion="reduced"] *::after {
  animation-duration: 0.001ms !important;
  animation-iteration-count: 1 !important;
  scroll-behavior: auto !important;
  transition-duration: 0.001ms !important;
}
`;

export function applyRivetAppearance(doc: Document): void {
  const lyraRoot = document.documentElement;
  const lyraStyle = getComputedStyle(lyraRoot);
  for (const property of RIVET_THEME_PROPERTIES) {
    const value = lyraStyle.getPropertyValue(property);
    if (value) {
      doc.documentElement.style.setProperty(
        `--lyra${property.slice(1)}`,
        value,
      );
    }
  }

  doc.documentElement.dataset.motion = lyraRoot.dataset.motion || "system";
  if (doc.getElementById(RIVET_MOTION_STYLE_ID)) return;

  const style = doc.createElement("style");
  style.id = RIVET_MOTION_STYLE_ID;
  style.textContent = RIVET_MOTION_CSS;
  (doc.head || doc.documentElement).appendChild(style);
}
