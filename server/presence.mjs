export function createPresence() {
  const clients = new Set();
  const encoder = new TextEncoder();
  let heartbeat;
  let pending = false;

  function broadcast() {
    if (pending) return;
    pending = true;
    queueMicrotask(() => {
      pending = false;
      const frame = encoder.encode(`data: ${clients.size}\n\n`);
      for (const client of clients) client.send(frame);
    });
  }

  return function connect(signal) {
    let client;
    const body = new ReadableStream({
      start(controller) {
        const remove = () => {
          if (!clients.delete(client)) return;
          signal.removeEventListener("abort", remove);
          try {
            controller.close();
          } catch {}
          if (!clients.size) {
            clearInterval(heartbeat);
            heartbeat = undefined;
          }
          broadcast();
        };
        client = {
          remove,
          send(frame) {
            if (controller.desiredSize <= 0) {
              remove();
              return;
            }
            controller.enqueue(frame);
          },
        };
        if (signal.aborted) {
          controller.close();
          return;
        }
        clients.add(client);
        signal.addEventListener("abort", remove, { once: true });
        if (!heartbeat) {
          heartbeat = setInterval(broadcast, 15_000);
          heartbeat.unref?.();
        }
        broadcast();
      },
      cancel() {
        client.remove();
      },
    });
    return new Response(body, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-store, no-transform",
        "X-Accel-Buffering": "no",
      },
    });
  };
}
