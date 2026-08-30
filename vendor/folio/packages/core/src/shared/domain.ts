import { parseDomain, ParseResultType } from "parse-domain";

function canonicalHostname(hostname: string): string {
	return hostname.toLowerCase().replace(/^\.+|\.+$/g, "");
}

export function domainMatches(hostname: string, domain: string): boolean {
	hostname = canonicalHostname(hostname);
	domain = canonicalHostname(domain);
	return hostname === domain || hostname.endsWith(`.${domain}`);
}

export function isPublicSuffix(hostname: string): boolean {
	hostname = canonicalHostname(hostname);
	const parsed = parseDomain(hostname);
	if (parsed.type === ParseResultType.Listed) return parsed.domain === undefined;
	if (parsed.type === ParseResultType.NotListed) return parsed.labels.length <= 1;
	return false;
}

export function registrableDomain(hostname: string): string {
	hostname = canonicalHostname(hostname);
	const parsed = parseDomain(hostname);
	if (parsed.type === ParseResultType.Listed && parsed.domain) {
		return [parsed.domain, ...parsed.topLevelDomains].join(".");
	}
	if (parsed.type === ParseResultType.NotListed && parsed.labels.length > 1) {
		return parsed.labels.slice(-2).join(".");
	}
	return hostname;
}
