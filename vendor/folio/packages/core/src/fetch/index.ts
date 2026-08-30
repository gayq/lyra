import {
	BareCompatibleClient,
	BareResponse,
	ProxyTransport,
	BareRequestInit,
} from "@mercuryworkshop/proxy-transports";

import { type URLMeta } from "@rewriters/url";
import { FolioHeaders } from "@/shared/headers";
import { HtmlRewriterHooks, FolioContext } from "@/shared";
import { Tap, TapInstance } from "@/Tap";
import { doHandleFetch } from "./fetch";
import { _URL, _Map } from "@/shared/snapshot";

export interface FolioFetchRequest {
	signal?: AbortSignal;
	rawUrl: URL;
	rawReferrer: string | null;
	// use parsed.destination instead
	rawDestination: RequestDestination;
	mode: RequestMode;
	referrer: string;
	method: string;
	body: BodyType | null;
	cache: RequestCache;

	initialHeaders: FolioHeaders;

	rawClientUrl?: URL;

	/** The service worker FetchEvent.clientId that originated this request. */
	clientId?: string;
}

export interface FolioFetchParsed {
	url: _URL;
	clientUrl?: _URL;
	referrerSourceUrl?: _URL | null;
	hadExtraParams: boolean;
	crossSiteRedirect: boolean;

	// track the worst case Sec-Fetch-Site classification through redirects
	fetchSiteState?: "same-origin" | "same-site" | "cross-site";

	// origin of the page that initialized the request
	// specifically for tracking Sec-Fetch-Site, don't use for anything else, it will diverge from clientUrl in some cases
	fetchInitiatorOrigin?: string;

	// was the request made with credentials=include?
	fetchCredentialsInclude?: boolean;

	// tracks RequestInit.mode if set
	fetchMode?: RequestMode;

	// was this request made by an iframe? (folio's definition of an iframe, not the browser's)
	isIframe?: boolean;

	// request.destination, but is overridden by $dest
	destination: RequestDestination;

	meta: URLMeta;
	isModule: boolean;
	isFakeDataURL: boolean;
	referrerPolicy?: string;
	trackedClient?: FolioFetchTrackedClient;
}

export interface FolioFetchResponse {
	body: BodyType;
	headers: FolioHeaders;
	status: number;
	statusText: string;
}

export type CookieSyncEntry = {
	url: URL;
	cookie: string;
};

export type CookieSyncOptions = {
	clear?: boolean;
	destination?: RequestDestination;
};

export type FetchHandlerInit = {
	transport: ProxyTransport;
	context: FolioContext;
	crossOriginIsolated?: boolean;

	sendSetCookie: (
		cookies: CookieSyncEntry[],
		options?: CookieSyncOptions
	) => Promise<void>;
	fetchDataUrl(dataUrl: string): Promise<BareResponse>;
	fetchBlobUrl(blobUrl: string): Promise<BareResponse>;
};

export type TrackedHistoryState = {
	url: string;
	refererPolicy?: string;
};
export class FolioFetchTrackedClient {
	history: TrackedHistoryState[] = [];
	constructor(public clientId: string) {}
}

// eslint-disable-next-line folio-core/no-globals
export class FolioFetchHandler extends EventTarget {
	public client: BareCompatibleClient;
	public crossOriginIsolated: boolean = false;
	public context: FolioContext;

	public trackedClients: Map<string, FolioFetchTrackedClient> =
		new _Map<string, FolioFetchTrackedClient>();

	public hooks: {
		rewriter: {
			html: TapInstance<HtmlRewriterHooks>;
		};
		fetch: TapInstance<FetchHooks>;
	};

	public fetchDataUrl: (dataUrl: string) => Promise<Response>;
	public fetchBlobUrl: (blobUrl: string) => Promise<Response>;
	public sendSetCookie: (
		cookies: CookieSyncEntry[],
		options?: CookieSyncOptions
	) => Promise<void>;

	constructor(init: FetchHandlerInit) {
		super();
		this.client = new BareCompatibleClient(init.transport);
		this.context = init.context;
		this.crossOriginIsolated = init.crossOriginIsolated || false;
		this.sendSetCookie = init.sendSetCookie;
		this.fetchDataUrl = init.fetchDataUrl;
		this.fetchBlobUrl = init.fetchBlobUrl;
		this.hooks = {
			rewriter: {
				html: Tap.create<HtmlRewriterHooks>(),
			},
			fetch: Tap.create<FetchHooks>(),
		};
		this.context.hooks = {
			rewriter: this.hooks.rewriter,
		};
	}

	async handleFetch(
		request: FolioFetchRequest
	): Promise<FolioFetchResponse> {
		return doHandleFetch(this, request);
	}
}
export type FetchHooks = {
	intercept: {
		context: {
			request: FolioFetchRequest;
			parsed: FolioFetchParsed;
		};
		props: {
			response?: FolioFetchResponse;
		};
	};
	request: {
		context: {
			request: FolioFetchRequest;
			parsed: FolioFetchParsed;
			client: BareCompatibleClient;
		};
		props: {
			init: BareRequestInit;
			url: URL;
			earlyResponse?: BareResponse;
		};
	};
	preresponse: {
		context: {
			request: FolioFetchRequest;
			parsed: FolioFetchParsed;
		};
		props: {
			response: BareResponse;
		};
	};
	response: {
		context: {
			request: FolioFetchRequest;
			parsed: FolioFetchParsed;
		};
		props: {
			response: FolioFetchResponse;
		};
	};
};

export type BodyType =
	| string
	| ArrayBuffer
	| Uint8Array<ArrayBuffer>
	| Blob
	| ReadableStream<any>;
