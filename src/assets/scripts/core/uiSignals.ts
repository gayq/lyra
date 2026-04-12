import { signal } from "@preact/signals";

export const sidebarHiddenSignal = signal(false);

export function initUiSignals(): void {
  const isHidden = localStorage.getItem("sidebarHidden") === "true";
  sidebarHiddenSignal.value = isHidden;
  document.body.classList.toggle("sidebar-hidden", isHidden);
}

export function setSidebarHidden(value: boolean): void {
  sidebarHiddenSignal.value = value;
  localStorage.setItem("sidebarHidden", value ? "true" : "false");
  document.body.classList.toggle("sidebar-hidden", value);
}