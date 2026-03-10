import { canonicalize } from './utils.js';

export class HistoryManager {
    #stack = [];
    #currentIndex = -1;
    #onUpdateCallback;
    static #MAX_ENTRIES = 150;

    constructor({ onUpdate = () => {} } = {}) {
        this.#onUpdateCallback = onUpdate;
    }

    #notify() {
        this.#onUpdateCallback({
            currentUrl: this.getCurrentUrl(),
            canGoBack: this.canGoBack(),
            canGoForward: this.canGoForward(),
        });
    }

    push(url) {
        if (!url || url === 'about:blank') return;

        const newCanonicalUrl = canonicalize(url);
        const currentCanonicalUrl = canonicalize(this.#stack[this.#currentIndex]);

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

    replace(url) {
        if (!url || url === 'about:blank' || this.#currentIndex < 0) return;
        
        const newCanonicalUrl = canonicalize(url);
        const currentCanonicalUrl = canonicalize(this.#stack[this.#currentIndex]);

        if (newCanonicalUrl !== currentCanonicalUrl) {
            this.#stack[this.#currentIndex] = url;
            this.#notify();
        } else {
            this.#stack[this.#currentIndex] = url;
        }
    }

    back() {
        if (this.canGoBack()) {
            this.#currentIndex--;
            this.#notify();
            return this.getCurrentUrl();
        }
        return null;
    }

    forward() {
        if (this.canGoForward()) {
            this.#currentIndex++;
            this.#notify();
            return this.getCurrentUrl();
        }
        return null;
    }

    getCurrentUrl() {
        return this.#stack[this.#currentIndex] ?? null;
    }

    canGoBack() {
        return this.#currentIndex > 0;
    }

    canGoForward() {
        return this.#currentIndex < this.#stack.length - 1;
    }

    destroy() {
        this.#stack = [];
        this.#currentIndex = -1;
        this.#onUpdateCallback = () => {};
    }
}
