import { initializeStatic, staticFailure } from "./session.ts";
import { loadAdcash } from "../core/runtime/adcash.ts";
import { staticBackend } from "../core/runtime/hosting.ts";

void initializeStatic().then(() => {
  loadAdcash(staticBackend);
  return import("../app/entry.tsx");
}).catch(staticFailure);
