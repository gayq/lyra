import { FolioClient } from "@client/index";
import { Tap } from "@/Tap";
import { String, _URL } from "@/shared/snapshot";

export default function (client: FolioClient, _self: Self) {
	_self.addEventListener(
		"popstate",
		() => {
			Tap.dispatch(
				client.hooks.lifecycle.navigate,
				{
					type: "popstate",
				},
				{
					url: client.url.href,
				}
			);
		},
		{ capture: true }
	);

	client.Proxy(
		["History.prototype.pushState", "History.prototype.replaceState"],
		{
			apply(ctx) {
				const relevantclient = client.box.histories.get(ctx.this);
				const url = ctx.args[2] ? String(ctx.args[2]) : undefined;

				if (url !== undefined) {
					const parsedUrl = new _URL(url, relevantclient.url.href);
					const documentUrl = relevantclient.url;
					if (parsedUrl.origin !== documentUrl.origin) {
						const method =
							ctx.fn === client.natives.store["History.prototype.pushState"]
								? "pushState"
								: "replaceState";
						throw new relevantclient.global.DOMException(
							`Failed to execute '${method}' on 'History': A history state object with URL '${parsedUrl.href}' cannot be created in a document with origin '${documentUrl.origin}' and URL '${documentUrl.href}'.`,
							"SecurityError"
						);
					}
				}

				if (url || url === "") ctx.args[2] = relevantclient.rewriteUrl(url);
				ctx.call();
				Tap.dispatch(
					relevantclient.hooks.lifecycle.navigate,
					{
						type: "history",
					},
					{
						url: relevantclient.url.href,
					}
				);
			},
		}
	);
}
