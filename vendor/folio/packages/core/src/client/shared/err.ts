import { flagEnabled } from "@/shared";
import { FolioClient } from "@client/index";
import { Reflect_apply } from "@/shared/snapshot";

export const enabled = (client: FolioClient) =>
	client.flagEnabled("captureErrors");
export function argdbg(arg, recurse = []) {
	switch (typeof arg) {
		case "string":
			break;
		case "object":
			if (
				arg &&
				arg[Symbol.iterator] &&
				typeof arg[Symbol.iterator] === "function"
			)
				for (const prop in arg) {
					// make sure it's not a getter
					const desc = Object.getOwnPropertyDescriptor(arg, prop);
					if (desc && desc.get) continue;

					const ar = arg[prop];
					if (recurse.includes(ar)) continue;
					recurse.push(ar);
					argdbg(ar, recurse);
				}
			break;
	}
}

export default function (client: FolioClient, self: GlobalThis) {
	const debug = console.debug;
	self.$folioerr = function folioerr(e) {
		if (client.flagEnabled("rewriterLogs")) {
			debug("[folio captured error]", e);
		}
	};

	self.$foliodbg = function foliodbg(args, t) {
		if (args && typeof args === "object" && args.length > 0) argdbg(args);
		argdbg(t);

		return t;
	};

	client.Proxy("Promise.prototype.catch", {
		apply(ctx) {
			if (ctx.args[0])
				ctx.args[0] = new Proxy(ctx.args[0], {
					apply(target, that, args) {
						// console.warn("CAUGHT PROMISE REJECTION", args);
						return Reflect_apply(target, that, args);
					},
				});
		},
	});
}
