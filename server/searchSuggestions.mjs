


import { negativeMessage } from "../src/core/runtime/messages.ts";
import { availableParallelism, totalmem } from "os";

const GOOGLE_SUGGEST_URL = "https://suggestqueries.google.com/complete/search";
const SEARCH_SUGGESTION_CACHE_TTL_MS = 5 * 60 * 1000;
const HOST_CORES = Math.max(1, availableParallelism());
const HOST_MEMORY_MB = Math.max(256, Math.floor(totalmem() / 1024 / 1024));
const SEARCH_SUGGESTION_CACHE_MAX_ENTRIES = Math.max(
  256,
  Math.min(16_384, HOST_MEMORY_MB * 2),
);
const SEARCH_SUGGESTION_MAX_IN_FLIGHT = Math.max(
  8,
  Math.min(HOST_CORES * 8, Math.floor(HOST_MEMORY_MB / 16)),
);
const SEARCH_SUGGESTION_MAX_RESULTS = 8;
const SEARCH_SUGGESTION_MAX_QUERY_LENGTH = 120;
const SEARCH_SUGGESTION_TIMEOUT_MS = 4_000;

export const SEARCH_SUGGESTION_PROVIDER = "google-suggest";

export function normalizeSearchSuggestionQuery(value) {
  return String(value || "")
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, SEARCH_SUGGESTION_MAX_QUERY_LENGTH);
}

function parseGoogleSuggestionPayload(payload, maxResults = SEARCH_SUGGESTION_MAX_RESULTS) {
  if (!Array.isArray(payload) || !Array.isArray(payload[1])) return [];

  const suggestions = [];
  const seen = new Set();
  for (const value of payload[1]) {
    if (typeof value !== "string") continue;
    const suggestion = value.trim();
    if (!suggestion || seen.has(suggestion)) continue;
    seen.add(suggestion);
    suggestions.push(suggestion);
    if (suggestions.length >= maxResults) break;
  }
  return suggestions;
}

function setBoundedCacheValue(cache, key, value, expiresAt) {
  if (cache.size >= SEARCH_SUGGESTION_CACHE_MAX_ENTRIES) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey !== undefined) cache.delete(oldestKey);
  }
  cache.set(key, { value, expiresAt });
}

export function createSearchSuggestionService({
  fetchImpl = globalThis.fetch,
  now = () => Date.now(),
  cacheTtlMs = SEARCH_SUGGESTION_CACHE_TTL_MS,
  maxInFlight = SEARCH_SUGGESTION_MAX_IN_FLIGHT,
} = {}) {
  const cache = new Map();
  const inFlight = new Map();

  const get = async (rawQuery) => {
    const query = normalizeSearchSuggestionQuery(rawQuery);
    if (!query) return [];

    const cached = cache.get(query);
    if (cached && cached.expiresAt > now()) return cached.value;
    if (cached) cache.delete(query);

    const pending = inFlight.get(query);
    if (pending) return pending;
    if (inFlight.size >= maxInFlight) {
      throw new Error(negativeMessage("search suggestion service is busy"));
    }

    const request = (async () => {
      const controller = new AbortController();
      const timeout = setTimeout(
        () => controller.abort(),
        SEARCH_SUGGESTION_TIMEOUT_MS,
      );
      try {
        const url = new URL(GOOGLE_SUGGEST_URL);
        url.searchParams.set("client", "firefox");
        url.searchParams.set("hl", "en");
        url.searchParams.set("q", query);
        const response = await fetchImpl(url.toString(), {
          headers: {
            Accept: "application/json, text/javascript;q=0.9, */*;q=0.8",
            "User-Agent": ":3",
          },
          signal: controller.signal,
        });
        if (!response.ok) {
          throw new Error(
            negativeMessage(
              `search suggestion request failed with status ${response.status}`,
            ),
          );
        }
        const payload = await response.json();
        const suggestions = parseGoogleSuggestionPayload(payload);
        setBoundedCacheValue(
          cache,
          query,
          suggestions,
          now() + cacheTtlMs,
        );
        return suggestions;
      } finally {
        clearTimeout(timeout);
      }
    })().finally(() => {
      if (inFlight.get(query) === request) inFlight.delete(query);
    });

    inFlight.set(query, request);
    return request;
  };

  return {
    get,
    clear() {
      cache.clear();
      inFlight.clear();
    },
  };
}
