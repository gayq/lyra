import { prefersReducedMotion } from "../config/advancedSettings.ts";

export function motionDuration(
  name: "control" | "enter" | "exit" | "shimmer",
  element: Element = document.documentElement,
): number {
  if (prefersReducedMotion()) return 0;
  const value = getComputedStyle(element)
    .getPropertyValue(`--motion-${name}`)
    .trim();
  const duration = parseFloat(value) * (value.endsWith("ms") ? 1 : 1000);
  return Number.isFinite(duration) ? Math.max(0, duration) : 0;
}
