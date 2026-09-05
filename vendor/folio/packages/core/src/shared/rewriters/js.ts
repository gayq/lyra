import { flagEnabled, FolioContext } from "@/shared";
import { rewriteUrl, URLMeta } from "@rewriters/url";

import { getRewriter, JsRewriterOutput } from "@rewriters/wasm";
import {
	Array_from,
	Error,
	TextDecoder_decode,
	_RegExp,
	_Uint8Array,
	Object_keys,
	Performance_now,
} from "../snapshot";

// eslint-disable-next-line folio-core/no-globals
Error.stackTraceLimit = 50;

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
	const [rewriter, ret] = getRewriter(context, meta);

	const flagsobj = {};
	for (const flag of Object_keys(context.config.flags)) {
		flagsobj[flag] = flagEnabled(flag as any, context, meta.base);
	}

	try {
		let out: JsRewriterOutput;
		const before = Performance_now();
		// try {
		if (typeof input === "string") {
			out = rewriter.rewrite_js(
				{
					...context.config.globals,
					prefix: "",
				},
				flagsobj,
				(url: string, isModule: boolean) => rewriteUrl(url, context, meta, { isModule }),
				input,
				meta.base.href,
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
				meta.base.href,
				source || "(unknown)",
				isModule
			);
		}
		// } catch (err) {
		// 	const err1 = err as Error;
		// 	console.warn(
		// 		"failed rewriting js for",
		// 		source,
		// 		err1.message,
		// 		input instanceof Uint8Array ? textDecoder.decode(input) : input
		// 	);

		// 	return { js: input, tag: "", map: null };
		// }
		if (flagEnabled("rewriterLogs", context, meta.base)) {
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

		if (flagEnabled("sourcemaps", context, meta.base)) {
			const pushmap = globalThis[context.config.globals.pushsourcemapfn];
			if (pushmap) {
				pushmap(Array_from(res.map), res.tag);
			} else {
				const rewrittenText =
					typeof newjs === "string" ? newjs : TextDecoder_decode(newjs);
				const sourcemapfn = `${context.config.globals.pushsourcemapfn}([${res.map.join(",")}], "${res.tag}");`;

				// don't put the sourcemap call before "use strict"
				const strictMode = new _RegExp(/^\s*(['"])use strict\1;?/);
				if (strictMode.test(rewrittenText)) {
					newjs = rewrittenText.replace(strictMode, `$&\n${sourcemapfn}`);
				} else {
					newjs = `${sourcemapfn}\n${rewrittenText}`;
				}
			}
		}

		if (flagEnabled("rewriterLogs", context, meta.base)) {
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
