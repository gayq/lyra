import { FolioClient } from "@client/index";
import { Tap } from "@/Tap";
import { String, _URL } from "@/shared/snapshot";

export const enabled = (client: FolioClient) =>
	"navigation" in client.global && "NavigationHistoryEntry" in client.global;

export default function (client: FolioClient, _self: Self) {
	const toSiteUrl = (url: string | null) => {
		if (!url) return url;
		try {
			return client.unrewriteUrl(url);
		} catch {
			return url;
		}
	};

	const isSiteOrigin = (url: string | null) => {
		if (!url) return false;
		try {
			return new _URL(url).origin === client.url.origin;
		} catch {
			return false;
		}
	};

	client.Trap("NavigationHistoryEntry.prototype.url", {
		get(ctx) {
			return toSiteUrl(ctx.get());
		},
	});

	client.Trap("NavigationDestination.prototype.url", {
		get(ctx) {
			return toSiteUrl(ctx.get());
		},
	});

	client.Trap("NavigateEvent.prototype.canIntercept", {
		get(ctx) {
			if (!ctx.get()) return false;
			const destination = client.descriptors.get(
				"NavigateEvent.prototype.destination",
				ctx.this
			);
			if (!destination) return false;

			return isSiteOrigin(
				toSiteUrl(
					client.descriptors.get(
						"NavigationDestination.prototype.url",
						destination
					)
				)
			);
		},
	});

	client.Proxy("Navigation.prototype.entries", {
		apply(ctx) {
			const entries = ctx.call() as NavigationHistoryEntry[];

			ctx.return(
				entries.filter((entry) =>
					isSiteOrigin(
						toSiteUrl(
							client.descriptors.get(
								"NavigationHistoryEntry.prototype.url",
								entry
							)
						)
					)
				)
			);
		},
	});

	client.Proxy("Navigation.prototype.navigate", {
		apply(ctx) {
			if (ctx.args[0] === undefined) return;
			const url = client.resolveNavigationUrl(String(ctx.args[0]));

			Tap.dispatch(
				client.hooks.lifecycle.navigate,
				{
					type: "location",
				},
				{
					url,
				}
			);

			ctx.args[0] = client.rewriteUrl(url, {
				navigateType: "location",
			});
		},
	});
}
