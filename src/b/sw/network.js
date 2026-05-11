function mochiBase() {
  if (self.__MOCHI_BASE__ && self.__MOCHI_BASE__.startsWith("http")) {
    return self.__MOCHI_BASE__.replace(/\/+$/, "") + "/!!/";
  }
  if (self.MOCHI_BASE && self.MOCHI_BASE.startsWith("http")) {
    return self.MOCHI_BASE.replace(/\/+$/, "") + "/!!/";
  }
  const loc = self.location;
  const originBase = `${loc.origin}${MOCHI_PREFIX}`;
  const devBase = `${loc.protocol}//${loc.hostname}:4000${MOCHI_PREFIX}`;
  return originBase || devBase;
}

function mochiTarget(realUrl) {
  const base = mochiBase();
  const normalized = base.endsWith("/") ? base : base + "/";
  return realUrl.startsWith("http")
    ? `${normalized}${realUrl}`
    : `${MOCHI_PREFIX}${realUrl}`;
}

async function mochiFetch(request, realUrl) {
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
  if (init.method === "GET" || init.method === "HEAD") {
    return coalescedFetch(target, () => fetch(target, init));
  }
  return fetch(target, init);
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
  const startTime = Date.now();
  try {
    const response = await coalescedFetch(target, () =>
      tryWithTimeout(fetch(target, init), timeoutMs),
    );
    if (!response) return null;
    const contentLength = response.headers.get("Content-Length");
    if (contentLength && rangeHeader) {
      estimateBandwidth(parseInt(contentLength, 10), Date.now() - startTime);
    }
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
    if (rangeHeader && response.ok) {
      preloadNextChunk(realUrl, rangeHeader, timeoutMs).catch(() => {});
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
      type: "waves-file-progress",
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

async function preloadNextChunk(realUrl, currentRange, timeoutMs) {
  try {
    const match = currentRange.match(/bytes=(\d+)-(\d+)?/);
    if (!match) return;
    const start = parseInt(match[1], 10);
    const end = match[2] ? parseInt(match[2], 10) : start + 1048576;
    const adaptiveSize = getAdaptiveChunkSize();
    const preloadPromises = [];
    for (let i = 1; i <= 2; i++) {
      const nextStart = end + (i - 1) * adaptiveSize + 1;
      const nextEnd = nextStart + adaptiveSize - 1;
      const nextRange = `bytes=${nextStart}-${nextEnd}`;
      const preloadKey = `${realUrl}:${nextRange}`;
      if (_preloadedLarge.has(preloadKey)) continue;
      if (_preloadedLarge.size >= MAX_PRELOADED) {
        const oldest = _preloadedLarge.keys().next().value;
        _preloadedLarge.delete(oldest);
      }
      _preloadedLarge.set(preloadKey, Date.now());
      preloadPromises.push(
        fetchChunkWithRetry(realUrl, nextRange, timeoutMs, i).catch(() => {}),
      );
    }
    await Promise.allSettled(preloadPromises);
  } catch (e) {}
}

async function fetchChunkWithRetry(realUrl, range, timeoutMs, attempt = 1) {
  const maxRetries = 3;
  const baseDelay = 1000;
  for (let i = 0; i < maxRetries; i++) {
    try {
      const headers = new Headers();
      headers.set("Range", range);
      headers.set("Accept-Encoding", "gzip, br, deflate");
      headers.set("Priority", attempt === 1 ? "u=3" : "u=2");
      const target = mochiTarget(realUrl);
      const init = {
        method: "GET",
        headers,
        redirect: "follow",
        cache: "no-store",
        credentials: "include",
      };
      const response = await tryWithTimeout(fetch(target, init), timeoutMs);
      if (response && response.ok) return response;
      if (i < maxRetries - 1) {
        const delay = baseDelay * Math.pow(2, i);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    } catch (e) {
      if (i < maxRetries - 1) {
        const delay = baseDelay * Math.pow(2, i);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }
  return null;
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

async function ensureScramjetConfig() {
  if (scramjetConfigLoaded) return;
  if (!scramjetConfigPromise) {
    scramjetConfigPromise = scramjet.loadConfig().then(() => {
      scramjetConfigLoaded = true;
    });
  }
  await scramjetConfigPromise;
}

async function runProxyWithMochiFallback(
  engine,
  event,
  realUrl,
  timeoutMs,
  isNavigate,
  notifyOnFailure = true,
) {
  const { request } = event;
  const proxyP = engine.fetch(event).catch((e) => {
    throw e;
  });
  const timedProxyP = tryWithTimeout(proxyP, timeoutMs);
  const hasHttpReal = !!(realUrl && realUrl.startsWith("http"));
  let response = null;
  if (hasHttpReal && isNavigate) {
    const mochiP = tryWithTimeout(
      mochiFetch(request, realUrl),
      MOCHI_SECONDARY_MS,
    );
    response = await timedProxyP;
    if (response && response.ok) resetProxyHealth();
    if (!response || (response.status >= 502 && response.status <= 504)) {
      if (!response && notifyOnFailure) notifyTransportError();
      response = await mochiP;
    }
  } else {
    response = await timedProxyP;
    if (response && response.ok) resetProxyHealth();
    if (!response && hasHttpReal) {
      if (notifyOnFailure) notifyTransportError();
      response = await tryWithTimeout(
        mochiFetch(request, realUrl),
        MOCHI_SECONDARY_MS,
      );
    }
  }
  return response;
}

async function handlePrefetchProxyRequest(event) {
  const { request } = event;
  const url = new URL(request.url);
  if (adBlocked(adTarget(request.url), false)) {
    return new Response(null, { status: 204 });
  }
  const urlKey = prefetchNavCacheKeyRequest(request.url).url;
  const active = _activePrefetches.get(urlKey);
  if (active) {
    try {
      const res = await active;
      return res ? res.clone() : new Response(null, { status: 204 });
    } catch (e) {
      return new Response(null, { status: 204 });
    }
  }
  const realUrl = unwrapUrl(url);
  const doFetch = async () => {
    try {
      const engine = isScramjet ? scramjet : isUltraviolet ? uv : null;
      if (!engine) return new Response(null, { status: 204 });
      if (isScramjet) {
        await ensureScramjetConfig();
        if (
          url.pathname.startsWith("/b/s/jetty.") &&
          !url.pathname.endsWith(".wasm")
        ) {
          return await fetch(new Request(request.url, { method: "GET" }));
        }
      }
      if (!engine.route(event)) return new Response(null, { status: 204 });
      const response = await runProxyWithMochiFallback(
        engine,
        event,
        realUrl,
        PROXY_NAV_TIMEOUT_MS,
        true,
        false,
      );
      if (response && response.ok) {
        const patched = await patchHtml(response, realUrl);
        try {
          const cacheKey = prefetchNavCacheKeyRequest(request.url);
          const cache = await caches.open(PREFETCH_CACHE);
          await cache.put(cacheKey, patched.clone());
          _prefetchTimes.set(urlKey, Date.now());
          capCache(PREFETCH_CACHE, MAX_PREFETCH_ENTRIES);
        } catch (e) {}
        return patched;
      }
      return response || new Response(null, { status: 204 });
    } catch (e) {
      return new Response(null, { status: 204 });
    }
  };
  const prefetchPromise = doFetch();
  _activePrefetches.set(urlKey, prefetchPromise);
  try {
    const res = await prefetchPromise;
    if (res && res.ok) {
      try {
        _prefetchedResponses.set(urlKey, res.clone());
        if (_prefetchedResponses.size > MAX_MEM) {
          const oldest = _prefetchedResponses.keys().next().value;
          _prefetchedResponses.delete(oldest);
        }
      } catch (e) {}
      try {
        res
          .clone()
          .text()
          .then((html) => warmSubresources(html, realUrl))
          .catch(() => {});
      } catch (e) {}
    }
    return res ? res.clone() : new Response(null, { status: 204 });
  } catch (e) {
    return new Response(null, { status: 204 });
  } finally {
    _activePrefetches.delete(urlKey);
  }
}

async function prefetchProxiedNavFromClient(urlStr) {
  let u;
  try {
    u = new URL(urlStr);
  } catch (e) {
    return;
  }
  if (u.origin !== self.location.origin) return;
  const p = u.pathname;
  if (!p.startsWith("/b/s/") && !p.startsWith("/b/u/")) return;
  if (adBlocked(adTarget(urlStr), false)) return;
  if (!trackPrefetchUrl(urlStr)) return;
  const req = new Request(urlStr, { method: "GET" });
  const event = {
    request: req,
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
    const res = await handlePrefetchProxyRequest(event);
    if (!res || !res.ok) return;
  } catch (e) {
    return;
  }
}

async function warmSubresources(htmlText, navRealUrl) {
  try {
    if (!htmlText || htmlText.length < 50) return;
    const urls = [];
    const linkRe = /<link\b[^>]*>/gi;
    let m;
    while ((m = linkRe.exec(htmlText)) !== null && urls.length < 8) {
      const tag = m[0];
      const relM = tag.match(/\brel\s*=\s*["']([^"']+)["']/i);
      if (!relM) continue;
      const rel = relM[1].toLowerCase();
      if (rel !== "stylesheet" && rel !== "preload" && rel !== "modulepreload")
        continue;
      if (rel === "preload" || rel === "modulepreload") {
        const asM = tag.match(/\bas\s*=\s*["']([^"']+)["']/i);
        if (asM && (asM[1] === "script" || asM[1] === "worker")) continue;
      }
      const hrefM = tag.match(/\bhref\s*=\s*["']([^"']+)["']/i);
      if (!hrefM) continue;
      const href = hrefM[1];
      if (!href || href.startsWith("data:") || href.startsWith("blob:"))
        continue;
      try {
        urls.push(new URL(href, self.location.origin).href);
      } catch (e) {}
    }
    if (urls.length === 0) return;
    const jobs = [];
    for (const proxyUrl of urls) {
      try {
        const u = new URL(proxyUrl);
        if (u.origin !== self.location.origin) continue;
        const rUrl = unwrapUrl(u);
        if (!rUrl || !rUrl.startsWith("http")) continue;
        const ext = urlExt(rUrl);
        if (ext === ".js" || ext === ".mjs") continue;
        jobs.push(
          (async () => {
            try {
              const req = new Request(proxyUrl, { method: "GET" });
              const cached = await caches.match(req);
              if (cached) return;
              const resp = await tryWithTimeout(mochiFetch(req, rUrl), 8000);
              if (resp && resp.ok) {
                const c = await caches.open(RUNTIME_CACHE);
                await c.put(req, resp.clone());
                capCache(RUNTIME_CACHE, MAX_RUNTIME);
              }
            } catch (e) {}
          })(),
        );
      } catch (e) {}
    }
    if (jobs.length > 0) {
      await Promise.allSettled(jobs);
    }
  } catch (e) {}
}