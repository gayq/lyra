export interface FolioVersionInfo {
	version: string;
	build: string;
	date: string;
}

export type FolioFlags = {
	syncxhr: boolean;
	disableComputedWrap: boolean;
	rewriterLogs: boolean;
	captureErrors: boolean;
	cleanErrors: boolean;
	scramitize: boolean;
	sourcemaps: boolean;
	destructureRewrites: boolean;
	allowInvalidJs: boolean;
	allowFailedIntercepts: boolean;
	debugTrampolines: boolean;
	debugSourceURL: boolean;
	encapsulateWorkers: boolean;
};

export interface FolioConfig {
	globals: {
		wrapfn: string;
		wrappropertybase: string;
		wrappropertyfn: string;
		cleanrestfn: string;
		importfn: string;
		rewritefn: string;
		metafn: string;
		wrappostmessagefn: string;
		pushsourcemapfn: string;
		trysetfn: string;
		errfn: string;
		setrealmfn: string;
		templocid: string;
		tempunusedid: string;
	};
	flags: FolioFlags;
	siteFlags: Record<string, Partial<FolioFlags>>;
	maskedfiles: string[];
}

export interface FolioInitConfig
	extends Omit<FolioConfig, "codec" | "flags"> {
	flags: Partial<FolioFlags>;
	codec: {
		encode: (url: string) => string;
		decode: (url: string) => string;
	};
}

//eslint-disable-next-line
export type AnyFunction = Function;
