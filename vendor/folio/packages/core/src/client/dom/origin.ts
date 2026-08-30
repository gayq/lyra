import { FolioClient } from "@client/index";

export default function (client: FolioClient, _self: Self) {
	client.Trap("origin", {
		get() {
			// TODO: this isn't right!!
			return client.url.origin;
		},
		set() {
			return false;
		},
	});
}
