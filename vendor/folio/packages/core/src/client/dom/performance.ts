import { FolioClient } from "@client/index";
import { proxiedSiteUrl } from "@client/helpers";
import { String } from "@/shared/snapshot";

export default function (client: FolioClient, _self: Self) {
	const proxyOrigin = client.context.prefix.origin;

	client.Trap("PerformanceEntry.prototype.name", {
		get(ctx) {
			const name = String(ctx.get());

			if (name) {
				return client.unrewriteUrl(name);
			}

			return name;
		},
	});

	const isInternalEntry = (entry: PerformanceEntry) => {
		const name = String(
			client.descriptors.get("PerformanceEntry.prototype.name", entry)
		);
		for (const file of client.config.maskedfiles) {
			if (name.endsWith(file)) return true;
		}

		return (
			name.startsWith(proxyOrigin + "/") && proxiedSiteUrl(client, name) === null
		);
	};

	const filterEntries = (entries: PerformanceEntry[]) => {
		return entries.filter((entry) => !isInternalEntry(entry));
	};

	client.Proxy(
		[
			"Performance.prototype.getEntries",
			"Performance.prototype.getEntriesByType",
			"PerformanceObserverEntryList.prototype.getEntries",
			"PerformanceObserverEntryList.prototype.getEntriesByType",
		],
		{
			apply(ctx) {
				const entries = ctx.call() as PerformanceEntry[];

				return ctx.return(filterEntries(entries));
			},
		}
	);

	client.Proxy(
		[
			"Performance.prototype.getEntriesByName",
			"PerformanceObserverEntryList.prototype.getEntriesByName",
		],
		{
			apply(ctx) {
				const name = String(ctx.args[0]);
				const type = ctx.args[1] === undefined ? undefined : String(ctx.args[1]);
				const entries = (
					client.box.instanceof(ctx.this, "Performance")
						? client.natives.call(
								"Performance.prototype.getEntries",
								ctx.this as Performance
							)
						: client.natives.call(
								"PerformanceObserverEntryList.prototype.getEntries",
								ctx.this as PerformanceObserverEntryList
							)
				) as PerformanceEntry[];

				return ctx.return(
					filterEntries(entries).filter(
						(entry) =>
							entry.name === name &&
							(type === undefined || entry.entryType === type)
					)
				);
			},
		}
	);

	client.Proxy(
		[
			"PerformanceEntry.prototype.toJSON",
			"PerformanceResourceTiming.prototype.toJSON",
			"PerformanceNavigationTiming.prototype.toJSON",
		],
		{
			apply(ctx) {
				const json = ctx.call() as { name?: unknown };
				if (json && typeof json.name === "string" && json.name) {
					json.name = client.unrewriteUrl(json.name);
				}

				return ctx.return(json);
			},
		}
	);
}
