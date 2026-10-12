import { initializeStatic, staticFailure } from "./session.ts";

void initializeStatic().then(() => import("../app/entry.tsx")).catch(staticFailure);
