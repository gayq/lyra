import { FolioClient } from "@client/index";

export function isTurnstileChallengeClient(client: FolioClient): boolean {
	try {
		return client.url.hostname === "challenges.cloudflare.com";
	} catch {
		return false;
	}
}

export function shouldBypassFingerprintPatches(client: FolioClient): boolean {
	try {
		const url = client.url;
		if (isTurnstileChallengeClient(client)) return true;
		if (url.hostname === "discord.com" || url.hostname.endsWith(".discord.com")) {
			return url.pathname === "/login" || url.pathname.startsWith("/login/");
		}
	} catch {}
	return false;
}
