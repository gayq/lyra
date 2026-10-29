/// <reference lib="WebWorker" />
/// <reference types="@types/serviceworker" />
import { openRoute, routeDestination } from "@mercuryworkshop/folio/route";
export { routeDestination };
import { RpcHelper } from "@mercuryworkshop/rpc";
import type { Controllerbound, SWbound } from "./types";
import type { RawHeaders } from "@mercuryworkshop/proxy-transports";

function makeId(): string {
	return Math.random().toString(36).substring(2, 10);
}

const STREAMED_BODY_MIN_BYTES = 1024 * 1024;

let streamTransferSupported: boolean | undefined;
function canTransferStreams(): boolean {
	if (streamTransferSupported === undefined) {
		try {
			const probe = new ReadableStream();
			structuredClone(probe, { transfer: [probe] });
			streamTransferSupported = true;
		} catch {
			streamTransferSupported = false;
		}
	}
	return streamTransferSupported;
}

function joinChunks(chunks: Uint8Array[], size: number): ArrayBuffer {
	const joined = new Uint8Array(size);
	let offset = 0;
	for (const chunk of chunks) {
		joined.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return joined.buffer;
}

async function requestBodyForTransfer(
	request: Request
): Promise<ArrayBuffer | ReadableStream<Uint8Array> | null> {
	if (request.method === "GET" || request.method === "HEAD") return null;
	if (
		!(request.body instanceof ReadableStream) ||
		!canTransferStreams()
	) {
		const body = await request.arrayBuffer();
		return body.byteLength ? body : null;
	}

	const reader = request.body.getReader() as ReadableStreamDefaultReader<Uint8Array>;
	const chunks: Uint8Array[] = [];
	let size = 0;
	while (size < STREAMED_BODY_MIN_BYTES) {
		const { done, value } = await reader.read();
		if (done) return size ? joinChunks(chunks, size) : null;
		chunks.push(value);
		size += value.byteLength;
	}

	return new ReadableStream<Uint8Array>({
		start(controller) {
			for (const chunk of chunks) controller.enqueue(chunk);
		},
		async pull(controller) {
			const { done, value } = await reader.read();
			if (done) controller.close();
			else controller.enqueue(value);
		},
		cancel(reason) {
			return reader.cancel(reason);
		},
	});
}

const cookieResolvers: Record<string, (value: void) => void> = {};
addEventListener("message", (e) => {
	if (!e.data) return;
	if (typeof e.data != "object") return;
	if (e.data.$sw$setCookieDone && typeof e.data.$sw$setCookieDone == "object") {
		const done = e.data.$sw$setCookieDone;

		const resolver = cookieResolvers[done.id];
		if (resolver) {
			resolver();
			delete cookieResolvers[done.id];
		}
	}

	if (
		e.data.$sw$initRemoteTransport &&
		typeof e.data.$sw$initRemoteTransport == "object"
	) {
		const { port, prefix } = e.data.$sw$initRemoteTransport;

		const relevantcontroller = tabs.find((tab) =>
			new URL(prefix).pathname.startsWith(tab.prefix)
		);
		if (!relevantcontroller) {
			console.error("No relevant controller found for transport init");
			return;
		}
		relevantcontroller.rpc.call("initRemoteTransport", port, [port]);
	}
});

class ControllerReference {
	rpc: RpcHelper<SWbound, Controllerbound>;

	constructor(
		public prefix: string,
		public id: string,
		private port: MessagePort
	) {
		this.rpc = new RpcHelper(
			{
				sendSetCookie: async ({ cookies, options }) => {
					const clients = await self.clients.matchAll();
					const ids: string[] = [];
					const promises: Promise<string>[] = [];
					const isNavigation =
						options?.destination === "document" ||
						options?.destination === "iframe";

					for (const client of clients) {
						const id = makeId();
						ids.push(id);
						client.postMessage({
							$controller$setCookie: {
								cookies,
								options,
								id,
							},
						});
						if (!isNavigation) {
							promises.push(
								new Promise<string>((resolve) => {
									cookieResolvers[id] = () => resolve(id);
								})
							);
						}
					}
					if (promises.length > 0) {
						let timeoutId: ReturnType<typeof setTimeout> | undefined;
						let responded = false;
						const timeoutPromise = new Promise<void>((resolve) => {
							timeoutId = setTimeout(() => {
								if (!responded) {
									const pending = ids.filter(
										(id) => cookieResolvers[id] !== undefined
									);
									console.error(
										"timed out waiting for set cookie response (deadlock?): " +
											`cookies=${cookies.length} clients=${clients.length} ` +
											`pending=${pending.length}/${ids.length} ` +
											`clientUrls=${clients.map((c) => c.url).join(",")}`
									);
								}
								resolve();
							}, 1000);
						});

						try {
							await Promise.race([
								timeoutPromise,
								Promise.any(promises)
									.then(() => {
										responded = true;
									})
									.catch(() => {}),
							]);
						} finally {
							if (timeoutId !== undefined) clearTimeout(timeoutId);
							for (const id of ids) {
								delete cookieResolvers[id];
							}
						}
					}
				},
			},
			"tabchannel-" + id,
			(data, transfer) => {
				port.postMessage(data, transfer);
			}
		);
		port.onmessage = (e: MessageEvent) => {
			this.rpc.recieve(e.data);
		};
		port.onmessageerror = console.error;

		this.rpc.call("ready", undefined);
	}

	dispose(): void {
		this.port.onmessage = null;
		this.port.onmessageerror = null;
		this.port.close();
	}
}

const tabs: ControllerReference[] = [];
const MAX_CONTROLLER_REFERENCES = 128;

addEventListener("message", (e) => {
	if (!e.data) return;
	if (typeof e.data != "object") return;
	if (!e.data.$controller$init) return;
	if (typeof e.data.$controller$init != "object") return;
	const init = e.data.$controller$init;

	const existing = tabs.findIndex((t) => t.id === init.id);
	if (existing !== -1) {
		tabs.splice(existing, 1)[0]?.dispose();
	}
	tabs.push(new ControllerReference(init.prefix, init.id, e.ports[0]));
	if (tabs.length > MAX_CONTROLLER_REFERENCES) {
		for (const evicted of tabs.splice(
			0,
			tabs.length - MAX_CONTROLLER_REFERENCES
		)) {
			evicted.dispose();
		}
	}
});

export function shouldRoute(event: FetchEvent): boolean {
	try {
		const url = openRoute(event.request.url);
		return tabs.some((tab) => url.pathname.startsWith(tab.prefix));
	} catch {
		return false;
	}
}

export async function route(
	event: FetchEvent,
	timeoutMs?: number
): Promise<Response> {
	try {
		const url = openRoute(event.request.url);
		const tab = tabs.find((tab) => url.pathname.startsWith(tab.prefix))!;
		const client = await clients.get(event.clientId);

		const rawheaders: RawHeaders = [...event.request.headers];
		const body = await requestBodyForTransfer(event.request);
		const requestId = makeId();
		let canceled = false;
		const cancel = () => {
			if (canceled) return;
			canceled = true;
			void tab.rpc.call("cancelRequest", { requestId }).catch(() => {});
		};
		event.request.signal.addEventListener("abort", cancel, { once: true });

		let response;
		try {
			const pending = tab.rpc.call(
				"request",
				{
					requestId,
					rawUrl: url.href,
					rawReferrer: event.request.referrer ? openRoute(event.request.referrer).href : "",
					destination: event.request.destination,
					mode: event.request.mode,
					referrer: event.request.referrer ? openRoute(event.request.referrer).href : "",
					method: event.request.method,
					body,
					cache: event.request.cache,
					forceCrossOriginIsolated: false,
					initialHeaders: rawheaders,
					rawClientUrl: client ? openRoute(client.url).href : undefined,
					clientId: event.clientId || event.resultingClientId,
				},
				body ? [body] : undefined
			);
			if (timeoutMs && timeoutMs > 0) {
				let timeout: ReturnType<typeof setTimeout> | undefined;
				try {
					response = await Promise.race([
						pending,
						new Promise<never>((_, reject) => {
							timeout = setTimeout(() => {
								cancel();
								reject(new Error("Folio request timed out"));
							}, timeoutMs);
						}),
					]);
				} finally {
					if (timeout !== undefined) clearTimeout(timeout);
				}
			} else {
				response = await pending;
			}
		} finally {
			event.request.signal.removeEventListener("abort", cancel);
		}

		return new Response(response.body, {
			status: response.status,
			statusText: response.statusText,
			headers: response.headers,
		});
	} catch (e) {
		if (e instanceof Error && e.message === "Folio request timed out") {
			throw e;
		}
		console.error("Service Worker error:", e);
		return new Response(
			"Internal Service Worker Error: " + (e as Error).message,
			{
				status: 500,
			}
		);
	}
}

addEventListener("install", () => {
	self.skipWaiting();
});

addEventListener("activate", (event: ExtendableEvent) => {
	event.waitUntil(clients.claim());
});

setTimeout(async () => {
	console.log("service worker activated, notifying clients to revive");
	for (const client of await clients.matchAll()) {
		client.postMessage({
			$controller$swrevive: {},
		});
	}
}, 100);
