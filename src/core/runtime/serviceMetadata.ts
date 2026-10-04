type ServiceMetadata = Record<string, unknown>;

declare global {
  interface Window {
    __lyraStuffData?: Promise<ServiceMetadata | null>;
    __LYRA_WEBRTC_TURN__?: unknown;
  }
}

let pending: Promise<ServiceMetadata | null> | null = null;
let cached: ServiceMetadata | null = null;

export function fetchServiceMetadata(
  refresh = false,
): Promise<ServiceMetadata | null> {
  if (pending) return pending;
  if (cached && !refresh) return Promise.resolve(cached);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  pending = (async () => {
    try {
      const response = await fetch("/api/stuff", {
        cache: "no-store",
        signal: controller.signal,
      });
      if (!response.ok) return null;
      const payload: unknown = await response.json();
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
        return null;
      }
      cached = payload as ServiceMetadata;
      if (typeof window !== "undefined" && cached.turn) {
        window.__LYRA_WEBRTC_TURN__ = cached.turn;
      }
      return cached;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  })().finally(() => {
    pending = null;
  });
  if (typeof window !== "undefined") window.__lyraStuffData = pending;
  return pending;
}
