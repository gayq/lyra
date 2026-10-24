import { rewriteJs } from "@rewriters/js";
import { FolioClient } from "@client/index";
import { Object_defineProperty, String } from "@/shared/snapshot";

export default function (client: FolioClient, self: Self) {
	Object_defineProperty(self, client.config.globals.rewritefn, {
		value: function (js: any) {
			if (client.box.instanceof(js, "TrustedScript")) js = String(js);
			if (typeof js !== "string") return js;

			const rewritten = rewriteJs(
				js,
				"(direct eval proxy)",
				client.context,
				client.meta,
				false,
				true
			);

			return rewritten;
		},
		writable: false,
		configurable: false,
	});
}

export function indirectEval(this: FolioClient, strict: boolean, js: any) {
	if (this.box.instanceof(js, "TrustedScript")) js = String(js);
	if (typeof js !== "string") return js;

	const indirection: typeof eval = this.global.eval;

	return indirection(
		rewriteJs(
			js,
			"(indirect eval proxy)",
			this.context,
			this.meta,
			false,
			true
		) as string
	);
}
