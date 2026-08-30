import { FolioClient } from "@client/index";
import { shouldBypassFingerprintPatches } from "@client/compat";

export default function (client: FolioClient) {
	if (shouldBypassFingerprintPatches(client)) return;

	client.Proxy("console.clear", {
		apply(ctx) {
			// fuck you
			ctx.return(undefined);
		},
	});

	const log = console.log;
	client.Trap("console.log", {
		set(_ctx, _v) {
			// is there a legitimate reason to let sites do this?
		},
		get(_ctx) {
			return log;
		},
	});
}
