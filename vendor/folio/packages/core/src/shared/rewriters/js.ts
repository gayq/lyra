import { flagEnabled, FolioContext } from "@/shared";
import { rewriteUrl, URLMeta } from "@rewriters/url";

import { getRewriter, JsRewriterOutput } from "@rewriters/wasm";
import { bytesToBase64 } from "@/shared/util";
import {
	Error,
	TextDecoder_decode,
	_RegExp,
	_Uint8Array,
	Object_keys,
	Performance_now,
} from "../snapshot";

if ("ServiceWorkerGlobalScope" in globalThis) {
	// eslint-disable-next-line folio-core/no-globals
	Error.stackTraceLimit = 50;
}

type RewriterResult = {
	js: string | Uint8Array;
	map: Uint8Array | null;
	tag: string;
	errors: string[];
};
function rewriteJsWasm(
	input: string | Uint8Array,
	source: string | null,
	context: FolioContext,
	meta: URLMeta,
	isModule: boolean
): RewriterResult {
	const base = meta.base;
	const [rewriter, ret] = getRewriter(context, meta);

	const flagsobj = {};
	for (const flag of Object_keys(context.config.flags)) {
		flagsobj[flag] = flagEnabled(flag as any, context, base);
	}

	try {
		let out: JsRewriterOutput;
		const before = Performance_now();
		if (typeof input === "string") {
			out = rewriter.rewrite_js(
				{
					...context.config.globals,
					prefix: "",
				},
				flagsobj,
				(url: string, isModule: boolean) => rewriteUrl(url, context, meta, { isModule }),
				input,
				base.href,
				source || "(unknown)",
				isModule
			);
		} else {
			out = rewriter.rewrite_js_bytes(
				{
					...context.config.globals,
					prefix: "",
				},
				flagsobj,
				(url: string, isModule: boolean) => rewriteUrl(url, context, meta, { isModule }),
				input,
				base.href,
				source || "(unknown)",
				isModule
			);
		}

		if (flagsobj["rewriterLogs"]) {
			dbg.time(meta, before, `oxc rewrite for "${source || "(unknown)"}"`);
		}

		const { js, map, scramtag, errors } = out;

		return {
			js: typeof input === "string" ? TextDecoder_decode(js) : js,
			tag: scramtag,
			map,
			errors,
		};
	} finally {
		ret();
	}
}

export function rewriteJsInner(
	js: string | Uint8Array,
	url: string | null,
	context: FolioContext,
	meta: URLMeta,
	isModule = false
) {
	return rewriteJsWasm(js, url, context, meta, isModule);
}

export function rewriteJs(
	js: string | Uint8Array,
	url: string | null,
	context: FolioContext,
	meta: URLMeta,
	isModule = false,
	fallbackOnError = false
): string | Uint8Array {
	try {
		const res = rewriteJsInner(js, url, context, meta, isModule);
		let newjs = res.js;

		const base = meta.base;
		if (flagEnabled("sourcemaps", context, base)) {
			const pushmap = globalThis[context.config.globals.pushsourcemapfn];
			if (pushmap) {
				pushmap(res.map, res.tag);
			} else {
				const rewrittenText =
					typeof newjs === "string" ? newjs : TextDecoder_decode(newjs);
				const sourcemapfn = `${context.config.globals.pushsourcemapfn}("${bytesToBase64(res.map)}", "${res.tag}");`;

				const strictMode = new _RegExp(/^\s*(['"])use strict\1;?/);
				if (strictMode.test(rewrittenText)) {
					newjs = rewrittenText.replace(strictMode, `$&\n${sourcemapfn}`);
				} else {
					newjs = `${sourcemapfn}\n${rewrittenText}`;
				}
			}
		}

		if (flagEnabled("rewriterLogs", context, base)) {
			for (const error of res.errors) {
				dbg.error("oxc parse error", error);
			}
		}

		return newjs;
	} catch (err) {
		if (fallbackOnError) return js;

		dbg.warn(
			"failed rewriting js for",
			url || "(unknown)",
			err.message,
			typeof js !== "string" ? TextDecoder_decode(js) : js
		);
		if (flagEnabled("allowInvalidJs", context, meta.base)) {
			return js;
		} else {
			throw err;
		}
	}
}
