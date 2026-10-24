import { initializeStatic, staticFailure } from "./session.ts";
import { loadAdcash } from "../core/runtime/adcash.ts";
import { staticBackend } from "../core/runtime/hosting.ts";

void initializeStatic(true).then(() => {
  loadAdcash(staticBackend);
  return import("../app/playerEntry.tsx");
}).catch(staticFailure);
