import { unrewriteUrl } from "@rewriters/url";
import { FolioClient } from "@client/index";

export const enabled = (client: FolioClient) =>
	client.flagEnabled("cleanErrors");

export default function (client: FolioClient, _self: Self) {
	const closure = (error, stack) => {
		let newstack = error.stack;

		for (let i = 0; i < stack.length; i++) {
			const url = stack[i].getFileName();

			try {
				if (client.config.maskedfiles.some((f) => url.endsWith(f))) {
					const lines = newstack.split("\n");
					const line = lines.find((l) => l.includes(url));
					lines.splice(line, 1);
					newstack = lines.join("\n");
					continue;
				}
			} catch {}

			try {
				newstack = newstack.replaceAll(url, unrewriteUrl(url, client.context));
			} catch {}
		}

		return newstack;
	};
	client.Trap("Error.prepareStackTrace", {
		get(_ctx) {
			return closure;
		},
		set(_value) {
			// just ignore it if a site tries setting their own. not much we can really do
		},
	});
}
