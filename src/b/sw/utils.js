async function coalescedFetch(key, fetchFn) {
  const existing = _inflight.get(key);
  if (existing) {
    return existing.then((value) => {
      try {
        return value instanceof Response ? value.clone() : value;
      } catch (e) {
        return value;
      }
    });
  }
  const request = fetchFn().finally(() => _inflight.delete(key));
  _inflight.set(key, request);
  return request;
}

function mochiCoalesceKey(request, target) {
  const range = request.headers.get("Range") || "";
  const accept = request.headers.get("Accept") || "";
  return `${request.method}\n${target}\n${range}\n${accept}`;
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
      const payload = { type: "lyra-preconnect", origin };
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
  const now = Date.now();
  const lastTrim = _lastCacheTrim.get(cacheName) || 0;
  if (now - lastTrim < CACHE_TRIM_INTERVAL_MS) return;
  _lastCacheTrim.set(cacheName, now);
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

function shouldRevalidateRuntime(request) {
  const key = request.url;
  const now = Date.now();
  const last = _runtimeRevalidateTimes.get(key) || 0;
  if (now - last < RUNTIME_REVALIDATE_MS) return false;
  _runtimeRevalidateTimes.set(key, now);
  if (_runtimeRevalidateTimes.size > MAX_RUNTIME * 2) {
    const oldest = _runtimeRevalidateTimes.keys().next().value;
    _runtimeRevalidateTimes.delete(oldest);
  }
  return true;
}

async function tryWithTimeout(promise, ms) {
  let timer;
  const timeoutP = new Promise((_, rej) => {
    timer = setTimeout(
      () => rej(new Error(swNegativeMessage("request timed out"))),
      ms,
    );
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

async function fetchWithTimeout(input, init, ms) {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), ms);
  try {
    return await fetch(input, { ...init, signal: abort.signal });
  } finally {
    clearTimeout(timer);
  }
}

function responseFitsCache(response) {
  const raw = response.headers.get("content-length");
  if (raw === null) return false;
  const bytes = Number.parseInt(raw, 10);
  return Number.isFinite(bytes) && bytes >= 0 && bytes < LARGE_SIZE_THRESHOLD;
}

function timeoutFallbackResponse(request, url) {
  const dest = request.destination;
  const path = (url.pathname || "").toLowerCase();
  const isScript =
    dest === "script" || path.endsWith(".js") || path.endsWith(".mjs");
  if (isScript) {
    return new Response(`/* ${swNegativeMessage("upstream timeout")} */`, {
      status: 200,
      headers: { "Content-Type": "application/javascript; charset=utf-8" },
    });
  }
  return new Response(swNegativeMessage("gateway timeout"), {
    status: 504,
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

function fixHtmlHeaders(source) {
  const headers = new Headers(source);
  headers.delete("content-encoding");
  headers.delete("content-length");
  headers.delete("transfer-encoding");
  headers.delete("content-security-policy");
  headers.delete("content-security-policy-report-only");
  headers.delete("x-content-security-policy");
  headers.delete("x-webkit-csp");
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
