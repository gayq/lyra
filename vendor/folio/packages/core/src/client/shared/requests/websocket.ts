import { type BareCompatibleWebSocket } from "@mercuryworkshop/proxy-transports";
import { FolioClient } from "@client/index";
import {
	Object_setPrototypeOf,
	Reflect_get,
	_URL,
	_WeakMap,
} from "@/shared/snapshot";

type FakeWebSocketState = {
	protocol: string;
	extensions: string;
	url: string;
	binaryType: BinaryType;
	barews: BareCompatibleWebSocket;

	onopen: (ev: Event) => any | null;
	onmessage: (ev: MessageEvent) => any | null;
	onclose: (ev: CloseEvent) => any | null;
	onerror: (ev: Event) => any | null;
};
type FakeWebSocketStreamState = {
	protocol: string;
	extensions: string;
	url: string;
	barews: BareCompatibleWebSocket;

	opened: WebSocketStream["opened"];
	closed: WebSocketStream["closed"];
	readable: ReadableStream<string | ArrayBuffer | Blob>;
	writable: WritableStream<string | ArrayBufferLike | Blob | ArrayBufferView>;
};

function normalizeWebSocketUrl(url: string | URL, base: string) {
	let rawurl = new _URL(url, base);
	if (rawurl.protocol === "http:") {
		rawurl = new _URL("ws:" + rawurl.href.substring(rawurl.protocol.length));
	} else if (rawurl.protocol === "https:") {
		rawurl = new _URL("wss:" + rawurl.href.substring(rawurl.protocol.length));
	}

	return rawurl.href;
}

function normalizeWebSocketData(
	data: string | ArrayBufferLike | Blob | ArrayBufferView
): string | ArrayBuffer | Blob {
	if (ArrayBuffer.isView(data)) {
		return new Uint8Array(data.buffer, data.byteOffset, data.byteLength).slice()
			.buffer;
	}
	if (typeof data === "string" || data instanceof Blob) {
		return data;
	}
	return data instanceof ArrayBuffer
		? data
		: new Uint8Array(data).slice().buffer;
}

export default function (client: FolioClient, self: GlobalThis) {
	const socketmap: WeakMap<WebSocket, FakeWebSocketState> =
		new _WeakMap() as WeakMap<WebSocket, FakeWebSocketState>;
	const socketstreammap: WeakMap<WebSocketStream, FakeWebSocketStreamState> =
		new _WeakMap() as WeakMap<WebSocketStream, FakeWebSocketStreamState>;
	client.Proxy("WebSocket", {
		construct(ctx) {
			const fakeWebSocket = new EventTarget() as WebSocket;
			Object_setPrototypeOf(fakeWebSocket, ctx.fn.prototype);
			fakeWebSocket.constructor = ctx.fn;

			// websockets can take relative URLs
			const url = normalizeWebSocketUrl(ctx.args[0], client.url.href);

			const trustEvent = (ev: Event) =>
				new Proxy(ev, {
					get(target, prop) {
						if (prop === "isTrusted") return true;

						return Reflect_get(target, prop);
					},
				});

			const barews = client.bare.createWebSocket(url, ctx.args[1], [
				["User-Agent", self.navigator.userAgent],
				["Origin", client.url.origin],
				[
					"Cookie",
					client.context.cookieJar.getCookies(new _URL(url), false),
				],
			]);

			const state: FakeWebSocketState = {
				protocol: "",
				extensions: "",
				url,
				binaryType: "blob",
				barews,

				onopen: null,
				onmessage: null,
				onclose: null,
				onerror: null,
			};

			function fakeEventSend(fakeev: Event) {
				state["on" + fakeev.type]?.(trustEvent(fakeev));
				fakeWebSocket.dispatchEvent(fakeev);
			}

			barews.addEventListener("open", () => {
				fakeEventSend(new Event("open"));
			});
			barews.addEventListener("close", (ev) => {
				fakeEventSend(new CloseEvent("close", ev));
			});
			barews.addEventListener("message", async (ev) => {
				let payload = ev.data;
				if (typeof payload === "string") {
					// DO NOTHING
				} else if ("byteLength" in payload) {
					// arraybuffer, convert to blob if needed or set the proper prototype
					if (state.binaryType === "blob") {
						payload = new Blob([payload]);
					} else {
						Object_setPrototypeOf(payload, ArrayBuffer.prototype);
					}
				} else if ("arrayBuffer" in payload) {
					// blob, convert to arraybuffer if neccesary.
					if (state.binaryType === "arraybuffer") {
						payload = await payload.arrayBuffer();
						Object_setPrototypeOf(payload, ArrayBuffer.prototype);
					}
				}

				const fakeev = new MessageEvent("message", {
					data: payload,
					origin: ev.origin,
					lastEventId: ev.lastEventId,
					source: ev.source,
					ports: ev.ports,
				});

				fakeEventSend(fakeev);
			});
			barews.addEventListener("error", () => {
				fakeEventSend(new Event("error"));
			});

			socketmap.set(fakeWebSocket, state);
			ctx.return(fakeWebSocket);
		},
	});
	client.Trap("WebSocket.prototype.binaryType", {
		get(ctx) {
			const ws = socketmap.get(ctx.this);
			if (!ws) return ctx.get();

			return ws.binaryType;
		},
		set(ctx, v) {
			const ws = socketmap.get(ctx.this);
			if (!ws) return ctx.set(v);
			if (v === "blob" || v === "arraybuffer") ws.binaryType = v;
		},
	});

	client.Trap("WebSocket.prototype.bufferedAmount", {
		get(ctx) {
			const ws = socketmap.get(ctx.this);
			if (!ws) return ctx.get();

			return 0;
		},
	});

	client.Trap("WebSocket.prototype.extensions", {
		get(ctx) {
			const ws = socketmap.get(ctx.this);
			if (!ws) return ctx.get();

			return ws.extensions;
		},
	});

	client.Trap("WebSocket.prototype.onopen", {
		get(ctx) {
			const ws = socketmap.get(ctx.this);
			if (!ws) return ctx.get();

			return ws.onopen;
		},
		set(ctx, v: (ev: Event) => any) {
			const ws = socketmap.get(ctx.this);
			if (!ws) return ctx.set(v);

			ws.onopen = v;
		},
	});

	client.Trap("WebSocket.prototype.onmessage", {
		get(ctx) {
			const ws = socketmap.get(ctx.this);
			if (!ws) return ctx.get();

			return ws.onmessage;
		},
		set(ctx, v: (ev: MessageEvent) => any) {
			const ws = socketmap.get(ctx.this);
			if (!ws) return ctx.set(v);

			ws.onmessage = v;
		},
	});

	client.Trap("WebSocket.prototype.onclose", {
		get(ctx) {
			const ws = socketmap.get(ctx.this);
			if (!ws) return ctx.get();

			return ws.onclose;
		},
		set(ctx, v: (ev: CloseEvent) => any) {
			const ws = socketmap.get(ctx.this);
			if (!ws) return ctx.set(v);

			ws.onclose = v;
		},
	});

	client.Trap("WebSocket.prototype.onerror", {
		get(ctx) {
			const ws = socketmap.get(ctx.this);
			if (!ws) return ctx.get();

			return ws.onerror;
		},
		set(ctx, v: (ev: Event) => any) {
			const ws = socketmap.get(ctx.this);
			if (!ws) return ctx.set(v);

			ws.onerror = v;
		},
	});

	client.Trap("WebSocket.prototype.url", {
		get(ctx) {
			const ws = socketmap.get(ctx.this);
			if (!ws) return ctx.get();

			return ws.url;
		},
	});

	client.Trap("WebSocket.prototype.protocol", {
		get(ctx) {
			const ws = socketmap.get(ctx.this);
			if (!ws) return ctx.get();

			return ws.protocol;
		},
	});

	client.Trap("WebSocket.prototype.readyState", {
		get(ctx) {
			const ws = socketmap.get(ctx.this);
			if (!ws) return ctx.get();

			return ws.barews.readyState as WebSocket["readyState"];
		},
	});

	client.Proxy("WebSocket.prototype.send", {
		apply(ctx) {
			const ws = socketmap.get(ctx.this);
			if (!ws) return;

			void ws.barews.send(normalizeWebSocketData(ctx.args[0]));
			ctx.return();
		},
	});

	client.Proxy("WebSocket.prototype.close", {
		apply(ctx) {
			const ws = socketmap.get(ctx.this);
			if (!ws) return;

			if (ctx.args[0] === undefined) ctx.args[0] = 1000;
			if (ctx.args[1] === undefined) ctx.args[1] = "";
			ctx.return(ws.barews.close(ctx.args[0], ctx.args[1]));
		},
	});

	client.Proxy("WebSocketStream", {
		construct(ctx) {
			const fakeWebSocket = {} as WebSocketStream;
			Object_setPrototypeOf(fakeWebSocket, ctx.fn.prototype);
			fakeWebSocket.constructor = ctx.fn;

			const input = ctx.args[0] as string | URL;
			const options = ctx.args[1];
			const url = normalizeWebSocketUrl(input, client.url.href);

			const barews = client.bare.createWebSocket(url, options?.protocols, [
				["User-Agent", self.navigator.userAgent],
				["Origin", client.url.origin],
				[
					"Cookie",
					client.context.cookieJar.getCookies(new _URL(url), false),
				],
			]);
			options?.signal?.addEventListener("abort", () => {
				barews.close(1000, "");
			});
			const state: FakeWebSocketStreamState = {
				protocol: "",
				extensions: "",
				url,
				barews,

				opened: new Promise((resolve, reject) => {
					barews.addEventListener("open", () => {
						resolve({
							readable: state.readable,
							writable: state.writable,
							protocol: state.protocol,
							extensions: state.extensions,
						});
					});
					barews.addEventListener("error", (ev: Event) => {
						reject(ev);
					});
				}),
				closed: new Promise((resolve) => {
					barews.addEventListener("close", (ev: CloseEvent) => {
						resolve({ closeCode: ev.code, reason: ev.reason });
					});
				}),
				readable: new ReadableStream<string | ArrayBuffer | Blob>({
					start(controller) {
						barews.addEventListener("message", async (ev: MessageEvent) => {
							let payload = ev.data;
							// TODO: this needs to be changed to uint8array later
							// chrome isnt following spec though so we are just going to do this
							if (typeof payload === "string") {
								// DO NOTHING
							} else if ("byteLength" in payload) {
								// arraybuffer, set the realms prototype so its recognized
								Object.setPrototypeOf(payload, ArrayBuffer.prototype);
							} else if ("arrayBuffer" in payload) {
								// blob, convert to arraybuffer
								payload = await payload.arrayBuffer();
								Object.setPrototypeOf(payload, ArrayBuffer.prototype);
							}
							controller.enqueue(payload);
						});
					},
					cancel(info) {
						barews.close(info?.closeCode ?? 1000, info?.reason ?? "");
					},
				}),
				writable: new WritableStream<
					string | ArrayBufferLike | Blob | ArrayBufferView
				>({
					write(chunk) {
						return barews.send(normalizeWebSocketData(chunk));
					},
					abort() {
						barews.close(1000, "");
					},
					close() {
						barews.close(1000, "");
					},
				}),
			};

			socketstreammap.set(fakeWebSocket, state);
			ctx.return(fakeWebSocket);
		},
	});

	client.Trap("WebSocketStream.prototype.opened", {
		get(ctx) {
			const ws = socketstreammap.get(ctx.this);

			return ws.opened;
		},
	});

	client.Trap("WebSocketStream.prototype.closed", {
		get(ctx) {
			const ws = socketstreammap.get(ctx.this);

			return ws.closed;
		},
	});

	client.Trap("WebSocketStream.prototype.url", {
		get(ctx) {
			const ws = socketstreammap.get(ctx.this);

			return ws.url;
		},
	});

	client.Proxy("WebSocketStream.prototype.close", {
		apply(ctx) {
			const ws = socketstreammap.get(ctx.this);
			if (ctx.args[0]) {
				if (ctx.args[0].closeCode === undefined) ctx.args[0].closeCode = 1000;
				if (ctx.args[0].reason === undefined) ctx.args[0].reason = "";

				return ctx.return(
					ws.barews.close(ctx.args[0].closeCode, ctx.args[0].reason)
				);
			}

			return ctx.return(ws.barews.close(1000, ""));
		},
	});
}
