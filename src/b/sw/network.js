function mochiBase() {
  if (self.__MOCHI_BASE__ && self.__MOCHI_BASE__.startsWith("http")) {
    return self.__MOCHI_BASE__.replace(/\/+$/, "") + "/!!/";
  }
  if (self.MOCHI_BASE && self.MOCHI_BASE.startsWith("http")) {
    return self.MOCHI_BASE.replace(/\/+$/, "") + "/!!/";
  }
  const loc = self.location;
  const originBase = `${loc.origin}${MOCHI_PREFIX}`;
  const devBase = `${loc.protocol}//${loc.hostname}:4002${MOCHI_PREFIX}`;
  return originBase || devBase;
}

function mochiTarget(realUrl) {
  const base = mochiBase();
  const normalized = base.endsWith("/") ? base : base + "/";
  return realUrl.startsWith("http")
    ? `${normalized}${realUrl}`
    : `${MOCHI_PREFIX}${realUrl}`;
}

async function mochiFetch(request, realUrl, timeoutMs = MOCHI_TIMEOUT_MS) {
  const headers = new Headers(request.headers);
  headers.delete("host");
  headers.delete("origin");
  headers.delete("referer");
  const init = {
    method: request.method,
    headers,
    redirect: "follow",
    cache: "no-store",
    credentials: "include",
  };
  if (request.method !== "GET" && request.method !== "HEAD") {
    try {
      init.body = request.clone().body;
    } catch (e) {}
  }
  const target = mochiTarget(realUrl);
  try {
    if (init.method === "GET" || init.method === "HEAD") {
      return await coalescedFetch(mochiCoalesceKey(request, target), () =>
        fetchWithTimeout(target, init, timeoutMs),
      );
    }
    return await fetchWithTimeout(target, init, timeoutMs);
  } catch {
    return null;
  }
}

async function fetchLargeFileStreaming(request, realUrl, timeoutMs = LARGE_TIMEOUT_MS) {
  const headers = new Headers(request.headers);
  const acceptEncoding = request.headers.get("Accept-Encoding") || "";
  if (!acceptEncoding.includes("gzip") && !acceptEncoding.includes("br")) {
    headers.set("Accept-Encoding", "gzip, br, deflate");
  }
  const rangeHeader = request.headers.get("Range");
  if (rangeHeader) headers.set("Range", rangeHeader);
  headers.set("Priority", "u=4");
  try {
    const urlObj = new URL(realUrl);
    headers.set("X-DNS-Prefetch-Control", "on");
    preconnectToOrigin(`${urlObj.protocol}//${urlObj.host}`);
  } catch (e) {}
  const init = {
    method: request.method,
    headers,
    redirect: "follow",
    cache: "no-store",
    credentials: "include",
  };
  if (request.method !== "GET" && request.method !== "HEAD") {
    try {
      init.body = request.clone().body;
    } catch (e) {}
  }
  const target = mochiTarget(realUrl);
  try {
    const response = await coalescedFetch(mochiCoalesceKey(request, target), () =>
      fetchWithTimeout(target, init, timeoutMs),
    );
    if (!response) return null;
    const contentLength = response.headers.get("Content-Length");
    const newHeaders = new Headers(response.headers);
    newHeaders.set("Accept-Ranges", "bytes");
    newHeaders.set(
      "Cache-Control",
      "public, max-age=3600, s-maxage=86400, immutable, stale-while-revalidate=86400",
    );
    newHeaders.set("Keep-Alive", "timeout=60, max=100");
    if (!rangeHeader && contentLength) {
      newHeaders.set("Content-Length", contentLength);
    } else {
      newHeaders.delete("Content-Length");
    }
    const etag = response.headers.get("ETag");
    if (etag) newHeaders.set("ETag", etag);
    const lastModified = response.headers.get("Last-Modified");
    if (lastModified) newHeaders.set("Last-Modified", lastModified);
    newHeaders.set("Vary", "Accept-Encoding, Range");
    try {
      const urlObj = new URL(realUrl);
      newHeaders.set("Link", `<${urlObj.origin}>; rel=preconnect`);
    } catch (e) {}
    newHeaders.set("Access-Control-Allow-Origin", "*");
    newHeaders.set("Access-Control-Allow-Methods", "GET, HEAD, OPTIONS");
    newHeaders.set(
      "Access-Control-Allow-Headers",
      "Range, Accept-Encoding, If-Range, If-Match, If-None-Match",
    );
    newHeaders.set(
      "Access-Control-Expose-Headers",
      "Content-Length, Content-Range, Accept-Ranges, ETag, Cache-Control, Last-Modified",
    );
    if (contentLength) {
      sendProgressUpdate(
        realUrl,
        parseInt(contentLength, 10),
        response.status,
      ).catch(() => {});
    }
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: newHeaders,
    });
  } catch (e) {
    return null;
  }
}

async function sendProgressUpdate(url, totalBytes, status) {
  try {
    const clients = await self.clients.matchAll({ type: "window" });
    const payload = {
      type: "lyra-file-progress",
      url,
      totalBytes,
      status,
    };
    for (const client of clients) {
      try {
        client.postMessage(payload);
      } catch (e) {}
    }
  } catch (e) {}
}

function notifyTransportError() {
  _consecutiveProxyFailures++;
  const now = Date.now();
  if (now - _lastTransportError < 3000) return;
  _lastTransportError = now;
  self.clients
    .matchAll({ includeUncontrolled: true, type: "window" })
    .then((clients) => {
      const payload = {
        type: "transport-error",
        failures: _consecutiveProxyFailures,
      };
      for (const client of clients) client.postMessage(payload);
    });
}

function resetProxyHealth() {
  _consecutiveProxyFailures = 0;
}

function prefetchNavCacheKeyRequest(reqUrl) {
  try {
    const u = new URL(reqUrl);
    u.hash = "";
    return new Request(u.href, { method: "GET" });
  } catch (e) {
    return new Request(String(reqUrl).split("#")[0], { method: "GET" });
  }
}

function trackPrefetchUrl(urlStr) {
  try {
    const urlKey = prefetchNavCacheKeyRequest(urlStr).url;
    if (_activePrefetches.has(urlKey)) return false;
    const lastAt = _prefetchTimes.get(urlKey);
    const age = lastAt ? Date.now() - lastAt : Infinity;
    if (age < PREFETCH_VALIDITY) return false;
    return true;
  } catch (e) {
    return false;
  }
}

async function matchPrefetchedNavHtml(request) {
  const key = prefetchNavCacheKeyRequest(request.url);
  try {
    const cache = await caches.open(PREFETCH_CACHE);
    let hit = await cache.match(key, { ignoreVary: true });
    if (hit) return hit;
    hit = await cache.match(key);
    if (hit) return hit;
  } catch (e) {}
  try {
    const cache = await caches.open(RUNTIME_CACHE);
    let hit = await cache.match(key, { ignoreVary: true });
    if (hit) return hit;
    return await cache.match(key);
  } catch (e) {
    return null;
  }
}

async function ensureFolioConfig() {
  if (folioConfigLoaded) return;
  if (!folio || typeof folio.loadConfig !== "function") {
    folioConfigLoaded = true;
    return;
  }
  if (!folioConfigPromise) {
    const pending = folio.loadConfig().then(() => {
      folioConfigLoaded = true;
    });
    folioConfigPromise = pending;
    pending.catch(() => {
      if (folioConfigPromise === pending) folioConfigPromise = null;
    });
  }
  await folioConfigPromise;
}

async function runFolioProxy(engine, event, timeoutMs, notifyOnFailure = true) {
  const controllerTimeoutMs = Math.max(1, timeoutMs - 250);
  const proxyP = (typeof engine.fetch === "function"
    ? engine.fetch(event, controllerTimeoutMs)
    : engine.route(event, controllerTimeoutMs)
  ).catch((e) => {
    throw e;
  });
  const timedProxyP = tryWithTimeout(proxyP, timeoutMs);
  const response = await timedProxyP;
  if (response && response.ok) resetProxyHealth();
  if (!response && notifyOnFailure) notifyTransportError();
  return response;
}

async function reviveFolioRoutes() {
  try {
    const clients = await self.clients.matchAll({
      includeUncontrolled: true,
      type: "window",
    });
    for (const client of clients) {
      try {
        client.postMessage({ $controller$swrevive: { routeMiss: true } });
      } catch (e) {}
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  } catch (e) {}
}

async function folioRouteMissFallback(request, url, realUrl, isNavigate) {
  notifyTransportError();
  if (realUrl && realUrl.startsWith("http")) {
    const fallback = await mochiFetch(
      request,
      realUrl,
      isNavigate ? PROXY_NAV_TIMEOUT_MS : MOCHI_TIMEOUT_MS,
    );
    if (fallback && (fallback.ok || fallback.status === 304)) {
      return isNavigate ? patchHtml(fallback, realUrl) : fallback;
    }
  }
  return timeoutFallbackResponse(request, url);
}

async function handlePrefetchProxyRequest(event) {
  const { request } = event;
  const url = new URL(request.url);
  const urlKey = prefetchNavCacheKeyRequest(request.url).url;
  const active = _activePrefetches.get(urlKey);
  if (active) {
    try {
      const response = await active;
      return response ? response.clone() : new Response(null, { status: 204 });
    } catch {
      return new Response(null, { status: 204 });
    }
  }
  const realUrl = unwrapUrl(url);
  const fetchPrefetchResponse = async () => {
    try {
      const engine = isFolio ? folio : null;
      if (!engine) return new Response(null, { status: 204 });
      if (isFolio) {
        await ensureFolioConfig();
      }
      if (typeof engine.shouldRoute === "function" && !engine.shouldRoute(event)) {
        return new Response(null, { status: 204 });
      }
      const response = await runFolioProxy(
        engine,
        event,
        PROXY_NAV_TIMEOUT_MS,
        false,
      );
      if (response && response.ok) {
        try {
          const cacheKey = prefetchNavCacheKeyRequest(request.url);
          const cache = await caches.open(PREFETCH_CACHE);
          await cache.put(cacheKey, response.clone());
          _prefetchTimes.set(urlKey, Date.now());
          capCache(PREFETCH_CACHE, MAX_PREFETCH_ENTRIES);
        } catch {}
        return response;
      }
      return response || new Response(null, { status: 204 });
    } catch {
      return new Response(null, { status: 204 });
    }
  };
  const prefetchPromise = fetchPrefetchResponse();
  _activePrefetches.set(urlKey, prefetchPromise);
  try {
    const response = await prefetchPromise;
    if (response && response.ok) {
      try {
        _prefetchedResponses.set(urlKey, response.clone());
        if (_prefetchedResponses.size > MAX_MEM) {
          const oldest = _prefetchedResponses.keys().next().value;
          _prefetchedResponses.delete(oldest);
        }
      } catch {}
    }
    return response ? response.clone() : new Response(null, { status: 204 });
  } catch {
    return new Response(null, { status: 204 });
  } finally {
    _activePrefetches.delete(urlKey);
  }
}

async function prefetchProxiedNavFromClient(urlStr) {
  let url;
  try {
    url = new URL(urlStr);
  } catch {
    return;
  }
  if (url.origin !== self.location.origin) return;
  if (url.pathname !== "/f" || !url.searchParams.has("s")) return;
  if (!trackPrefetchUrl(urlStr)) return;
  const request = new Request(urlStr, { method: "GET" });
  const event = {
    request,
    type: "fetch",
    respondWith: () => {},
    waitUntil: () => {},
    preventDefault: () => {},
    preloadResponse: Promise.resolve(null),
    clientId: "",
    resultingClientId: "",
    replacesClientId: "",
  };
  try {
    const response = await handlePrefetchProxyRequest(event);
    if (!response || !response.ok) return;
  } catch {
    return;
  }
}
