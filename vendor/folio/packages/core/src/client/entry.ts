// entrypoint for folio.client.js

import { FolioContext, FolioInterface } from "@/shared/index";
import { FOLIOCLIENT } from "@/symbols";
import { FolioClient } from "@client/index";
import { FolioConfig } from "@/types";

export const iswindow = "window" in globalThis && window instanceof Window;
export const isworker = "WorkerGlobalScope" in globalThis;
export const issw = "ServiceWorkerGlobalScope" in globalThis;
export const isdedicated = "DedicatedWorkerGlobalScope" in globalThis;
export const isshared = "SharedWorkerGlobalScope" in globalThis;
