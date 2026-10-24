import { FolioClient } from "@client/index";

export default function (client: FolioClient) {
	client.Proxy("Navigator.prototype.registerProtocolHandler", {
		apply(ctx) {
			ctx.return();
		},
	});
	client.Proxy("Navigator.prototype.unregisterProtocolHandler", {
		apply(ctx) {
			ctx.return(undefined);
		},
	});
}
