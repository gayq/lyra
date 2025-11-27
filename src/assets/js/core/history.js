import { canonicalize } from './utils.js';

export class HistoryManager {
    #stack = [];
    #currentIndex = -1;
    #onUpdateCallback;

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
}