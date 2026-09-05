// NOTE: this is the entrypoint for folio.bundle.js
// as such it exports everything in folio
// the entry point for folio.all.js (what most sites wil use) is entry.ts

import "./global";
import { atob } from "@/shared/snapshot";
import { setWasm } from "@rewriters/wasm";
import { FolioVersionInfo, FolioConfig } from "./types";

declare const VERSION: string;
declare const COMMITHASH: string;
declare const BUILDDATE: string;
export const versionInfo: FolioVersionInfo = {
	version: VERSION,
	build: COMMITHASH,
	date: BUILDDATE,
};

export const defaultConfig: FolioConfig = {
	globals: {
		wrapfn: "$folio$wrap",
		wrappropertybase: "$folio__",
		wrappropertyfn: "$folio$prop",
		cleanrestfn: "$folio$clean",
		importfn: "$folio$import",
		rewritefn: "$folio$rewrite",
		metafn: "$folio$meta",
		wrappostmessagefn: "$folio$wrappostmessage",
		pushsourcemapfn: "$folio$pushsourcemap",
		trysetfn: "$folio$tryset",
		errfn: "$folioerr",
		setrealmfn: "$folio$setrealmfn",
		templocid: "$folio$temploc",
		tempunusedid: "$folio$tempunused",
	},
	flags: {
		syncxhr: false,
		disableComputedWrap: false,
		rewriterLogs: false,
		captureErrors: false,
		cleanErrors: false,
		scramitize: false,
		sourcemaps: true,
		destructureRewrites: true,
		allowInvalidJs: true,
		debugTrampolines: false,
		allowFailedIntercepts: false,
		encapsulateWorkers: true,
		debugSourceURL: false,
	},
	siteFlags: {},
	maskedfiles: [],
};

export const defaultConfigDev: FolioConfig = {
	...defaultConfig,
	flags: {
		...defaultConfig.flags,
		rewriterLogs: false,
		captureErrors: true,
		cleanErrors: false,
		debugTrampolines: true,
		debugSourceURL: true,
		allowInvalidJs: false,
	},
};

declare const REWRITERWASM: string | undefined;
// bundled build will have the wasm binary inlined as a base64 string
if (REWRITERWASM) {
	setWasm(Uint8Array.from(atob(REWRITERWASM), (c) => c.charCodeAt(0)));
}

export * from "./symbols";
export * from "./types";
export * from "./Tap";
export * from "./shared";
export * from "./fetch";
export { BareResponse } from "@mercuryworkshop/proxy-transports";
export * from "./client";
