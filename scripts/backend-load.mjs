import { availableParallelism } from "os";

const NEGATIVE = "... /ᐠ - ˕ -マ";
const POSITIVE = "!! (˵◝ ⩊  ◜˵マ";
const args = process.argv.slice(2);

function values(name) {
  const found = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === name && args[index + 1]) found.push(args[index + 1]);
  }
  return found;
}

function numberValue(name, fallback) {
  const value = Number.parseInt(values(name).at(-1) || "", 10);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

const urls = values("--url");
const durationSeconds = numberValue("--duration", 15);
const concurrency = numberValue("--concurrency", Math.max(4, availableParallelism() * 8));
const timeoutMs = numberValue("--timeout", 10_000);

if (urls.length === 0) {
  console.error(`at least one --url is required${NEGATIVE}`);
  process.exit(1);
}

function percentile(sorted, value) {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * value))];
}

async function benchmark(url) {
  const deadline = performance.now() + durationSeconds * 1000;
  const latencies = [];
  let requests = 0;
  let failures = 0;
  let bytes = 0;

  async function worker() {
    while (performance.now() < deadline) {
      const startedAt = performance.now();
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await fetch(url, {
          cache: "no-store",
          signal: controller.signal,
        });
        const body = await response.arrayBuffer();
        requests += 1;
        bytes += body.byteLength;
        if (!response.ok) failures += 1;
      } catch {
        requests += 1;
        failures += 1;
      } finally {
        clearTimeout(timeout);
        latencies.push(performance.now() - startedAt);
      }
    }
  }

  const startedAt = performance.now();
  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  const elapsedSeconds = (performance.now() - startedAt) / 1000;
  latencies.sort((left, right) => left - right);
  return {
    url,
    concurrency,
    duration_seconds: Number(elapsedSeconds.toFixed(3)),
    requests,
    failures,
    requests_per_second: Number((requests / elapsedSeconds).toFixed(2)),
    mebibytes_per_second: Number((bytes / 1024 / 1024 / elapsedSeconds).toFixed(2)),
    latency_ms: {
      p50: Number(percentile(latencies, 0.5).toFixed(2)),
      p95: Number(percentile(latencies, 0.95).toFixed(2)),
      p99: Number(percentile(latencies, 0.99).toFixed(2)),
      maximum: Number((latencies.at(-1) || 0).toFixed(2)),
    },
  };
}

const reports = [];
for (const url of urls) reports.push(await benchmark(url));
console.log(JSON.stringify({ reports }, null, 2));
if (reports.some((report) => report.failures > 0)) {
  console.error(`backend load check completed with failures${NEGATIVE}`);
  process.exitCode = 1;
} else {
  console.log(`backend load check completed${POSITIVE}`);
}