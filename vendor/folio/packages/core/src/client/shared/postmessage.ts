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
				// so we need to send the real origin here, since the recieving window can't possibly know.
				// except, remember that this code is being ran in a different realm than the invoker, so if we ask our `client` it may give us the wrong origin
				// if we were given any object that came from the real realm we can use that to get the real origin
				// and this works in every case EXCEPT for the fact that all three arguments can be strings which are copied instead of cloned
				// so we have to use `$setrealm` which will pollute this with an object from the real realm

				const args = ctx.args as unknown as PostMessageArgs;
				let pollutant: object;

				if (typeof args[0] === "object" && args[0] !== null) {
					pollutant = args[0]; // try to use the first object we can find because it's more reliable
				} else if (typeof args[2] === "object" && args[2] !== null) {
					pollutant = args[2]; // next try to use transfer
				} else {
					pollutant = realmPollutant(ctx.this) ?? {}; // lastly try $setrealm, then give up
				}

				// and now we can steal Function from the caller's realm
				const {
					constructor: { constructor: Function },
				} = pollutant;

				// invoking stolen function will give us the caller's globalThis, remember folio has already proxied it!!!
				const callerGlobalThisProxied: Self = Function("return globalThis")();
				const callerClient = callerGlobalThisProxied[FOLIOCLIENT];

				// this WOULD be enough but the source argument of MessageEvent has to return the caller's window
				// and if we just call it normally it would be coming from here, which WILL NOT BE THE CALLER'S because the accessor is from the parent
				// so with the stolen function we wrap postmessage so the source will truly be the caller's window (remember that function is folio's!!!)
				const wrappedPostMessage = Function("...args", "this(...args)");

				// console.log(
				// 	callerClient,
				// 	client,
				// 	callerGlobalThisProxied.document,
				// 	self.document,
				// 	callerClient === client
				// );
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

				// * origin because obviously
				if (typeof args[1] === "string") args[1] = "*";
				if (typeof args[1] === "object" && args[1] !== null) {
					args[1].targetOrigin = "*";
				}

				ctx.return(wrappedPostMessage.call(ctx.fn, ...args));
			},
		});

	client.Proxy("BroadcastChannel.prototype.postMessage", {
		apply(ctx) {
			ctx.args[0] = {
				$folio$messagetype: "window",
				// TODO: need to actually look up the broadcastchannel itself in box i think
				$folio$origin: client.url.origin,
				$folio$data: ctx.args[0],
			};
		},
	});

	const toproxy = ["MessagePort.prototype.postMessage"];

	if (self.Worker) toproxy.push("Worker.prototype.postMessage");
	if (!iswindow) toproxy.push("self.postMessage"); // only do the generic version if we're in a worker

	client.Proxy(toproxy, {
		apply(ctx) {
			// origin/source doesn't need to be preserved - it's null in the message event

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
