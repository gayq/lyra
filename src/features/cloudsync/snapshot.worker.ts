import { snapshotPayload } from "./snapshotPayload.ts";

self.onmessage = async (event: MessageEvent<{ id: number; input: unknown }>) => {
  const { id, input } = event.data;
  try {
    self.postMessage({ id, output: await snapshotPayload(input) });
  } catch {
    self.postMessage({ id, failed: true });
  }
};
