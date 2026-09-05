import { FolioClient } from "@client/index";
import { Object_defineProperty, Symbol_for } from "@/shared/snapshot";

export const POLLUTANT = Symbol_for("folio realm pollutant");

export default function (client: FolioClient, self: GlobalThis) {
	// object.$setrealm({}).postMessage(...)
	// the empty object is the "pollutant" which can reconstruct the real realm
	// i explain more in postmessage.ts
	Object_defineProperty(self.Object.prototype, client.config.globals.setrealmfn, {
		value(pollution: object) {
			// this is bad!! sites could detect this
			Object_defineProperty(this, POLLUTANT, {
				value: pollution,
				writable: false,
				configurable: true,
				enumerable: false,
			});

			return this;
		},
		writable: true,
		configurable: true,
		enumerable: false,
	});
}
