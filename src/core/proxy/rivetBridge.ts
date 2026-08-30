import type { RivetFacade } from "./rivet.ts";

export const EXTENSION_POPUP_MOUNTED_EVENT =
  "rivet-extension-popup-mounted";

let instance: RivetFacade | null = null;
let mountNewTabOverride: ((tab: unknown) => boolean) | null = null;

export function registerRivetBridge(
  rivet: RivetFacade,
  mountOverride: (tab: unknown) => boolean,
): void {
  instance = rivet;
  mountNewTabOverride = mountOverride;
}

export function getRivet(): RivetFacade | null {
  return instance;
}

export function mountRivetNewTabOverride(tab: unknown): boolean {
  return mountNewTabOverride?.(tab) ?? false;
}
