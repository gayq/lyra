export const BROWSER_ID = /^[A-Za-z0-9_-]{16,64}$/;

export function createPresence({ leaseMs = 60_000, graceMs = 5_000, maxStreamsPerSource = Infinity, greet } = {}) {
  const browsers = new Map();
  const sourceStreams = new Map();
  const encoder = new TextEncoder();
  const renewFrame = encoder.encode("event: renew\ndata:\n\n");
  let heartbeat;
  let pending = false;

  const countFrame = () => encoder.encode(`data: ${browsers.size}\n\n`);

  function broadcast() {
    if (pending) return;
    pending = true;
    queueMicrotask(() => {
      pending = false;
      const frame = countFrame();
      for (const browser of browsers.values()) {
        for (const stream of browser.streams) stream.send(frame);
      }
    });
  }

  function drop(id, browser) {
    browser.expiry = undefined;
    if (browser.streams.size || browsers.get(id) !== browser) return;
    browsers.delete(id);
    if (!browsers.size) {
      clearInterval(heartbeat);
      heartbeat = undefined;
    }
    broadcast();
  }

  function release(id, browser, renewing) {
    if (browser.streams.size || browser.expiry) return;
    if (!renewing) return drop(id, browser);
    browser.expiry = setTimeout(() => drop(id, browser), graceMs);
    browser.expiry.unref?.();
  }

  function connect(signal, requestedId, source) {
    if (source !== undefined && (sourceStreams.get(source) || 0) >= maxStreamsPerSource) return null;
    const id = typeof requestedId === "string" && BROWSER_ID.test(requestedId)
      ? requestedId
      : crypto.randomUUID();
    let end = () => {};
    const body = new ReadableStream({
      start(controller) {
        if (signal.aborted) {
          controller.close();
          return;
        }
        let browser = browsers.get(id);
        const joined = !browser;
        if (!browser) browsers.set(id, (browser = { streams: new Set(), expiry: undefined }));
        clearTimeout(browser.expiry);
        browser.expiry = undefined;

        const stream = {
          send(frame) {
            if (controller.desiredSize > 0) controller.enqueue(frame);
          },
        };
        const abort = () => end(false);
        const lease = setTimeout(() => end(true), leaseMs * (0.75 + Math.random() * 0.5));
        lease.unref?.();
        end = (renew) => {
          if (!browser.streams.delete(stream)) return;
          if (source !== undefined) {
            const open = sourceStreams.get(source) - 1;
            if (open) sourceStreams.set(source, open);
            else sourceStreams.delete(source);
          }
          clearTimeout(lease);
          signal.removeEventListener("abort", abort);
          try {
            if (renew) controller.enqueue(renewFrame);
            controller.close();
          } catch {}
          release(id, browser, renew);
        };
        browser.streams.add(stream);
        if (source !== undefined) sourceStreams.set(source, (sourceStreams.get(source) || 0) + 1);
        signal.addEventListener("abort", abort, { once: true });
        if (!heartbeat) {
          heartbeat = setInterval(broadcast, 15_000);
          heartbeat.unref?.();
        }
        const greeting = greet?.(id);
        if (greeting) stream.send(greeting);
        if (joined) broadcast();
        else stream.send(countFrame());
      },
      cancel() {
        end(false);
      },
    }, { highWaterMark: 16 });
    return new Response(body, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-store, no-transform",
        "X-Accel-Buffering": "no",
      },
    });
  }

  connect.publish = (frame) => {
    for (const browser of browsers.values()) {
      for (const stream of browser.streams) stream.send(frame);
    }
  };
  connect.has = (id) => browsers.has(id);

  return connect;
}
