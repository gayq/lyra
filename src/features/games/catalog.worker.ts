import { processCatalog } from "./catalogProcessing.ts";

self.onmessage = (
  event: MessageEvent<{ id: number; input: Parameters<typeof processCatalog>[0] }>,
) => {
  const { id, input } = event.data;
  try {
    self.postMessage({ id, output: processCatalog(input) });
  } catch {
    self.postMessage({ id, failed: true });
  }
};
