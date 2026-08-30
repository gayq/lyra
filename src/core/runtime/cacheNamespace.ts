type LyraBuildPayload = {
  build?: unknown;
};

type LyraRuntimeWindow = Window & {
  __lyraStuffData?: Promise<LyraBuildPayload | null>;
};

const sourceNamespaces = new Map<string, Promise<string>>();
let serverNamespacePromise: Promise<string | null> | null = null;

function normalizeNamespace(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().replace(/[^A-Za-z0-9._~-]+/g, "_");
  return normalized || null;
}

function fetchBuildPayload(): Promise<LyraBuildPayload | null> {
  if (typeof fetch !== "function" || typeof location === "undefined") {
    return Promise.resolve(null);
  }
  return fetch("/api/stuff", { cache: "no-store" })
    .then((response) =>
      response.ok ? (response.json() as Promise<LyraBuildPayload>) : null,
    )
    .catch(() => null);
}

function getServerNamespace(): Promise<string | null> {
  if (serverNamespacePromise) return serverNamespacePromise;

  const runtimeWindow =
    typeof window === "undefined"
      ? null
      : (window as LyraRuntimeWindow);
  const buildPromise =
    runtimeWindow?.__lyraStuffData ??
    (runtimeWindow ? (runtimeWindow.__lyraStuffData = fetchBuildPayload()) : null);
  serverNamespacePromise = (buildPromise
    ? buildPromise
        .then((payload) => normalizeNamespace(payload?.build))
        .catch(() => null)
    : Promise.resolve(null)
  ).then((namespace) => namespace);
  return serverNamespacePromise;
}

async function digestFallback(sourceUrl: string): Promise<string> {
  const origin =
    typeof location === "undefined" || typeof location.origin !== "string"
      ? ""
      : location.origin;
  const seed = `${origin}\n${sourceUrl}`;
  const subtle = globalThis.crypto?.subtle;
  if (subtle) {
    const bytes = new TextEncoder().encode(seed);
    const digest = await subtle.digest("SHA-256", bytes);
    const hex = Array.from(new Uint8Array(digest), (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
    return `runtime-${hex.slice(0, 16)}`;
  }
  return `runtime-${encodeURIComponent(seed).slice(-64)}`;
}

async function namespaceFor(sourceUrl: string): Promise<string> {
  const serverNamespace = await getServerNamespace();
  if (serverNamespace) return serverNamespace;

  let pending = sourceNamespaces.get(sourceUrl);
  if (!pending) {
    pending = digestFallback(sourceUrl);
    sourceNamespaces.set(sourceUrl, pending);
  }
  return pending;
}

export async function cacheKey(
  prefix: string,
  sourceUrl: string,
  discriminator: string,
): Promise<string> {
  const namespace = await namespaceFor(sourceUrl);
  return `${prefix}-${namespace}-${discriminator}`;
}
