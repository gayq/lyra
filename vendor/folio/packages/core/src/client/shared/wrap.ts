import { iswindow } from "@client/entry";
import { FOLIOCLIENT } from "@/symbols";
import { FolioClient } from "@client/index";
import { indirectEval } from "@client/shared/eval";
import { Object_defineProperty } from "@/shared/snapshot";

export function createWrapFn(client: FolioClient, self: GlobalThis) {
	let wrappedParent: GlobalThis | Window | null = null;
	let wrappedTop: GlobalThis | Window | null = null;
	if (iswindow) {
		try {
			if (FOLIOCLIENT in self.parent) {
				wrappedParent = self.parent;
			} else {
				wrappedParent = self;
			}
		} catch {
			wrappedParent = self;
		}
		let current: GlobalThis | Window = self;
		for (;;) {
			const test = current.parent.self;
			if (test === current) break;

			try {
				if (!(FOLIOCLIENT in test)) break;
			} catch {
				break;
			}
			current = test;
		}
		wrappedTop = current;
	}

	return function (identifier: any, strict: boolean) {
		if (identifier === self.location) return client.locationProxy;
		if (identifier === self.eval) {
			const bound = indirectEval.bind(client, strict);
			client.box.unproxy.set(bound, self.eval);
			return bound;
		}
		if (iswindow) {
			if (identifier === self.parent) {
				return wrappedParent;
			} else if (identifier === self.top) {
				return wrappedTop;
			}
		}
		return identifier;
	};
}

export const order = 4;
export default function (client: FolioClient, self: GlobalThis) {
	Object_defineProperty(self, client.config.globals.wrapfn, {
		value: client.wrapfn,
		writable: false,
		configurable: false,
		enumerable: false,
	});
	Object_defineProperty(self, client.config.globals.wrappropertyfn, {
		value: function (str) {
			if (
				str === "location" ||
				str === "parent" ||
				str === "top" ||
				str === "eval"
			)
				return client.config.globals.wrappropertybase + str;

			return str;
		},
		writable: false,
		configurable: false,
		enumerable: false,
	});
	Object_defineProperty(self, client.config.globals.cleanrestfn, {
		value: function (obj) {
			// TODO
		},
		writable: false,
		configurable: false,
		enumerable: false,
	});

	Object_defineProperty(
		self.Object.prototype,
		client.config.globals.wrappropertybase + "location",
		{
			get: function () {
				if (this === self || this === self.document) {
					return client.locationProxy;
				}

				return this.location;
			},
			set(value: any) {
				if (this === self || this === self.document) {
					client.url = value;

					return;
				}
				this.location = value;
			},
			configurable: false,
			enumerable: false,
		}
	);
	Object_defineProperty(
		self.Object.prototype,
		client.config.globals.wrappropertybase + "parent",
		{
			get: function () {
				return client.wrapfn(this.parent, false);
			},
			set(value: any) {
				this.parent = value;
			},
			configurable: false,
			enumerable: false,
		}
	);
	Object_defineProperty(
		self.Object.prototype,
		client.config.globals.wrappropertybase + "top",
		{
			get: function () {
				return client.wrapfn(this.top, false);
			},
			set(value: any) {
				this.top = value;
			},
			configurable: false,
			enumerable: false,
		}
	);
	Object_defineProperty(
		self.Object.prototype,
		client.config.globals.wrappropertybase + "eval",
		{
			get: function () {
				return client.wrapfn(this.eval, true);
			},
			set(value: any) {
				this.eval = value;
			},
			configurable: false,
			enumerable: false,
		}
	);

	self.$scramitize = function (v) {
		const t = typeof v;
		if (t === "object" && v !== null) {
			if (v === location) debugger;
			if (iswindow) {
				if (v === self.top) debugger;
			}
		} else if (t === "string") {
			if (v.includes("folio")) debugger;
			if (v.includes("~/fl")) debugger;
			if (v.includes(location.origin)) debugger;
		}

		return v;
	};

	Object_defineProperty(self, client.config.globals.trysetfn, {
		value: function (lhs: any, op: string, rhs: any) {
			if (client.box.locations.has(lhs)) {
				lhs.href = rhs;
				return true;
			}

			return false;
		},
		writable: false,
		configurable: false,
	});
}
