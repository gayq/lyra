import { FolioClient } from "@client/index";
import {
	Object_values,
	Object_getOwnPropertyNames,
	Object_getOwnPropertyDescriptor,
	Object_defineProperty,
	Reflect_ownKeys,
	_Set,
} from "@/shared/snapshot";

export const order = 100;

const HIDDEN_SYMBOL_DESCRIPTIONS = new _Set([
	"xhr original args",
	"xhr headers",
]) as Set<string>;

export default function (client: FolioClient, self: GlobalThis) {
	const hiddenNames = new _Set(
		Object_values(client.config.globals)
	) as Set<string>;
	const wrappropertybase = client.config.globals.wrappropertybase;

	const isHidden = (key: string | symbol) => {
		if (typeof key === "symbol") {
			const description = key.description;
			if (description === undefined) return false;
			return (
				description.startsWith("folio ") ||
				HIDDEN_SYMBOL_DESCRIPTIONS.has(description)
			);
		}

		return (
			hiddenNames.has(key) ||
			key === "$scramitize" ||
			key.startsWith("$folio") ||
			key.startsWith("__rivet") ||
			key.startsWith(wrappropertybase)
		);
	};

	for (const name of Object_getOwnPropertyNames(self)) {
		if (!isHidden(name)) continue;
		const descriptor = Object_getOwnPropertyDescriptor(self, name);
		if (descriptor?.enumerable && descriptor.configurable) {
			descriptor.enumerable = false;
			Object_defineProperty(self, name, descriptor);
		}
	}

	client.Proxy(
		[
			"Object.getOwnPropertyNames",
			"Object.getOwnPropertySymbols",
			"Reflect.ownKeys",
		],
		{
			apply(ctx) {
				const keys = ctx.call() as (string | symbol)[];
				ctx.return(keys.filter((key) => !isHidden(key)));
			},
		}
	);

	client.Proxy("Object.getOwnPropertyDescriptors", {
		apply(ctx) {
			const descriptors = ctx.call() as Record<string | symbol, unknown>;
			for (const key of Reflect_ownKeys(descriptors)) {
				if (isHidden(key)) delete descriptors[key];
			}
			ctx.return(descriptors);
		},
	});
}
