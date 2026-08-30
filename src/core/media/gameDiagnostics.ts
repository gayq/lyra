type GameMetricStage =
  | "catalog"
  | "launch"
  | "iframe-load"
  | "iframe-timeout";

export type GameMetric = {
  stage: GameMetricStage;
  source?: string;
  cache?: "memory" | "fresh-local" | "stale-local" | "network" | "error";
  status?: "started" | "success" | "error";
  durationMs: number;
  games?: number;
  attempts?: number;
  errorKind?: string;
  urlHost?: string;
  at: number;
};

const MAX_METRICS = 200;
const metrics: GameMetric[] = [];

function notify(metric: GameMetric): void {
  if (typeof window === "undefined") return;
  try {
    window.dispatchEvent(new CustomEvent("lyra:game-metric", { detail: metric }));
  } catch {
    
  }
}

export function recordGameMetric(
  metric: Omit<GameMetric, "at"> & { at?: number },
): GameMetric {
  const next = { ...metric, at: metric.at ?? Date.now() };
  metrics.push(next);
  if (metrics.length > MAX_METRICS) metrics.splice(0, metrics.length - MAX_METRICS);
  notify(next);
  return next;
}

export function hostFromUrl(value: string): string | undefined {
  try {
    return new URL(value, "http://localhost").hostname || undefined;
  } catch {
    return undefined;
  }
}
