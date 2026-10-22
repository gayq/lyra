import { timingSafeEqual } from "node:crypto";
import { monitorEventLoopDelay } from "node:perf_hooks";

const bounds = [5, 25, 100, 500, 1_000, 5_000, 25_000];

function routeGroup(pathname) {
  if (pathname.startsWith("/api/static/")) return "static_gateway";
  if (pathname === "/api/search/suggestions") return "suggestions";
  if (pathname === "/api/presence") return "presence";
  if (pathname === "/api/dns") return "dns";
  if (pathname.startsWith("/stream/")) return "stream";
  if (pathname.startsWith("/!!") || pathname.startsWith("/!cover!/")) return "proxy";
  if (pathname.startsWith("/api/")) return "api";
  return "static";
}

export function allowMetrics(req, peer, token) {
  if (!["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(peer)) return false;
  if (!token || req.headers.has("x-forwarded-for") || req.headers.has("forwarded")) return false;
  const supplied = Buffer.from(req.headers.get("authorization") || "");
  const expected = Buffer.from(`Bearer ${token}`);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

export function createMetrics() {
  const started = new Date().toISOString();
  const routes = {};
  const delay = monitorEventLoopDelay({ resolution: 20 });
  delay.enable();

  return {
    record(pathname, status, durationMs) {
      if (pathname === "/metrics" || pathname === "/health") return;
      const key = routeGroup(pathname);
      const route = routes[key] ||= {
        count: 0, status_classes: [0, 0, 0, 0, 0, 0],
        duration_ms_sum: 0, duration_ms_buckets: new Array(bounds.length + 1).fill(0),
      };
      route.count++;
      route.status_classes[Math.max(0, Math.min(5, Math.floor(status / 100)))]++;
      route.duration_ms_sum += durationMs;
      for (let i = 0; i < bounds.length; i++) {
        if (durationMs <= bounds[i]) route.duration_ms_buckets[i]++;
      }
      route.duration_ms_buckets[bounds.length]++;
    },
    snapshot() {
      return {
        started_at: started,
        uptime_seconds: process.uptime(),
        memory: process.memoryUsage(),
        cpu: process.cpuUsage(),
        event_loop_delay_ms: {
          mean: Number.isFinite(delay.mean) ? delay.mean / 1e6 : 0,
          p95: delay.percentile(95) / 1e6,
          max: delay.max / 1e6,
        },
        header_duration_ms_bounds: [...bounds, "+Inf"],
        routes: structuredClone(routes),
      };
    },
    close() { delay.disable(); },
  };
}
