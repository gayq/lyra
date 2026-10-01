import { backgroundTask } from "../../core/runtime/backgroundTask.ts";
import { snapshotPayload } from "./snapshotPayload.ts";

export const prepareSnapshot = backgroundTask(
  () => new Worker(new URL("./snapshot.worker.ts", import.meta.url), {
    type: "module",
  }),
  snapshotPayload,
);
