import { useEffect, useState } from "preact/hooks";
import { appPath } from "../../core/runtime/hosting";

export default function Footer() {
  const [clients, setClients] = useState<number | null>(null);

  useEffect(() => {
    let events: EventSource | undefined;
    let stale: ReturnType<typeof setTimeout> | undefined;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let retryDelay = 1_000;
    let paused = false;
    const disconnect = () => {
      if (events) {
        events.onmessage = null;
        events.onerror = null;
        events.close();
      }
      events = undefined;
      clearTimeout(stale);
      clearTimeout(retry);
      setClients(null);
    };
    const reconnect = () => {
      disconnect();
      if (paused || !navigator.onLine) return;
      retry = setTimeout(connect, retryDelay);
      retryDelay = Math.min(retryDelay * 2, 30_000);
    };
    const connect = () => {
      if (events || paused || !navigator.onLine) return;
      clearTimeout(retry);
      events = new EventSource(appPath("/api/presence"));
      stale = setTimeout(reconnect, 35_000);
      events.onmessage = (event) => {
        const count = Number(event.data);
        if (!Number.isSafeInteger(count) || count < 1) return;
        setClients(count);
        retryDelay = 1_000;
        clearTimeout(stale);
        stale = setTimeout(reconnect, 35_000);
      };
      events.onerror = reconnect;
    };
    const pause = () => { paused = true; disconnect(); };
    const resume = () => { paused = false; connect(); };
    if (document.readyState === "complete") connect();
    else window.addEventListener("load", connect, { once: true });
    window.addEventListener("pagehide", pause);
    window.addEventListener("pageshow", resume);
    window.addEventListener("offline", disconnect);
    window.addEventListener("online", connect);
    return () => {
      pause();
      window.removeEventListener("load", connect);
      window.removeEventListener("pagehide", pause);
      window.removeEventListener("pageshow", resume);
      window.removeEventListener("offline", disconnect);
      window.removeEventListener("online", connect);
    };
  }, []);

  return (
    <div class="footer">
      <span class="client-count">
        <span class="client-count-value">{clients ?? "~"}</span>{" "}
        {clients === 1 ? "active client" : "active clients"}
      </span>
      <div id="cute">
        <a class="link" href="https://discord.gg/4GeWaGPh6c" target="_blank">
          discord
        </a>

        <a class="link" href="https://github.com/gayq/lyra" target="_blank">
          self-host
        </a>
      </div>
    </div>
  );
}
