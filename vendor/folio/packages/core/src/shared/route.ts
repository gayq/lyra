import { xchacha20poly1305 } from "@noble/ciphers/chacha.js";

declare const FOLIO_ROUTE_KEY: number[];

const key = new Uint8Array(FOLIO_ROUTE_KEY);
const NativeURL = globalThis.URL;
const encodeText = new TextEncoder().encode.bind(new TextEncoder());
const decodeText = new TextDecoder("utf-8", { fatal: true }).decode.bind(new TextDecoder("utf-8", { fatal: true }));
const random = crypto.getRandomValues.bind(crypto);
const encodeBase64 = globalThis.btoa.bind(globalThis);
const decodeBase64 = globalThis.atob.bind(globalThis);
const cache = new Map<string, string>();
const MAX_CACHE = 2048;
const MAX_TOKEN = 2 * 1024 * 1024;

function remember(plain: string, token: string): string {
	if (cache.size >= MAX_CACHE) cache.delete(cache.keys().next().value!);
	cache.set(plain, token);
	return token;
}

export function encodeRouteToken(plain: string): string {
	const cached = cache.get(plain);
	if (cached) return cached;
	const nonce = random(new Uint8Array(24));
	const encrypted = xchacha20poly1305(key, nonce).encrypt(encodeText(plain));
	const bytes = new Uint8Array(nonce.length + encrypted.length);
	bytes.set(nonce);
	bytes.set(encrypted, nonce.length);
	let binary = "";
	for (let i = 0; i < bytes.length; i += 8192) {
		binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
	}
	return remember(plain, encodeBase64(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""));
}

export function decodeRouteToken(token: string): string {
	try {
		if (token.length < 54 || token.length > MAX_TOKEN || !/^[\w-]+$/.test(token)) throw 0;
		const binary: string = decodeBase64(token.replace(/-/g, "+").replace(/_/g, "/"));
		const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
		const plain = decodeText(xchacha20poly1305(key, bytes.subarray(0, 24)).decrypt(bytes.subarray(24)));
		remember(plain, token);
		return plain;
	} catch {
		throw new Error("invalid navigation link... /ᐠ - ˕ -マ");
	}
}

// The internal frame address never goes on the wire. Keeping it inside the
// authenticated payload lets the existing frame and cookie isolation work.
export function sealRoute(input: string | URL): string {
	const url = new NativeURL(String(input));
	if (url.pathname === "/f") return url.href;
	if (!/^\/f\/[a-z0-9]+\/[a-z0-9]+\//.test(url.pathname)) return url.href;
	const hash = url.hash;
	url.hash = "";
	const token = encodeRouteToken(url.pathname + url.search);
	return url.origin + "/f?s=" + token + (hash ? "#" + encodeRouteToken(hash.slice(1)) : "");
}

export function openRoute(input: string | URL): URL {
	const url = new NativeURL(String(input));
	if (url.pathname !== "/f") return url;
	const token = url.searchParams.get("s");
	if (!token || [...url.searchParams.keys()].some((key) => key !== "s") || url.searchParams.getAll("s").length !== 1) {
		throw new Error("invalid navigation link... /ᐠ - ˕ -マ");
	}
	const path = decodeRouteToken(token);
	if (!/^\/f\/[a-z0-9]+\/[a-z0-9]+\//.test(path)) {
		throw new Error("invalid navigation link... /ᐠ - ˕ -マ");
	}
	const internal = new NativeURL(path, url.origin);
	if (url.hash) internal.hash = decodeRouteToken(url.hash.slice(1));
	return internal;
}

export function routeDestination(input: string | URL): string | null {
	const url = new NativeURL(String(input));
	if (url.pathname !== "/f") return null;
	const internal = openRoute(url);
	const path = internal.pathname.replace(/^\/f\/[a-z0-9]+\/[a-z0-9]+\//, "");
	if (path.startsWith("blob:") || path.startsWith("data:")) return path + internal.search + internal.hash;
	const destination = decodeURIComponent(path);
	if (!/^https?:\/\//.test(destination)) return null;
	return destination + (internal.hash ? "#" + decodeURIComponent(internal.hash.slice(1)) : "");
}