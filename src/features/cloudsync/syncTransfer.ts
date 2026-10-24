import { negativeMessage } from "../../core/runtime/messages.ts";

const CHUNK_SIZE = 1024 * 1024;
const MAX_SNAPSHOT_BYTES = 80 * CHUNK_SIZE;
const MAX_PARTS = MAX_SNAPSHOT_BYTES / CHUNK_SIZE;
const REQUEST_TIMEOUT = 60_000;
const TRANSFER_TIMEOUT = 5 * 60_000;

function remaining(deadline: number): number {
  const budget = deadline - Date.now();
  if (budget <= 0) throw new Error(negativeMessage("sync transfer timed out"));
  return budget;
}

function concurrency(value: unknown): number {
  return Number.isSafeInteger(value) && Number(value) > 0
    ? Math.min(Number(value), 2)
    : 1;
}

async function request(
  url: string,
  deadline: number,
  options: RequestInit = {},
): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      Math.min(REQUEST_TIMEOUT, remaining(deadline)),
    );
    let retryAfter = 0;
    try {
      const response = await fetch(url, {
        credentials: "same-origin",
        ...options,
        signal: controller.signal,
      });
      const body = await response.blob();
      remaining(deadline);
      if (attempt === 3 || (response.status !== 429 && response.status < 500)) {
        return new Response(body, {
          status: response.status,
          headers: response.headers,
        });
      }
      const header = response.headers.get("retry-after");
      const seconds = Number(header);
      retryAfter = Number.isFinite(seconds)
        ? Math.max(0, seconds * 1000)
        : Math.max(0, Date.parse(header || "") - Date.now()) || 0;
    } catch {
      remaining(deadline);
      if (attempt === 3)
        throw new Error(negativeMessage("sync connection failed"));
    } finally {
      clearTimeout(timer);
    }
    const delay = Math.max(retryAfter, 500 * 2 ** attempt + Math.random() * 500);
    if (delay >= remaining(deadline))
      throw new Error(negativeMessage("sync transfer timed out"));
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
}

async function transferParts(
  parts: number[],
  allowance: number,
  transfer: (part: number) => Promise<Response>,
): Promise<Response | null> {
  let next = 0;
  let stopped = false;
  let failure: Response | null = null;
  const workers = Array.from(
    { length: Math.min(allowance, parts.length) },
    async () => {
      while (!stopped && next < parts.length) {
        const part = parts[next++]!;
        try {
          const response = await transfer(part);
          if (!response.ok) {
            failure ??= response;
            stopped = true;
          }
        } catch (error) {
          stopped = true;
          throw error;
        }
      }
    },
  );
  const results = await Promise.allSettled(workers);
  for (const result of results) {
    if (result.status === "rejected") throw result.reason;
  }
  return failure;
}

export async function uploadSnapshot(body: string | Blob): Promise<Response> {
  const deadline = Date.now() + TRANSFER_TIMEOUT;
  const snapshot = typeof body === "string" ? new Blob([body]) : body;
  if (!snapshot.size || snapshot.size > MAX_SNAPSHOT_BYTES) {
    return Response.json(
      { code: "sync_payload_too_large", error: negativeMessage("sync payload is too large") },
      { status: 413 },
    );
  }
  const parts = Math.ceil(snapshot.size / CHUNK_SIZE);
  const indexes = Array.from({ length: parts }, (_, part) => part);
  const hashes: string[] | undefined = globalThis.crypto?.subtle ? [] : undefined;
  if (hashes) {
    for (const part of indexes) {
      remaining(deadline);
      const bytes = await snapshot.slice(part * CHUNK_SIZE, (part + 1) * CHUNK_SIZE).arrayBuffer();
      const digest = await crypto.subtle.digest("SHA-256", bytes);
      hashes.push(Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join(""));
    }
  }
  const started = await request("/api/sync/transfer", deadline, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ parts, ...(hashes ? { hashes } : {}) }),
  });
  if (!started.ok) return started;
  const { id, chunk_size, missing, concurrency: allowance, max_bytes } = await started.json();
  if (
    typeof id !== "string" ||
    !/^[a-f0-9]{32}$/.test(id) ||
    chunk_size !== CHUNK_SIZE ||
    (max_bytes !== undefined && (!Number.isSafeInteger(max_bytes) || snapshot.size > max_bytes)) ||
    (missing !== undefined && (
      !Array.isArray(missing) ||
      missing.some((part: unknown) => !Number.isSafeInteger(part) || Number(part) < 0 || Number(part) >= parts) ||
      new Set(missing).size !== missing.length
    ))
  ) {
    throw new Error(negativeMessage("sync transfer is unavailable"));
  }
  const failure = await transferParts(missing ?? indexes, concurrency(allowance), async (part) => {
    remaining(deadline);
    let chunk = snapshot.slice(part * CHUNK_SIZE, (part + 1) * CHUNK_SIZE);
    const headers: Record<string, string> = {
      "Content-Type": "application/octet-stream",
    };
    if (typeof CompressionStream !== "undefined") {
      const compressed = await new Response(
        chunk.stream().pipeThrough(new CompressionStream("gzip")),
      ).blob();
      if (compressed.size < chunk.size) {
        chunk = compressed;
        headers["Content-Encoding"] = "gzip";
      }
    }
    return request(`/api/sync/transfer/${id}/${part}`, deadline, {
      method: "PUT",
      headers,
      body: chunk,
    });
  });
  if (failure) return failure;
  return request(`/api/sync/transfer/${id}/commit`, deadline, { method: "POST" });
}

export async function downloadSnapshot(): Promise<Response> {
  const deadline = Date.now() + TRANSFER_TIMEOUT;
  const response = await request("/api/sync/transfer", deadline);
  if (!response.ok) return response;
  const manifest = await response.json();
  if (manifest.legacy === true) return request("/api/sync/download", deadline);
  if (
    typeof manifest.id !== "string" ||
    !/^[a-f0-9]{32}$/.test(manifest.id) ||
    !Number.isSafeInteger(manifest.parts) ||
    manifest.parts <= 0 ||
    manifest.parts > MAX_PARTS ||
    typeof manifest.updated_at !== "string"
  ) {
    throw new Error(negativeMessage("synced data is unavailable"));
  }
  const chunks: Blob[] = [];
  const indexes = Array.from({ length: manifest.parts }, (_, part) => part);
  const failure = await transferParts(indexes, concurrency(manifest.concurrency), async (part) => {
    const chunk = await request(`/api/sync/transfer/${manifest.id}/${part}`, deadline);
    if (!chunk.ok) return chunk;
    const bytes = await chunk.blob();
    if (!bytes.size || bytes.size > CHUNK_SIZE) {
      throw new Error(negativeMessage("synced data is unavailable"));
    }
    chunks[part] = bytes;
    return chunk;
  });
  if (failure) return failure;
  return new Response(
    new Blob([
      '{"success":true,"data":',
      ...chunks,
      ',"updated_at":',
      JSON.stringify(manifest.updated_at),
      "}",
    ]),
    { headers: { "Content-Type": "application/json" } },
  );
}
