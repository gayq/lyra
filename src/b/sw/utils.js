async function coalescedFetch(key, fetchFn) {
  const existing = _inflight.get(key);
  if (existing) return existing;
  const p = fetchFn().finally(() => _inflight.delete(key));
  _inflight.set(key, p);
  return p;
}

function estimateBandwidth(bytes, timeMs) {
  if (timeMs <= 0) return DEFAULT_CHUNK;
  const bps = (bytes * 8) / (timeMs / 1000);
  _bandwidthHistory.push(bps);
  if (_bandwidthHistory.length > BANDWIDTH_SIZE) {
    _bandwidthHistory.shift();
  }
  return getAdaptiveChunkSize();
}

function getAdaptiveChunkSize() {
  if (_bandwidthHistory.length === 0) return DEFAULT_CHUNK;
  let total = 0;
  for (let i = 0; i < _bandwidthHistory.length; i++) {
    total += _bandwidthHistory[i];
  }
  const avgBps = total / _bandwidthHistory.length;
  const targetTimeMs = 2000;
  return Math.min(
    MAX_CHUNK,
    Math.max(MIN_CHUNK, Math.floor((avgBps * targetTimeMs) / 8)),
  );
}

function preconnectToOrigin(origin) {
  if (!origin || _preconnected.has(origin)) return;
  if (_preconnected.size >= MAX_PRECONNECTED) {
    const oldest = _preconnected.keys().next().value;
    _preconnected.delete(oldest);
  }
  _preconnected.add(origin);
  self.clients
    .matchAll({ type: "window" })
    .then((clients) => {
      const payload = { type: "waves-preconnect", origin };
      for (const client of clients) {
        try {
          client.postMessage(payload);
        } catch (e) {}
      }
    })
    .catch(() => {});
}

async function capCache(cacheName, maxEntries) {
  if (_trimmingCaches.has(cacheName)) return;
  _trimmingCaches.add(cacheName);
  try {
    const cache = await caches.open(cacheName);
    const keys = await cache.keys();
    const over = keys.length - maxEntries;
    if (over > 0) {
      const doomed = keys.slice(0, over);
      await Promise.all(doomed.map((k) => cache.delete(k)));
    }
  } catch (e) {
  } finally {
    _trimmingCaches.delete(cacheName);
  }
}

async function tryWithTimeout(promise, ms) {
  let timer;
  const timeoutP = new Promise((_, rej) => {
    timer = setTimeout(() => rej(new Error("waves-timeout")), ms);
  });
  try {
    const out = await Promise.race([promise, timeoutP]);
    clearTimeout(timer);
    return out;
  } catch (e) {
    clearTimeout(timer);
    return null;
  }
}

function timeoutFallbackResponse(request, url) {
  const dest = request.destination;
  const path = (url.pathname || "").toLowerCase();
  const isScript =
    dest === "script" || path.endsWith(".js") || path.endsWith(".mjs");
  if (isScript) {
    return new Response("/* upstream timeout! */", {
      status: 200,
      headers: { "Content-Type": "application/javascript; charset=utf-8" },
    });
  }
  return new Response("gateway timeout", {
    status: 504,
    statusText: "gateway timeout",
  });
}

function urlExt(targetUrl) {
  try {
    const parsed = new URL(targetUrl);
    const lastDot = parsed.pathname.lastIndexOf(".");
    if (lastDot === -1) return "";
    return parsed.pathname.substring(lastDot).toLowerCase();
  } catch (e) {
    const path = targetUrl.split("?")[0];
    const lastDot = path.lastIndexOf(".");
    return lastDot !== -1 ? path.substring(lastDot).toLowerCase() : "";
  }
}

function isLargeFile(url, request) {
  try {
    const ext = urlExt(url);
    if (LARGE_EXTENSIONS.has(ext)) return true;
    const dest = request?.destination || "";
    if (dest === "audio" || dest === "video") return true;
    const accept = request?.headers?.get("Accept") || "";
    return accept.includes("audio/") || accept.includes("video/");
  } catch (e) {
    return false;
  }
}

function isRangeRequest(request) {
  try {
    const rangeHeader = request.headers.get("Range");
    return !!rangeHeader && rangeHeader.startsWith("bytes=");
  } catch (e) {
    return false;
  }
}

function faviconLike(candidate) {
  if (!candidate) return false;
  try {
    const parsed =
      typeof candidate === "string"
        ? new URL(candidate, self.location.origin)
        : candidate;
    return /favicon(\.(ico|png|svg))?$/i.test(parsed.pathname || "");
  } catch (e) {
    return false;
  }
}

function fixHtmlHeaders(source) {
  const headers = new Headers(source);
  headers.delete("content-encoding");
  headers.delete("content-length");
  headers.delete("transfer-encoding");
  const ct = (source.get("content-type") || "").trim();
  if (/text\/html/i.test(ct)) {
    if (!/charset=/i.test(ct)) {
      headers.set("content-type", ct + "; charset=utf-8");
    }
  } else {
    headers.set("content-type", "text/html; charset=utf-8");
  }
  return headers;
}