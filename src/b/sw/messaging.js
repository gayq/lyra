async function broadcastMeta() {
  await new Promise((r) => setTimeout(r, 0));
  while (metaPending) {
    const job = metaPending;
    metaPending = null;
    const clients = await self.clients.matchAll({
      includeUncontrolled: true,
      type: "window",
    });
    for (let i = 0; i < clients.length; i++) {
      const client = clients[i];
      if (job.sourceId && client.id === job.sourceId) continue;
      try {
        client.postMessage(job.payload);
      } catch (e) {}
    }
  }
  metaFlush = null;
}

self.addEventListener("message", (event) => {
  const data = event?.data;
  if (!data) return;

  if (
    data.type === "mochi-base" &&
    typeof data.base === "string" &&
    data.base.startsWith("http")
  ) {
    self.__MOCHI_BASE__ = data.base.replace(/\/+$/, "") + "/";
    return;
  }

  if (data.type === "open-new-tab" && data.url) {
    const sanitizedUrl = typeof data.url === "string" ? data.url : null;
    if (!sanitizedUrl) return;
    const payload = {
      type: "open-new-tab",
      url: sanitizedUrl,
      decodedUrl:
        typeof data.decodedUrl === "string" ? data.decodedUrl : sanitizedUrl,
      openerUrl: typeof data.openerUrl === "string" ? data.openerUrl : null,
      tabId: data.tabId || null,
      isTopFrame: !!data.isTopFrame,
      cause: data.cause || null,
    };
    event.waitUntil(
      (async () => {
        const clients = await self.clients.matchAll({
          includeUncontrolled: true,
          type: "window",
        });
        for (const client of clients) client.postMessage(payload);
      })(),
    );
    return;
  }

  if (data.type === "page-meta") {
    const payload = {
      type: "page-meta",
      url: data.url || data.href || null,
      decodedUrl: data.decodedUrl || data.url || data.href || null,
      title: typeof data.title === "string" ? data.title : "",
      favicon: data.favicon || data.rawFavicon || null,
      rawFavicon: data.rawFavicon || data.favicon || null,
      tabId: data.tabId || null,
      isTopFrame: !!data.isTopFrame,
      clientId: event.source && "id" in event.source ? event.source.id : null,
      collectedAt: Date.now(),
      encoded: !!data.encoded,
    };
    const sourceId =
      event.source && "id" in event.source ? event.source.id : null;
    if (event.source && typeof event.source.postMessage === "function") {
      event.source.postMessage(payload);
    }
    metaPending = { payload, sourceId };
    if (!metaFlush) {
      metaFlush = broadcastMeta();
      event.waitUntil(metaFlush);
    }
    return;
  }

  if (data.type === "waves-prefetch" && typeof data.url === "string") {
    event.waitUntil(prefetchProxiedNavFromClient(data.url));
  }
});