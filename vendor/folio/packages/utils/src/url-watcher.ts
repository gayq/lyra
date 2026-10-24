import { ManagedPlugin } from "@mercuryworkshop/folio-controller";
import type { Frame } from "@mercuryworkshop/folio-controller";

export type UrlWatcherOptions = {};

export class UrlWatcherPlugin extends ManagedPlugin {
	constructor(
		private onUrlChange: (url: string) => void,
		private options: UrlWatcherOptions = {}
	) {
		super("url-watcher", []);
	}

	install(frame: Frame): void {
		this.tap(frame.hooks.init.post, (context) => {
			if (!context.isTopLevel) return;

			const notify = () => {
				this.onUrlChange(context.client.url.href);
			};

			notify();

			this.tap(context.client.hooks.lifecycle.navigate, (_context, props) => {
				this.onUrlChange(props.url);
			});

			context.window.addEventListener("hashchange", notify, { capture: true });
		});
	}
}
