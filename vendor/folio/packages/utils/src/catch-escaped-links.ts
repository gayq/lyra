import { FolioHeaders } from "@mercuryworkshop/folio";
import { ManagedPlugin } from "@mercuryworkshop/folio-controller";
import type { Frame } from "@mercuryworkshop/folio-controller";

export class CatchEscapedLinksPlugin extends ManagedPlugin {
	constructor(private toLocation: (url: URL) => string | URL) {
		super("catch-escaped-links", []);
	}

	install(frame: Frame): void {
		this.tap(
			frame.hooks.fetch.intercept,
			(context, props) => {
				if (context.parsed.destination !== "document") return;

				const location = this.toLocation(context.parsed.url);
				props.response = {
					body: "",
					status: 302,
					statusText: "Found",
					headers: FolioHeaders.fromRawHeaders([
						["Location", String(location)],
					]),
				};
			},
			{ after: ["folio-http-cache"] }
		);
	}
}
