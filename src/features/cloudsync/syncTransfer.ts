import { negativeMessage } from "../../core/runtime/messages.ts";

const CHUNK_SIZE = 1024 * 1024;
const REQUEST_TIMEOUT = 60_000;
const TRANSFER_CONCURRENCY = 3;

async function request(
  url: string,
  options: RequestInit = {},
): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);
    let retryAfter = 0;
    try {
      const response = await fetch(url, {
        credentials: "same-origin",
        ...options,
        signal: controller.signal,
      });
      const body = await response.blob();
      if (attempt === 3 || (response.status !== 429 && response.status < 500)) {
        return new Response(body, {
          status: response.status,
          headers: response.headers,
        });
      }
      const seconds = Number(response.headers.get("retry-after"));
      if (Number.isFinite(seconds)) retryAfter = Math.max(0, seconds * 1000);
    } catch {
      if (attempt === 3)
        throw new Error(negativeMessage("sync connection failed"));
    } finally {
      clearTimeout(timer);
    }
    await new Promise((resolve) =>
      setTimeout(resolve, Math.max(retryAfter, 500 * 2 ** attempt)),
    );
  }
}

async function transferParts(
  parts: number,
  transfer: (part: number) => Promise<Response>,
): Promise<Response | null> {
  let next = 0;
  let stopped = false;
  let failure: Response | null = null;
  const workers = Array.from(
    { length: Math.min(TRANSFER_CONCURRENCY, parts) },
    async () => {
      while (!stopped && next < parts) {
        const part = next++;
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
  const snapshot = typeof body === "string" ? new Blob([body]) : body;
  const parts = Math.ceil(snapshot.size / CHUNK_SIZE);
  const started = await request("/api/sync/transfer", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ parts }),
  });
  if (!started.ok) return started;
  const { id, chunk_size } = await started.json();
  if (
    typeof id !== "string" ||
    !/^[a-f0-9]{32}$/.test(id) ||
    chunk_size !== CHUNK_SIZE
  ) {
    throw new Error(negativeMessage("sync transfer is unavailable"));
  }
  const failure = await transferParts(parts, async (part) => {
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
    return request(`/api/sync/transfer/${id}/${part}`, {
      method: "PUT",
      headers,
      body: chunk,
    });
  });
  if (failure) return failure;
  return request(`/api/sync/transfer/${id}/commit`, { method: "POST" });
}

export async function downloadSnapshot(): Promise<Response> {
  const response = await request("/api/sync/transfer");
  if (!response.ok) return response;
  const manifest = await response.json();
  if (manifest.legacy === true) return request("/api/sync/download");
  if (
    typeof manifest.id !== "string" ||
    !/^[a-f0-9]{32}$/.test(manifest.id) ||
    !Number.isSafeInteger(manifest.parts) ||
    manifest.parts <= 0 ||
    typeof manifest.updated_at !== "string"
  ) {
    throw new Error(negativeMessage("synced data is unavailable"));
  }
  const chunks: Blob[] = [];
  const failure = await transferParts(manifest.parts, async (part) => {
    const chunk = await request(`/api/sync/transfer/${manifest.id}/${part}`);
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
