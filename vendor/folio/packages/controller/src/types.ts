import type {
	RawHeaders,
	TransferrableResponse,
} from "@mercuryworkshop/proxy-transports";
import type {
	CookieSyncOptions,
	FolioClient,
} from "@mercuryworkshop/folio";
import type { CONTROLLERFRAME } from "./symbols";
import type { Frame } from ".";

export type BodyType =
	| string
	| ArrayBuffer
	| Uint8Array<ArrayBuffer>
	| Blob
	| ReadableStream<Uint8Array<ArrayBufferLike>>;

export type TransferRequest = {
	requestId: string;
	rawUrl: string;
	rawReferrer: string | null;
	destination: RequestDestination;
	mode: RequestMode;
	referrer: string;
	method: string;
	body: BodyType | null;
	cache: RequestCache;
	forceCrossOriginIsolated: boolean;
	initialHeaders: RawHeaders;
	rawClientUrl?: string;
	clientId?: string;
};

export type TransferResponse = {
	body: BodyType;
	headers: RawHeaders;
	status: number;
	statusText: string;
};

export type SerializedCookieSyncEntry = {
	url: string;
	cookie: string;
};

export type Controllerbound = {
	ready: [];
	request: [TransferRequest, TransferResponse];
	cancelRequest: [{ requestId: string }];
	initRemoteTransport: [MessagePort];
};

export type SWbound = {
	sendSetCookie: [
		{
			cookies: SerializedCookieSyncEntry[];
			options?: CookieSyncOptions;
		},
	];
};

export type ControllerRpc = {
	counter: number;
	promiseCallbacks: Map<
		number,
		{
			resolve: (value: unknown) => void;
			reject: (reason?: unknown) => void;
		}
	>;
	recieve(data: unknown): void;
	call<Method extends keyof SWbound>(
		method: Method,
		args: SWbound[Method][0],
		transfer?: Transferable[]
	): Promise<SWbound[Method][1]>;
};

export type TransportToController = {
	request: [
		{
			remote: string;
			method: string;
			body: BodyInit | null;
			headers: RawHeaders;
			// signal: AbortSignal | undefined
		},
		TransferrableResponse,
	];
	sendSetCookie: [
		{
			cookies: SerializedCookieSyncEntry[];
			options?: CookieSyncOptions;
		},
	];
	connect: [
		{
			url: string;
			protocols: string[];
			requestHeaders: RawHeaders;
			port: MessagePort;
		},
		(
			| {
					result: "success";
					protocol: string;
					extensions: string;
			  }
			| {
					result: "failure";
					error: string;
			  }
		),
	];
};

export type ControllerToTransport = {
	ready: [];
};
export type WebSocketData = string | ArrayBuffer | Blob;
export type WebSocketMessage =
	| {
			type: "data";
			data: WebSocketData;
	  }
	| {
			type: "close";
			code: number;
			reason: string;
	  };
export type FrameInitHooks = {
	pre: {
		context: {
			window: Window;
			client: FolioClient;
			isTopLevel: boolean;
		};
		props: {};
	};
	post: {
		context: {
			window: Window;
			client: FolioClient;
			isTopLevel: boolean;
		};
		props: {};
	};
};

export type FrameErrorHooks = {
	request: {
		context: {
			rawrequest: TransferRequest;
			error: unknown;
		};
		props: {
			setResponse?: TransferResponse;
			suppressError?: boolean;
		};
	};
};

declare global {
	interface HTMLIFrameElement {
		[CONTROLLERFRAME]: Frame;
	}
}
