import { encodeMochiTarget } from "../../../packages/rivet/src/mochiEncoding";

const _MK = "q7Zx!9pL";

const _KEY_BYTES: Uint8Array =
  typeof TextEncoder !== "undefined"
    ? new TextEncoder().encode(_MK)
    : (() => {
        const a = new Uint8Array(_MK.length);
        for (let i = 0; i < _MK.length; i++) a[i] = _MK.charCodeAt(i) & 0xff;
        return a;
      })();

const MAX_URL_CACHE_ENTRIES = 2048;
const _encodedMochiCache = new Map<string, string>();
const _decodedUrlCache = new Map<string, string>();
const _proxyUrlCache = new Map<string, string>();
const _normalizedGameUrlCache = new Map<string, string | null>();

function _memoGet<T>(cache: Map<string, T>, key: string): T | undefined {
  if (!cache.has(key)) return undefined;
  const value = cache.get(key)!;
  cache.delete(key);
  cache.set(key, value);
  return value;
}

function _memoSet<T>(cache: Map<string, T>, key: string, value: T): T {
  if (cache.size >= MAX_URL_CACHE_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(key, value);
  return value;
}

function _xorBytes(bytes: Uint8Array): Uint8Array {
  const out = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i++)
    out[i] = bytes[i]! ^ _KEY_BYTES[i % _KEY_BYTES.length]!;
  return out;
}

function _bytesToBinaryString(bytes: Uint8Array): string {
  let s = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    s += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return s;
}

function _binaryStringToBytes(binStr: string): Uint8Array {
  const out = new Uint8Array(binStr.length);
  for (let i = 0; i < binStr.length; i++) out[i] = binStr.charCodeAt(i) & 0xff;
  return out;
}

function _base64UrlDecodeToBytes(b64url: string): Uint8Array {
  let p = b64url.replace(/-/g, "+").replace(/_/g, "/");
  while (p.length % 4) p += "=";
  return _binaryStringToBytes(atob(p));
}

export function decodeUrl(encodedUrl: string): string {
  if (!encodedUrl) return "";
  const cached = _memoGet(_decodedUrlCache, encodedUrl);
  if (cached !== undefined) return cached;

  return _memoSet(_decodedUrlCache, encodedUrl, _decodeUrlUncached(encodedUrl));
}

function _decodeUrlUncached(encodedUrl: string): string {
  try {
    const urlObject = new URL(encodedUrl, window.location.origin);
    if (urlObject.pathname.startsWith("/!!/")) {
      let encodedPart = urlObject.pathname.slice("/!!/".length);
      if (encodedPart.endsWith("/")) encodedPart = encodedPart.slice(0, -1);

      try {
        const xoredBytes = _base64UrlDecodeToBytes(encodedPart);
        const rawBytes = _xorBytes(xoredBytes);
        const percentEncoded =
          typeof TextDecoder !== "undefined"
            ? new TextDecoder().decode(rawBytes)
            : _bytesToBinaryString(rawBytes);
        const result = decodeURIComponent(percentEncoded);
        if (result.startsWith("http://") || result.startsWith("https://")) {
          return result + urlObject.search + urlObject.hash;
        }
      } catch (_e) {}

      if (
        encodedPart.startsWith("http://") ||
        encodedPart.startsWith("https://")
      ) {
        return encodedPart + urlObject.search + urlObject.hash;
      }
      try {
        return (
          decodeURIComponent(encodedPart) + urlObject.search + urlObject.hash
        );
      } catch {
        return encodedPart + urlObject.search + urlObject.hash;
      }
    }
  } catch (_e) {}

  try {
    const runtime = (window as unknown as { $folio?: { routeDestination: (url: string) => string | null } }).$folio;
    const url = new URL(encodedUrl, window.location.origin);
    if (url.origin === window.location.origin && url.pathname === "/f") {
      return runtime?.routeDestination(url.href) ?? encodedUrl;
    }
  } catch {
    return encodedUrl;
  }

  try {
    return decodeURIComponent(encodedUrl);
  } catch {
    return encodedUrl;
  }
}

export function encodeMochiUrl(url: string): string {
  if (!url) return "";
  const input = String(url);
  const cached = _memoGet(_encodedMochiCache, input);
  if (cached !== undefined) return cached;

  return _memoSet(_encodedMochiCache, input, _encodeMochiUrlUncached(input));
}

function _encodeMochiUrlUncached(url: string): string {
  try {
    return encodeMochiTarget(url);
  } catch (_e) {
    try {
      return encodeURIComponent(url);
    } catch {
      return "";
    }
  }
}

export function getProxyUrl(url: string): string {
  if (!url) return "";
  const cached = _memoGet(_proxyUrlCache, url);
  if (cached !== undefined) return cached;

  const encoded = encodeMochiUrl(url);
  return _memoSet(_proxyUrlCache, url, "/!!/" + encoded + "/");
}

export function normalizeGameHistoryUrl(candidate: string | null | undefined): string | null {
  if (!candidate || typeof candidate !== "string") return null;
  const cached = _memoGet(_normalizedGameUrlCache, candidate);
  if (cached !== undefined) return cached;

  return _memoSet(_normalizedGameUrlCache, candidate, _normalizeGameHistoryUrlUncached(candidate));
}

function _normalizeGameHistoryUrlUncached(candidate: string): string | null {
  try {
    const parsed = new URL(candidate);
    if (parsed.hostname && parsed.hostname.includes("gn-math.dev")) {
      const rawId = parsed.searchParams.get("id");
      if (rawId) {
        const cleanId = decodeURIComponent(rawId).trim().split(/[?&#]/)[0]!.trim();
        if (cleanId) {
          return `${parsed.protocol}//${parsed.host}/?id=${encodeURIComponent(cleanId)}`;
        }
      }
    }
    let pathname = parsed.pathname || "/";
    pathname = pathname.replace(/\/+$/, "") || "/";
    pathname = pathname.replace(/\/index\.(html?|php)$/i, "") || "/";
    return `${parsed.protocol}//${parsed.host}${pathname}${parsed.search}`;
  } catch {
    return candidate.trim().replace(/\/+$/, "").toLowerCase();
  }
}

export function canonicalize(u: string): string {
  try {
    const url = new URL(u);
    url.pathname = url.pathname.replace(/\/+$/, "");
    url.hostname = url.hostname.toLowerCase();
    return url.toString();
  } catch {
    return u;
  }
}
