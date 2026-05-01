const _MK = "q7Zx!9pL";

const _KEY_BYTES: Uint8Array =
  typeof TextEncoder !== "undefined"
    ? new TextEncoder().encode(_MK)
    : (() => {
        const a = new Uint8Array(_MK.length);
        for (let i = 0; i < _MK.length; i++) a[i] = _MK.charCodeAt(i) & 0xff;
        return a;
      })();

function _xorTransform(str: string): string {
  let out = "";
  for (let i = 0; i < str.length; i++) {
    out += String.fromCharCode(
      str.charCodeAt(i) ^ _MK.charCodeAt(i % _MK.length),
    );
  }
  return out;
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

function _base64UrlEncodeBytes(bytes: Uint8Array): string {
  const b64 = btoa(_bytesToBinaryString(bytes));
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function _base64UrlDecodeToBytes(b64url: string): Uint8Array {
  let p = b64url.replace(/-/g, "+").replace(/_/g, "/");
  while (p.length % 4) p += "=";
  return _binaryStringToBytes(atob(p));
}

export function decodeUrl(encodedUrl: string): string {
  if (!encodedUrl) return "";

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
    const selectedBackend = localStorage.getItem("backend") ?? "scramjet";
    if (selectedBackend === "ultraviolet") {
      const uvConfig = (
        window as unknown as Record<string, Record<string, unknown>>
      )["__uv$config"];
      const prefix = (uvConfig?.["prefix"] as string | undefined) ?? "/b/u/r/";
      const decodeFn =
        (uvConfig?.["decodeUrl"] as ((s: string) => string) | undefined) ??
        decodeURIComponent;
      const urlObject = new URL(encodedUrl, window.location.origin);
      if (urlObject.pathname.startsWith(prefix)) {
        const encodedPart = urlObject.pathname.slice(prefix.length);
        return decodeFn(encodedPart) + urlObject.search + urlObject.hash;
      }
    } else if (selectedBackend === "scramjet") {
      const prefix = "/b/s/r/";
      try {
        const urlObject = new URL(encodedUrl, window.location.origin);
        if (urlObject.pathname.startsWith(prefix)) {
          const pathPart = urlObject.pathname.slice(prefix.length);
          return decodeURIComponent(
            pathPart + urlObject.search + urlObject.hash,
          );
        }
      } catch (_e) {}
      const sj = (
        window as unknown as Record<
          string,
          { decode?: (s: string) => string } | undefined
        >
      )["sj"];
      if (sj && typeof sj.decode === "function") {
        return sj.decode(encodedUrl);
      }
    }
  } catch (_e) {}

  try {
    return decodeURIComponent(encodedUrl);
  } catch {
    return encodedUrl;
  }
}

export function encodeMochiUrl(url: string): string {
  if (!url) return "";
  try {
    const percentEncoded = encodeURIComponent(String(url));
    if (typeof TextEncoder !== "undefined") {
      const bytes = new TextEncoder().encode(percentEncoded);
      return _base64UrlEncodeBytes(_xorBytes(bytes));
    }

    const xored = _xorTransform(percentEncoded);
    return btoa(xored)
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
  } catch (_e) {
    try {
      return encodeURIComponent(String(url));
    } catch {
      return "";
    }
  }
}

export function getProxyUrl(url: string): string {
  if (!url) return "";
  const encoded = encodeMochiUrl(url);
  return "/!!/" + encoded + "/";
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