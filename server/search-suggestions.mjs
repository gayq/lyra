import { negativeMessage } from "../src/core/runtime/messages.ts";
import { availableParallelism, totalmem } from "os";
import { httpError } from "./errors.mjs";

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

const SEARCH_SUGGESTION_PROVIDER = "google-suggest";

function normalizeSearchSuggestionQuery(value) {
  return String(value || "")
    .trim()
    .replace(/\s+/g, " ")
    .slice(0, SEARCH_SUGGESTION_MAX_QUERY_LENGTH);
}

function parseGoogleSuggestionPayload(
  payload,
  maxResults = SEARCH_SUGGESTION_MAX_RESULTS,
) {
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
  if (!cache.has(key) && cache.size >= SEARCH_SUGGESTION_CACHE_MAX_ENTRIES) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey !== undefined) cache.delete(oldestKey);
  }
  cache.set(key, { value, expiresAt });
}

export function createSearchSuggestionService({
  fetchImpl = globalThis.fetch,
  now = () => Date.now(),
  cacheTtlMs = SEARCH_SUGGESTION_CACHE_TTL_MS,
  failureTtlMs = 30_000,
  timeoutMs = SEARCH_SUGGESTION_TIMEOUT_MS,
  maxInFlight = SEARCH_SUGGESTION_MAX_IN_FLIGHT,
} = {}) {
  const cache = new Map();
  const failures = new Map();
  const inFlight = new Map();
  const counters = {
    requests: 0, cache_hits: 0, coalesced: 0, upstream_requests: 0,
    busy: 0, negative_hits: 0, circuit_rejections: 0,
    http_400: 0, http_429: 0, http_other: 0, timeout: 0,
    network: 0, invalid_payload: 0, upstream_duration_ms: 0,
  };
  let consecutiveFailures = 0;
  let circuitUntil = 0;
  let probing = false;

  const unavailable = (query) => httpError(
    502,
    "SEARCH_SUGGESTIONS_UNAVAILABLE",
    "search suggestions are temporarily unavailable",
    { provider: SEARCH_SUGGESTION_PROVIDER, query, suggestions: cache.get(query)?.value || [] },
  );
  const success = (query, suggestions) => ({
    status: 200,
    body: { query, suggestions, provider: SEARCH_SUGGESTION_PROVIDER },
  });

  const suggest = async (rawQuery) => {
    const query = normalizeSearchSuggestionQuery(rawQuery);
    counters.requests++;
    if (!query) return success(query, []);
    const cached = cache.get(query);
    if (cached && cached.expiresAt > now()) {
      counters.cache_hits++;
      return success(query, cached.value);
    }
    if ((failures.get(query)?.expiresAt || 0) > now()) {
      counters.negative_hits++;
      return unavailable(query);
    }
    const pending = inFlight.get(query);
    if (pending) {
      counters.coalesced++;
      return pending;
    }
    if (circuitUntil > now() || probing) {
      counters.circuit_rejections++;
      return unavailable(query);
    }
    if (inFlight.size >= maxInFlight) {
      counters.busy++;
      return unavailable(query);
    }
    const probe = consecutiveFailures >= 3;
    if (probe) probing = true;
    const request = (async () => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      const started = now();
      let category = "network";
      let status = 0;
      counters.upstream_requests++;
      try {
        const url = new URL(GOOGLE_SUGGEST_URL);
        url.searchParams.set("client", "firefox");
        url.searchParams.set("hl", "en");
        url.searchParams.set("q", query);
        const response = await fetchImpl(url.toString(), {
          headers: { Accept: "application/json" },
          signal: controller.signal,
        });
        status = response.status;
        if (!response.ok) {
          category = status === 400 ? "http_400" : status === 429 ? "http_429" : "http_other";
          await response.body?.cancel();
          throw new Error(negativeMessage("search suggestions are unavailable"));
        }
        category = "invalid_payload";
        const payload = await response.json();
        if (!Array.isArray(payload) || !Array.isArray(payload[1])) {
          throw new Error(negativeMessage("search suggestions are unavailable"));
        }
        const suggestions = parseGoogleSuggestionPayload(payload);
        setBoundedCacheValue(cache, query, suggestions, now() + cacheTtlMs);
        failures.delete(query);
        consecutiveFailures = 0;
        circuitUntil = 0;
        return success(query, suggestions);
      } catch {
        if (controller.signal.aborted) category = "timeout";
        counters[category]++;
        consecutiveFailures++;
        if (consecutiveFailures >= 3 || status === 429) {
          circuitUntil = now() + failureTtlMs;
          consecutiveFailures = Math.max(3, consecutiveFailures);
        }
        setBoundedCacheValue(failures, query, true, now() + failureTtlMs);
        console.error(JSON.stringify({
          time: new Date(now()).toISOString(),
          message: negativeMessage("search suggestion request failed"),
          category, status, duration_ms: now() - started,
        }));
        return unavailable(query);
      } finally {
        clearTimeout(timeout);
        counters.upstream_duration_ms += Math.max(0, now() - started);
        if (probe) probing = false;
      }
    })().finally(() => {
      if (inFlight.get(query) === request) inFlight.delete(query);
    });
    inFlight.set(query, request);
    return request;
  };
  suggest.metrics = () => ({
    ...counters, active: inFlight.size,
    circuit_open: circuitUntil > now() || probing,
  });
  return suggest;
}
