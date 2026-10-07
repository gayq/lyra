import { useEffect, useState } from "preact/hooks";

export default function Footer() {
  const [clients, setClients] = useState<number | null>(null);

  useEffect(() => {
    let events: EventSource | undefined;
    let stale: ReturnType<typeof setTimeout> | undefined;
    const disconnect = () => {
      events?.close();
      events = undefined;
      clearTimeout(stale);
      setClients(null);
    };
    const connect = () => {
      if (events) return;
      events = new EventSource("/api/presence");
      events.onmessage = (event) => {
        const count = Number(event.data);
        if (!Number.isSafeInteger(count) || count < 1) return;
        setClients(count);
        clearTimeout(stale);
        stale = setTimeout(() => {
          disconnect();
          connect();
        }, 35_000);
      };
      events.onerror = () => setClients(null);
    };
    if (document.readyState === "complete") connect();
    else window.addEventListener("load", connect, { once: true });
    window.addEventListener("pagehide", disconnect);
    window.addEventListener("pageshow", connect);
    window.addEventListener("offline", disconnect);
    window.addEventListener("online", connect);
    return () => {
      disconnect();
      window.removeEventListener("load", connect);
      window.removeEventListener("pagehide", disconnect);
      window.removeEventListener("pageshow", connect);
      window.removeEventListener("offline", disconnect);
      window.removeEventListener("online", connect);
    };
  }, []);

  return (
    <div class="footer">
      <span class="client-count">
        {clients === null
          ? "— active clients"
          : `${clients} ${clients === 1 ? "active client" : "active clients"}`}
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
