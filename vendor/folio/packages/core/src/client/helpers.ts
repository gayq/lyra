import { Object_getOwnPropertyDescriptor } from "@/shared/snapshot";
import type { FolioClient } from "@client/index";

export function getOwnPropertyDescriptorHandler(target, prop) {
	const realDescriptor = Object_getOwnPropertyDescriptor(target, prop);

	return realDescriptor;
}

export function proxiedSiteUrl(client: FolioClient, url: string): string | null {
	if (!url.startsWith(client.context.prefix.origin + "/")) return null;
	try {
		const siteUrl = client.unrewriteUrl(url);
		if (siteUrl === url || !/^(https?|blob|data):/.test(siteUrl)) return null;

		return siteUrl;
	} catch {
		return null;
	}
}
