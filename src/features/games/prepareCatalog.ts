import { backgroundTask } from "../../core/runtime/backgroundTask.ts";
import { processCatalog } from "./catalogProcessing.ts";

export const prepareCatalog = backgroundTask(
  () => new Worker(new URL("./catalog.worker.ts", import.meta.url), {
    type: "module",
  }),
  processCatalog,
);
