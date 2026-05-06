self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(SHELL_CACHE)
      .then((cache) => cache.addAll(PRECACHE).catch(() => {}))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    Promise.all([
      caches.keys().then((keys) => {
        return Promise.all(
          keys
            .filter(
              (k) =>
                k.startsWith("waves-") &&
                k !== SHELL_CACHE &&
                k !== RUNTIME_CACHE &&
                k !== PREFETCH_CACHE &&
                k !== LARGE_CACHE,
            )
            .map((k) => caches.delete(k)),
        );
      }),
      self.registration.navigationPreload
        ? self.registration.navigationPreload.enable()
        : Promise.resolve(),
    ]).then(() => self.clients.claim()),
  );
});

function adBlockedResponse(request, url, isNavigate) {
  const dest = request.destination;
  const accept = request.headers.get("Accept") || "";
  let body = ":3";
  let contentType = "text/plain";
  if (dest === "script" || url.pathname.endsWith(".js")) {
    body =
      'window.ga=function(){return":3"};window.ga.q=[":3"];window.dataLayer=[":3"];window.dataLayer.push=function(){return":3"};window.fbq=function(){return":3"};window.googletag={cmd:{push:function(){return":3"}}};window._paq=[":3"];window._paq.push=function(){return":3"};';
    contentType = "application/javascript";
  } else if (dest === "image" || accept.includes("image/")) {
    body = new Uint8Array([
      71, 73, 70, 56, 57, 97, 1, 0, 1, 0, 128, 0, 0, 0, 0, 0, 255, 255, 255,
      33, 249, 4, 1, 0, 0, 0, 0, 44, 0, 0, 0, 0, 1, 0, 1, 0, 0, 2, 2, 68, 1,
      0, 59,
    ]);
    contentType = "image/gif";
  } else if (isNavigate || dest === "document") {
    body =
      '<html><head><title>:3</title></head><body style="display:flex;justify-content:center;align-items:center;height:100vh;margin:0;font-family:monospace;font-size:2rem;">:3</body></html>';
    contentType = "text/html";
  } else if (accept.includes("application/json")) {
    body = '{"status": ":3", "message": ":3"}';
    contentType = "application/json";
  }
  return new Response(body, {
    status: 200,
    statusText: ":3",
    headers: {
      "Content-Type": contentType,
      "Access-Control-Allow-Origin": "*",
    },
  });
}

async function handleLargeFile(request, realUrl) {
  try {
    if (!isRangeRequest(request)) {
      const cache = await caches.open(LARGE_CACHE);
      const cached = await cache.match(request);
      if (cached) {
        fetchLargeFileStreaming(request, realUrl, LARGE_TIMEOUT_MS)
          .then((fresh) => {
            if (fresh && fresh.ok) {
              cache.put(request, fresh.clone());
              capCache(LARGE_CACHE, MAX_LARGE_CACHE_ENTRIES);
            }
          })
          .catch(() => {});
        return cached;
      }
    }
    const response = await fetchLargeFileStreaming(
      request,
      realUrl,
      LARGE_TIMEOUT_MS,
    );
    if (response && response.ok) {
      if (!isRangeRequest(request)) {
        const cache = await caches.open(LARGE_CACHE);
        cache.put(request, response.clone()).catch(() => {});
        capCache(LARGE_CACHE, MAX_LARGE_CACHE_ENTRIES);
      }
      return response;
    }
    const fallback = await tryWithTimeout(
      mochiFetch(request, realUrl),
      LARGE_TIMEOUT_MS,
    );
    return fallback || new Response("gateway timeout", { status: 504 });
  } catch (e) {
    const fallback = await tryWithTimeout(
      mochiFetch(request, realUrl),
      LARGE_TIMEOUT_MS,
    );
    return fallback || new Response("gateway timeout", { status: 504 });
  }
}

async function tryConsumeActivePrefetch(urlKey) {
  const active = _activePrefetches.get(urlKey);
  if (active) {
    try {
      const prefRes = await active;
      if (prefRes && prefRes.ok) return prefRes.clone();
    } catch (e) {}
  }
  if (_prefetchedResponses.has(urlKey)) {
    const memHit = _prefetchedResponses.get(urlKey);
    _prefetchedResponses.delete(urlKey);
    try {
      if (memHit && memHit.ok) return memHit.clone();
    } catch (e) {}
  }
  return null;
}

async function tryMatchPrefetchedNav(request, urlKey) {
  const lastAt = _prefetchTimes.get(urlKey);
  const age = lastAt ? Date.now() - lastAt : Infinity;
  if (age < PREFETCH_VALIDITY) {
    const prefHit = await matchPrefetchedNavHtml(request);
    if (prefHit) return prefHit.clone();
  } else if (_prefetchTimes.has(urlKey)) {
    _prefetchTimes.delete(urlKey);
  }
  return null;
}

async function runProxyEngine(engine, event, request, url, realUrl, isNavigate) {
  if (isNavigate && request.method === "GET") {
    try {
      const urlKey = prefetchNavCacheKeyRequest(request.url).url;
      const prefetched = await tryConsumeActivePrefetch(urlKey);
      if (prefetched) return prefetched;
      const navHit = await tryMatchPrefetchedNav(request, urlKey);
      if (navHit) return navHit;
    } catch (e) {}
  }
  const timeoutMs = isNavigate
    ? PROXY_NAV_TIMEOUT_MS
    : PROXY_SUBRESOURCE_TIMEOUT_MS;
  try {
    const response = await runProxyWithMochiFallback(
      engine,
      event,
      realUrl,
      timeoutMs,
      isNavigate,
      true,
    );
    if (response) return patchHtml(response, realUrl);
    return timeoutFallbackResponse(request, url);
  } catch (e) {
    notifyTransportError();
    if (realUrl && realUrl.startsWith("http")) {
      const m = await tryWithTimeout(
        mochiFetch(request, realUrl),
        MOCHI_SECONDARY_MS,
      );
      if (m) return patchHtml(m, realUrl);
    }
    return timeoutFallbackResponse(request, url);
  }
}

async function handleLocalOriginGet(event, request, url, preloadPromise) {
  const path = url.pathname;
  if (
    request.destination === "document" ||
    path === "/" ||
    path.endsWith(".html")
  ) {
    let networkRes = null;
    try {
      const preloaded = await preloadPromise;
      if (preloaded && (preloaded.ok || preloaded.status === 304)) {
        networkRes = preloaded;
      } else {
        networkRes = await fetch(request).catch(() => null);
      }
    } catch (e) {
      networkRes = await fetch(request).catch(() => null);
    }
    if (networkRes && networkRes.ok) {
      const clone = networkRes.clone();
      caches
        .open(SHELL_CACHE)
        .then((c) => c.put(request, clone).catch(() => {}));
      return networkRes;
    }
    if (networkRes && networkRes.status === 304) return networkRes;
    const cached = await caches.match(request);
    if (cached) return cached;
    if (networkRes) return networkRes;
    return new Response("offline", { status: 503 });
  }
  if (
    CACHEABLE_EXT.test(path) ||
    path.startsWith("/assets/") ||
    path.startsWith("/bmux/") ||
    path.startsWith("/epoxy/") ||
    path.startsWith("/libcurl/") ||
    path.startsWith("/s/")
  ) {
    const isHashed = HASHED_ASSET_REGEX.test(path);
    const cached = await caches.match(request);
    if (cached) {
      if (!isHashed) {
        fetch(request)
          .then((res) => {
            if (res && res.ok) {
              caches.open(RUNTIME_CACHE).then((c) => {
                c.put(request, res);
                capCache(RUNTIME_CACHE, MAX_RUNTIME);
              });
            }
          })
          .catch(() => {});
      }
      return cached;
    }
    const res = await fetch(request).catch(() => null);
    if (res && res.ok) {
      const clone = res.clone();
      caches.open(RUNTIME_CACHE).then((c) => {
        c.put(request, clone);
        capCache(RUNTIME_CACHE, MAX_RUNTIME);
      });
      return res;
    }
    if (res) return res;
  }
  return await fetch(request);
}

async function handleCacheableCrossOrigin(request, url, realUrl) {
  const ext = urlExt(realUrl);
  const dest = request.destination;
  const accept = request.headers.get("Accept") || "";
  const isCacheableAsset =
    dest === "video" ||
    dest === "audio" ||
    dest === "image" ||
    dest === "font" ||
    dest === "track" ||
    accept.startsWith("image/") ||
    accept.startsWith("video/") ||
    accept.startsWith("audio/") ||
    accept.startsWith("font/") ||
    STATIC_REGEX.test(url.pathname) ||
    CACHEABLE_ASSET_EXTS.has(ext);
  const preferProxyOverMochi =
    (isScramjet || isUltraviolet) &&
    (dest === "script" || ext === ".js" || ext === ".mjs");
  if (
    !isCacheableAsset ||
    realUrl.includes(self.location.host) ||
    preferProxyOverMochi
  ) {
    return null;
  }
  try {
    const cached = await caches.match(request);
    const networkFetch = tryWithTimeout(
      mochiFetch(request, realUrl),
      MOCHI_TIMEOUT_MS,
    );
    if (cached) {
      networkFetch
        .then((fresh) => {
          if (fresh && fresh.ok) {
            caches.open(RUNTIME_CACHE).then((c) => {
              c.put(request, fresh);
              capCache(RUNTIME_CACHE, MAX_RUNTIME);
            });
          }
        })
        .catch(() => {});
      return cached;
    }
    const mochiResponse = await networkFetch;
    if (mochiResponse && mochiResponse.ok) {
      const clone = mochiResponse.clone();
      caches.open(RUNTIME_CACHE).then((c) => {
        c.put(request, clone);
        capCache(RUNTIME_CACHE, MAX_RUNTIME);
      });
      return mochiResponse;
    }
  } catch (e) {}
  return null;
}

self.addEventListener("fetch", (event) => {
  const { request } = event;

  if (request.headers.get(PREFETCH_HEADER) === "1") {
    event.respondWith(handlePrefetchProxyRequest(event));
    return;
  }

  const dest = request.destination;
  const isNavigate =
    request.mode === "navigate" ||
    dest === "document" ||
    dest === "iframe" ||
    dest === "frame";
  const url = new URL(request.url);

  if (adBlocked(adTarget(request.url), isNavigate)) {
    return event.respondWith(adBlockedResponse(request, url, isNavigate));
  }

  const realUrl = unwrapUrl(url);

  if (url.pathname.startsWith(MOCHI_PREFIX)) {
    let afterPrefix = url.pathname.slice(MOCHI_PREFIX.length);
    if (afterPrefix.endsWith("/")) afterPrefix = afterPrefix.slice(0, -1);
    if (afterPrefix.startsWith("http")) return;
    let decodedUrl = null;
    try {
      let p = afterPrefix.replace(/-/g, "+").replace(/_/g, "/");
      while (p.length % 4) p += "=";
      const raw = atob(p);
      const dec = _adXorDec(raw);
      const result = decodeURIComponent(dec);
      if (result.startsWith("http")) decodedUrl = result;
    } catch (e) {}
    if (decodedUrl) {
      return event.respondWith(
        (async () => {
          try {
            const cached = await caches.match(request);
            if (cached) return cached;
            const r = await tryWithTimeout(
              mochiFetch(request, decodedUrl),
              MOCHI_TIMEOUT_MS,
            );
            if (r && r.ok) {
              const clone = r.clone();
              caches.open(RUNTIME_CACHE).then((c) => {
                c.put(request, clone);
                capCache(RUNTIME_CACHE, MAX_RUNTIME);
              });
              return r;
            }
            return r || new Response("not found", { status: 404 });
          } catch (e) {
            return new Response("error", { status: 502 });
          }
        })(),
      );
    }
    return;
  }

  if (realUrl && realUrl.startsWith("http") && isLargeFile(realUrl, request)) {
    return event.respondWith(handleLargeFile(request, realUrl));
  }

  if (realUrl && realUrl.includes("/!!/")) {
    const parts = realUrl.split("/!!/");
    const target = parts.pop();
    if (target && target.startsWith("http")) {
      return event.respondWith(
        (async () => {
          const r = await tryWithTimeout(
            mochiFetch(request, target),
            MOCHI_TIMEOUT_MS,
          );
          return r || new Response("gateway timeout", { status: 504 });
        })(),
      );
    }
  }

  event.respondWith(
    (async () => {
      try {
        const preloadPromise =
          event.preloadResponse &&
          typeof event.preloadResponse.then === "function"
            ? event.preloadResponse.catch(() => null)
            : Promise.resolve(null);

        if (realUrl && realUrl.startsWith("http")) {
          const cacheHit = await handleCacheableCrossOrigin(
            request,
            url,
            realUrl,
          );
          if (cacheHit) return cacheHit;
        }

        if (isScramjet) {
          await ensureScramjetConfig();
          if (
            url.pathname.startsWith("/b/s/jetty.") &&
            !url.pathname.endsWith(".wasm")
          ) {
            return fetch(request);
          }
          if (scramjet.route(event)) {
            return await runProxyEngine(
              scramjet,
              event,
              request,
              url,
              realUrl,
              isNavigate,
            );
          }
        }

        if (isUltraviolet && uv.route(event)) {
          return await runProxyEngine(
            uv,
            event,
            request,
            url,
            realUrl,
            isNavigate,
          );
        }

        if (url.origin === self.location.origin && request.method === "GET") {
          return await handleLocalOriginGet(event, request, url, preloadPromise);
        }

        return new Response(":3", { status: 403 });
      } catch (err) {
        if (realUrl && !realUrl.includes(self.location.host)) {
          const mf = await tryWithTimeout(
            mochiFetch(request, realUrl),
            MOCHI_TIMEOUT_MS,
          );
          if (mf) return patchHtml(mf, realUrl);
        }
        const fallback = await caches.match(request);
        if (fallback) return fallback;
        return new Response("error", { status: 500 });
      }
    })(),
  );
});