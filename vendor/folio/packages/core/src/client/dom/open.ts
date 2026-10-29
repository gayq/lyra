import { FolioClient } from "@client/index";
import { FOLIOCLIENT } from "@/symbols";
import { String } from "@/shared/snapshot";

export default function (client: FolioClient) {
	client.Proxy("window.open", {
		apply(ctx) {
			if (typeof ctx.args[0] !== "undefined") {
				const url = String(ctx.args[0]);
				if (url !== "") {
					ctx.args[0] = client.rewriteUrl(url);
				}
			}

			if (typeof ctx.args[1] !== "undefined" && ctx.args[1] !== null) {
				let target = String(ctx.args[1]);

				if (target === "_top" || target === "_unfencedTop") {
					target = client.meta.topFrameName;
				}
				if (target === "_parent") {
					target = client.meta.parentFrameName;
				}

				ctx.args[1] = target;
			}

			const realwin = ctx.call();

			if (!realwin) return ctx.return(realwin);

			if (!(FOLIOCLIENT in realwin)) {
				client.init.hookSubcontext(realwin as Self);
			}

			return realwin;
		},
	});

	client.Trap("window.frameElement", {
		get(ctx) {
			const f = ctx.get() as HTMLIFrameElement | null;
			if (!f) return f;

			const win = f.ownerDocument.defaultView;
			const parentClient = win[FOLIOCLIENT];
			if (!parentClient) return null;

			const ownUrl = client.url;
			const inherits =
				ownUrl.href === "about:blank" || ownUrl.href === "about:srcdoc";
			if (!inherits && ownUrl.origin !== parentClient.url.origin) {
				return null;
			}

			return f;
		},
	});
}
