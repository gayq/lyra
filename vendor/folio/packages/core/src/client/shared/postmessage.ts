import { iswindow } from "@client/entry";
import { FOLIOCLIENT } from "@/symbols";
import { FolioClient } from "@client/index";
import { Object_defineProperty } from "@/shared/snapshot";
import { POLLUTANT } from "./realm";

type PostMessageArgs = [
	message: unknown,
	targetOrOptions?: string | WindowPostMessageOptions,
	transfer?: Transferable[],
];

function realmPollutant(value: unknown): object | undefined {
	if (typeof value !== "object" || value === null || !(POLLUTANT in value)) {
		return undefined;
	}

	const pollutant = value[POLLUTANT];
	return typeof pollutant === "object" && pollutant !== null
		? pollutant
		: undefined;
}

export default function (client: FolioClient, self: Self) {
	if (iswindow)
		client.Proxy("window.postMessage", {
			apply(ctx) {
				if ((ctx.args as unknown[]).length === 0) return;
				const args = ctx.args as unknown as PostMessageArgs;
				let pollutant: object;

				if (typeof args[0] === "object" && args[0] !== null) {
					pollutant = args[0];
				} else if (typeof args[2] === "object" && args[2] !== null) {
					pollutant = args[2];
				} else {
					pollutant = realmPollutant(ctx.this) ?? {};
				}

				const {
					constructor: { constructor: Function },
				} = pollutant;

				const callerGlobalThisProxied: Self = Function("return globalThis")();
				const callerClient = callerGlobalThisProxied[FOLIOCLIENT];

				const wrappedPostMessage = Function("...args", "this(...args)");

				const inherit =
					callerClient.url.href === "about:srcdoc" ||
					callerClient.url.href === "about:blank";
				args[0] = {
					$folio$messagetype: "window",
					$folio$origin: inherit
						? callerClient.global.parent[FOLIOCLIENT].url.origin
						: callerClient.url.origin,
					$folio$data: args[0],
				};

				if (typeof args[1] === "string") args[1] = "*";
				if (typeof args[1] === "object" && args[1] !== null) {
					args[1].targetOrigin = "*";
				}

				ctx.return(wrappedPostMessage.call(ctx.fn, ...args));
			},
		});

	client.Proxy("BroadcastChannel.prototype.postMessage", {
		apply(ctx) {
			if ((ctx.args as unknown[]).length === 0) return;
			ctx.args[0] = {
				$folio$messagetype: "window",
				$folio$origin: client.url.origin,
				$folio$data: ctx.args[0],
			};
		},
	});

	const toproxy = ["MessagePort.prototype.postMessage"];

	if (self.Worker) toproxy.push("Worker.prototype.postMessage");
	if (!iswindow) toproxy.push("self.postMessage");

	client.Proxy(toproxy, {
		apply(ctx) {
			if (ctx.args.length === 0) return;
			ctx.args[0] = {
				$folio$messagetype: "worker",
				$folio$data: ctx.args[0],
			};
		},
	});
	Object_defineProperty(self, client.config.globals.wrappostmessagefn, {
		value: function (obj: any) {
			if (!obj || typeof obj.postMessage !== "function") return obj;
			return {
				postMessage: obj.postMessage.bind(obj),
			};
		},
		configurable: false,
		writable: false,
		enumerable: false,
	});
}
