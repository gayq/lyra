import { negativeMessage } from "../../core/runtime/messages.ts";

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

function cacheSuggestions(query: string, suggestions: string[]): void {
  if (suggestionCache.size >= SEARCH_SUGGESTION_CACHE_MAX_ENTRIES) {
    const oldestQuery = suggestionCache.keys().next().value;
    if (oldestQuery !== undefined) suggestionCache.delete(oldestQuery);
  }
  suggestionCache.set(query, {
    suggestions,
    expiresAt: Date.now() + SEARCH_SUGGESTION_CACHE_TTL_MS,
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
  if (cached) suggestionCache.delete(query);

  const requestInit: RequestInit = {
    headers: { Accept: "application/json" },
  };
  if (signal) requestInit.signal = signal;
  const response = await fetch(
    `/api/search/suggestions?q=${encodeURIComponent(query)}`,
    requestInit,
  );
  if (!response.ok) {
    throw new Error(negativeMessage(`search suggestions failed: ${response.status}`));
  }

  const suggestions = parseSuggestions(await response.json());
  cacheSuggestions(query, suggestions);
  return suggestions;
}
