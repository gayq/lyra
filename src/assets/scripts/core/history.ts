import { canonicalize } from "./utils.js";

export interface HistoryState {
  currentUrl: string | null;
  canGoBack: boolean;
  canGoForward: boolean;
}

export interface HistoryManagerOptions {
  onUpdate?: (state: HistoryState) => void;
}

export class HistoryManager {
  #stack: string[] = [];
  #currentIndex: number = -1;
  #onUpdateCallback: (state: HistoryState) => void;
  static readonly #MAX_ENTRIES = 150;

  constructor({ onUpdate = () => {} }: HistoryManagerOptions = {}) {
    this.#onUpdateCallback = onUpdate;
  }

  #notify(): void {
    this.#onUpdateCallback({
      currentUrl: this.getCurrentUrl(),
      canGoBack: this.canGoBack(),
      canGoForward: this.canGoForward(),
    });
  }

  push(url: string): void {
    if (!url || url === "about:blank") return;

    const newCanonicalUrl = canonicalize(url);
    const currentCanonicalUrl = canonicalize(
      this.#stack[this.#currentIndex] ?? "",
    );

    if (currentCanonicalUrl === newCanonicalUrl) {
      this.#stack[this.#currentIndex] = url;
      return;
    }

    if (this.#currentIndex < this.#stack.length - 1) {
      this.#stack.length = this.#currentIndex + 1;
    }
    this.#stack.push(url);
    this.#currentIndex++;
    if (this.#stack.length > HistoryManager.#MAX_ENTRIES) {
      const overflow = this.#stack.length - HistoryManager.#MAX_ENTRIES;
      this.#stack.splice(0, overflow);
      this.#currentIndex = Math.max(0, this.#currentIndex - overflow);
    }
    this.#notify();
  }

  replace(url: string): void {
    if (!url || url === "about:blank" || this.#currentIndex < 0) return;

    const newCanonicalUrl = canonicalize(url);
    const currentCanonicalUrl = canonicalize(
      this.#stack[this.#currentIndex] ?? "",
    );

    if (newCanonicalUrl !== currentCanonicalUrl) {
      this.#stack[this.#currentIndex] = url;
      this.#notify();
    } else {
      this.#stack[this.#currentIndex] = url;
    }
  }

  back(): string | null {
    if (this.canGoBack()) {
      this.#currentIndex--;
      this.#notify();
      return this.getCurrentUrl();
    }
    return null;
  }

  forward(): string | null {
    if (this.canGoForward()) {
      this.#currentIndex++;
      this.#notify();
      return this.getCurrentUrl();
    }
    return null;
  }

  getCurrentUrl(): string | null {
    return this.#stack[this.#currentIndex] ?? null;
  }

  canGoBack(): boolean {
    return this.#currentIndex > 0;
  }

  canGoForward(): boolean {
    return this.#currentIndex < this.#stack.length - 1;
  }

  destroy(): void {
    this.#stack = [];
    this.#currentIndex = -1;
    this.#onUpdateCallback = () => {};
  }
}