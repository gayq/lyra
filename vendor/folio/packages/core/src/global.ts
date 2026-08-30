/// <reference types="@rspack/core/module" />

import { FOLIOCLIENT } from "./symbols";
import type { FolioClient } from "./client";
import type { URLMeta } from "./shared/rewriters/url";

declare global {
	interface Window {
		WASM: string;
		REAL_WASM: Uint8Array;

		/**
		 * The folio client belonging to a window.
		 */
		[FOLIOCLIENT]: FolioClient;
	}

	interface Document {
		/**
		 * Should be the same as window.
		 */
		[FOLIOCLIENT]: FolioClient;
	}

	interface Navigator {
		unregisterProtocolHandler(scheme: string, url: string): void;
	}

	interface WebSocketStreamCloseInfo {
		closeCode?: number;
		reason?: string;
	}

	interface WebSocketStreamOptions {
		protocols?: string | string[];
		signal?: AbortSignal;
	}

	interface WebSocketStream {
		readonly url: string;
		readonly opened: Promise<{
			extensions: string;
			protocol: string;
			readable: ReadableStream<string | ArrayBuffer | Blob>;
			writable: WritableStream<
				string | ArrayBufferLike | Blob | ArrayBufferView
			>;
		}>;
		readonly closed: Promise<{ closeCode: number; reason: string }>;
		close(closeInfo?: WebSocketStreamCloseInfo): void;
	}

	var WebSocketStream: {
		prototype: WebSocketStream;
		new (url: string | URL, options?: WebSocketStreamOptions): WebSocketStream;
	};

	const dbg: {
		log: (message: string, ...args: any[]) => void;
		warn: (message: string, ...args: any[]) => void;
		error: (message: string, ...args: any[]) => void;
		debug: (message: string, ...args: any[]) => void;
		time: (meta: URLMeta, before: number, type: string) => void;
	};

	// eslint-disable-next-line folio-core/no-globals
	type GlobalThis = typeof globalThis;
	type Self = Window & GlobalThis;
}

export {};
