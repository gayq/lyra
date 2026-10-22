const SEARCH_SUGGESTION_CACHE_TTL_MS = 5 * 60 * 1000;
const SEARCH_SUGGESTION_CACHE_MAX_ENTRIES = 64;
const SEARCH_SUGGESTION_MAX_RESULTS = 8;

interface SearchSuggestionResponse {
  suggestions?: unknown;
}

const suggestionCache = new Map<
  string,
  { suggestions: string[]; expiresAt: number }
>();

function normalizeQuery(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function parseSuggestions(payload: unknown): string[] {
  if (!payload || typeof payload !== "object") return [];
  const values = (payload as SearchSuggestionResponse).suggestions;
  if (!Array.isArray(values)) return [];

  const seen = new Set<string>();
  return values
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.trim())
    .filter((value) => value.length > 0 && !seen.has(value) && seen.add(value))
    .slice(0, SEARCH_SUGGESTION_MAX_RESULTS);
}

function cacheSuggestions(query: string, suggestions: string[], ttlMs = SEARCH_SUGGESTION_CACHE_TTL_MS): void {
  if (suggestionCache.size >= SEARCH_SUGGESTION_CACHE_MAX_ENTRIES) {
    const oldestQuery = suggestionCache.keys().next().value;
    if (oldestQuery !== undefined) suggestionCache.delete(oldestQuery);
  }
  suggestionCache.set(query, {
    suggestions,
    expiresAt: Date.now() + ttlMs,
  });
}

export async function fetchSearchSuggestions(
  rawQuery: string,
  signal?: AbortSignal,
): Promise<string[]> {
  const query = normalizeQuery(rawQuery);
  if (!query) return [];

  const cached = suggestionCache.get(query);
  if (cached && cached.expiresAt > Date.now()) return cached.suggestions;

  const requestInit: RequestInit = {
    headers: { Accept: "application/json" },
  };
  if (signal) requestInit.signal = signal;
  try {
    const response = await fetch(
      `/api/search/suggestions?q=${encodeURIComponent(query)}`,
      requestInit,
    );
    const suggestions = parseSuggestions(await response.json());
    const fallback = suggestions.length ? suggestions : cached?.suggestions || [];
    const result = response.ok ? suggestions : fallback;
    cacheSuggestions(query, result, response.ok ? SEARCH_SUGGESTION_CACHE_TTL_MS : 30_000);
    return result;
  } catch (error) {
    if (signal?.aborted) throw error;
    const fallback = cached?.suggestions || [];
    cacheSuggestions(query, fallback, 30_000);
    return fallback;
  }
}
