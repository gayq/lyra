import { signal } from "@preact/signals";

export const sidebarHiddenSignal = signal(false);
export const gamesViewSignal = signal(false);
export const animeViewSignal = signal(false);
export const currentUrlSignal = signal<string>("");

export function initUiSignals(): void {
  const isHidden = localStorage.getItem("sidebarHidden") === "true";
  sidebarHiddenSignal.value = isHidden;
  document.body.classList.toggle("sidebar-hidden", isHidden);
}
