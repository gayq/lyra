import {
	atob,
	btoa,
	TextEncoder_encode,
	String_fromCharCode,
} from "@/shared/snapshot";

function bytesToBase64Fallback(bytes: Uint8Array): string {
	let binString = "";
	for (let i = 0; i < bytes.length; i += 0x8000) {
		binString += String_fromCharCode.apply(
			null,
			bytes.subarray(i, i + 0x8000) as unknown as number[]
		);
	}

	return btoa(binString);
}

const bytesToBase64Native: ((this: Uint8Array) => string) | undefined = (
	Uint8Array.prototype as any
).toBase64;

export const bytesToBase64: (bytes: Uint8Array) => string =
	typeof bytesToBase64Native === "function"
		? (bytes) => bytesToBase64Native.call(bytes)
		: bytesToBase64Fallback;

function base64ToBytesFallback(base64: string): Uint8Array {
	const binString = atob(base64);
	const bytes = new Uint8Array(binString.length);
	for (let i = 0; i < binString.length; i++) bytes[i] = binString.charCodeAt(i);

	return bytes;
}

const base64ToBytesNative: ((base64: string) => Uint8Array) | undefined = (
	Uint8Array as any
).fromBase64;

export const base64ToBytes: (base64: string) => Uint8Array =
	typeof base64ToBytesNative === "function"
		? (base64) => base64ToBytesNative.call(Uint8Array, base64)
		: base64ToBytesFallback;

export function base64Encode(text: string) {
	return bytesToBase64(TextEncoder_encode(text));
}
