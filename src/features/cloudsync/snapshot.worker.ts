import { snapshotPayload } from "./snapshotPayload.ts";
import type { SyncKeys } from "./syncCrypto.ts";

self.onmessage = async (
  event: MessageEvent<{
    id: number;
    input: { snapshot: unknown; keys?: SyncKeys | null };
  }>,
) => {
  const { id, input } = event.data;
  try {
    self.postMessage({
      id,
      output: await snapshotPayload(input.snapshot, input.keys),
    });
  } catch {
    self.postMessage({ id, failed: true });
  }
};
