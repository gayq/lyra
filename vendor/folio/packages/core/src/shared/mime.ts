import { _Set } from "./snapshot";

const HTTP_WHITESPACE = /^[\t\n\f\r ]+|[\t\n\f\r ]+$/g;

function trimHttpWhitespace(s: string): string {
	return s.replace(HTTP_WHITESPACE, "");
}

function asciiLower(s: string): string {
	return s.toLowerCase();
}

export interface ParsedMimeType {
	type: string;
	subtype: string;
	essence: string;
}

export function parseMimeType(input: string): ParsedMimeType | null {
	const trimmed = trimHttpWhitespace(input);
	if (!trimmed) return null;

	const semicolon = trimmed.indexOf(";");
	const typeAndSubtype =
		semicolon === -1 ? trimmed : trimmed.slice(0, semicolon);
	const main = trimHttpWhitespace(typeAndSubtype);
	if (!main) return null;

	const slash = main.indexOf("/");
	if (slash <= 0 || slash === main.length - 1) return null;

	const type = trimHttpWhitespace(main.slice(0, slash));
	const subtype = trimHttpWhitespace(main.slice(slash + 1));
	if (!type || !subtype) return null;

	return {
		type,
		subtype,
		essence: `${asciiLower(type)}/${asciiLower(subtype)}`,
	};
}

function asParsed(mime: string | ParsedMimeType): ParsedMimeType | null {
	return typeof mime === "string" ? parseMimeType(mime) : mime;
}

const FONT_ESSENCES = new _Set([
	"application/font-cff",
	"application/font-otf",
	"application/font-sfnt",
	"application/font-ttf",
	"application/font-woff",
	"application/vnd.ms-fontobject",
	"application/vnd.ms-opentype",
]);

const ARCHIVE_ESSENCES = new _Set([
	"application/x-rar-compressed",
	"application/zip",
	"application/x-gzip",
]);

const JAVASCRIPT_ESSENCES = new _Set([
	"application/ecmascript",
	"application/javascript",
	"application/x-ecmascript",
	"application/x-javascript",
	"text/ecmascript",
	"text/javascript",
	"text/javascript1.0",
	"text/javascript1.1",
	"text/javascript1.2",
	"text/javascript1.3",
	"text/javascript1.4",
	"text/javascript1.5",
	"text/jscript",
	"text/livescript",
	"text/x-ecmascript",
	"text/x-javascript",
]);

export function isImageMimeType(mime: string | ParsedMimeType): boolean {
	const p = asParsed(mime);
	return p !== null && asciiLower(p.type) === "image";
}

export function isAudioOrVideoMimeType(mime: string | ParsedMimeType): boolean {
	const p = asParsed(mime);
	if (!p) return false;
	const t = asciiLower(p.type);
	if (t === "audio" || t === "video") return true;
	return p.essence === "application/ogg";
}

export function isFontMimeType(mime: string | ParsedMimeType): boolean {
	const p = asParsed(mime);
	if (!p) return false;
	if (asciiLower(p.type) === "font") return true;
	return FONT_ESSENCES.has(p.essence);
}

export function isZipBasedMimeType(mime: string | ParsedMimeType): boolean {
	const p = asParsed(mime);
	if (!p) return false;
	if (p.essence === "application/zip") return true;
	return asciiLower(p.subtype).endsWith("+zip");
}

export function isArchiveMimeType(mime: string | ParsedMimeType): boolean {
	const p = asParsed(mime);
	return p !== null && ARCHIVE_ESSENCES.has(p.essence);
}

export function isXmlMimeType(mime: string | ParsedMimeType): boolean {
	const p = asParsed(mime);
	if (!p) return false;
	if (asciiLower(p.subtype).endsWith("+xml")) return true;
	return p.essence === "text/xml" || p.essence === "application/xml";
}

export function isHtmlMimeType(mime: string | ParsedMimeType): boolean {
	const p = asParsed(mime);
	return p !== null && p.essence === "text/html";
}

export function isScriptableMimeType(mime: string | ParsedMimeType): boolean {
	const p = asParsed(mime);
	if (!p) return false;
	if (isXmlMimeType(p)) return true;
	if (isHtmlMimeType(p)) return true;
	return p.essence === "application/pdf";
}

export function isJavascriptMimeType(mime: string | ParsedMimeType): boolean {
	const p = asParsed(mime);
	return p !== null && JAVASCRIPT_ESSENCES.has(p.essence);
}

export function isJavascriptMimeTypeEssenceMatch(s: string): boolean {
	const t = trimHttpWhitespace(s);
	if (!t) return false;
	return JAVASCRIPT_ESSENCES.has(asciiLower(t));
}

export function getScriptBlockTypeString(
	type: string | null | undefined,
	language: string | null | undefined,
	hasTypeAttribute = type != null,
	hasLanguageAttribute = language != null
): string {
	if (
		(hasTypeAttribute && (type ?? "") === "") ||
		(!hasTypeAttribute && hasLanguageAttribute && (language ?? "") === "") ||
		(!hasTypeAttribute && !hasLanguageAttribute)
	) {
		return "text/javascript";
	}

	if (hasTypeAttribute) {
		return trimHttpWhitespace(type ?? "");
	}

	return `text/${language ?? ""}`;
}

export function isScriptType(type: string | null | undefined): boolean {
	if (type == null) return true;
	const t = trimHttpWhitespace(type);
	if (!t) return true;
	if (asciiLower(t) === "module") return true;
	return isJavascriptMimeTypeEssenceMatch(t);
}

export function isModuleScriptType(type: string | null | undefined): boolean {
	if (type == null) return false;
	const t = trimHttpWhitespace(type);
	return t !== "" && asciiLower(t) === "module";
}

export function isInlineDisplayableMimeType(
	mime: string | ParsedMimeType
): boolean {
	const p = asParsed(mime);
	if (!p) return false;
	if (asciiLower(p.type) === "text") return true;
	if (isImageMimeType(p) || isFontMimeType(p)) return true;
	if (isAudioOrVideoMimeType(p)) return true;
	if (isHtmlMimeType(p) || isJavascriptMimeType(p) || isXmlMimeType(p))
		return true;
	if (p.essence === "application/pdf" || p.essence === "application/json")
		return true;
	return false;
}
