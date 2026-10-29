import { rewriteBlob, unrewriteBlob } from "@rewriters/url";
import { FolioClient } from "@client/index";
import { String } from "@/shared/snapshot";

export default function (client: FolioClient) {
	client.Proxy("URL.createObjectURL", {
		apply(ctx) {
			const url = ctx.call();
			if (url.startsWith("blob:")) {
				ctx.return(rewriteBlob(url, client.context, client.meta));
			} else {
				ctx.return(url);
			}
		},
	});

	client.Proxy("URL.revokeObjectURL", {
		apply(ctx) {
			setTimeout(() => {
				const url = String(ctx.args[0]);
				if (!url.startsWith("blob:")) return;
				try {
					ctx.args[0] = unrewriteBlob(url, client.context, client.meta);
				} catch {
					return;
				}
				ctx.call();
			}, 1000);
			ctx.return(undefined);
		},
	});
}
