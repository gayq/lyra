import { backgroundTask } from "../../core/runtime/backgroundTask.ts";
import { snapshotPayload } from "./snapshotPayload.ts";
import type { SyncKeys } from "./syncCrypto.ts";

export const prepareSnapshot = backgroundTask(
  () => new Worker(new URL("./snapshot.worker.ts", import.meta.url), {
    type: "module",
  }),
  ({ snapshot, keys }: { snapshot: unknown; keys?: SyncKeys | null }) =>
    snapshotPayload(snapshot, keys),
);
