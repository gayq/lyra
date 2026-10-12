import { initializeStatic, staticFailure } from "./session.ts";

void initializeStatic(true).then(() => import("../app/playerEntry.tsx")).catch(staticFailure);
