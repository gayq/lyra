// i am a cat. i like to be petted. i like to be fed. i like to be
import {
	initSync,
	Rewriter as WasmRewriter,
} from "../../../rewriter/wasm/out/wasm.js";
import { flagEnabled, FolioContext } from "@/shared";

export type JsRewriterOutput = {
	js: Uint8Array;
	map: Uint8Array;
	scramtag: string;
	errors: string[];
};

export interface Rewriter {
	free(): void;
	[Symbol.dispose](): void;
	rewrite_js(
		jsconfig: object,
		jsflags: object,
		encodeUrl: object,
		js: string,
		base: string,
		url: string,
		module: boolean
	): JsRewriterOutput;
	rewrite_js_bytes(
		jsconfig: object,
		jsflags: object,
		encodeUrl: object,
		js: Uint8Array,
		base: string,
		url: string,
		module: boolean
	): JsRewriterOutput;
}

import { URLMeta } from "@rewriters/url";
import { Error } from "@/shared/snapshot";

let wasm_u8: Uint8Array;
export function setWasm(u8: Uint8Array | ArrayBuffer) {
	wasm_u8 = u8 instanceof Uint8Array ? u8 : new Uint8Array(u8);
}

const MAGIC = "\0asm".split("").map((x) => x.charCodeAt(0));

function initWasm() {
	if (!(wasm_u8 instanceof Uint8Array))
		throw new Error("rewriter wasm is unavailable /ᐠ - ˕ -マ");

	if (![...wasm_u8.slice(0, 4)].every((x, i) => x === MAGIC[i]))
		throw new Error("rewriter wasm is invalid /ᐠ - ˕ -マ");

	initSync({
		module: new WebAssembly.Module(wasm_u8 as unknown as BufferSource),
	});
}

type RewriterBox = { rewriter: Rewriter; inUse: boolean };
const rewriters: RewriterBox[] = [];

export function prewarmRewriter(): boolean {
	try {
		initWasm();
		if (rewriters.length === 0) {
			rewriters.push({ rewriter: new WasmRewriter(), inUse: false });
		}
		return true;
	} catch {
		return false;
	}
}

export function getRewriter(
	context: FolioContext,
	meta: URLMeta
): [Rewriter, () => void] {
	initWasm();

	let obj: RewriterBox;
	const index = rewriters.findIndex((x) => !x.inUse);
	const len = rewriters.length;

	if (index === -1) {
		if (flagEnabled("rewriterLogs", context, meta.base))
			dbg.log(`creating new rewriter, ${len} rewriters made already`);

		const rewriter = new WasmRewriter();
		obj = { rewriter, inUse: false };
		rewriters.push(obj);
	} else {
		obj = rewriters[index];
	}
	obj.inUse = true;

	return [obj.rewriter, () => (obj.inUse = false)];
}
