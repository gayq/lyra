import { canonicalize } from "../runtime/utils.ts";
import { readAdvancedToggle } from "../config/advancedSettings.ts";

export interface HistoryState {
  currentUrl: string | null;
  canGoBack: boolean;
  canGoForward: boolean;
}

export interface HistoryManagerOptions {
  onUpdate?: (state: HistoryState) => void;
}

interface PersistedHistoryEntry {
  url: string;
  visitedAt: number;
}

interface PersistedHistory {
  version: 1;
  entries: PersistedHistoryEntry[];
}

export const HISTORY_STORAGE_KEY = "lyra-history-v1";
const HISTORY_VERSION = 1 as const;
const MAX_PERSISTED_ENTRIES = 500;

function readPersistedHistory(): PersistedHistory {
  try {
    const parsed = JSON.parse(localStorage.getItem(HISTORY_STORAGE_KEY) || "null");
    if (
      parsed?.version !== HISTORY_VERSION ||
      !Array.isArray(parsed.entries)
    ) {
      return { version: HISTORY_VERSION, entries: [] };
    }
    const entries = parsed.entries.filter(
      (entry: unknown): entry is PersistedHistoryEntry =>
        typeof entry === "object" &&
        entry !== null &&
        typeof (entry as PersistedHistoryEntry).url === "string" &&
        Number.isFinite((entry as PersistedHistoryEntry).visitedAt),
    );
    return {
      version: HISTORY_VERSION,
      entries: entries.slice(-MAX_PERSISTED_ENTRIES),
    };
  } catch {
    return { version: HISTORY_VERSION, entries: [] };
  }
}

function persistVisit(url: string, replace: boolean): void {
  if (!readAdvancedToggle("saveHistory")) return;
  try {
    const history = readPersistedHistory();
    const entry = { url, visitedAt: Date.now() };
    if (replace && history.entries.length > 0) history.entries.splice(-1, 1, entry);
    else history.entries.push(entry);
    history.entries = history.entries.slice(-MAX_PERSISTED_ENTRIES);
    localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(history));
  } catch {
    
  }
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
      this.#notify();
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
    persistVisit(url, false);
    this.#notify();
  }

  replace(url: string): void {
    if (!url || url === "about:blank" || this.#currentIndex < 0) return;

    this.#stack[this.#currentIndex] = url;
    persistVisit(url, true);
    this.#notify();
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
