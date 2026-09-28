import { ElementType, Parser } from "htmlparser2";
import { ChildNode, ParentNode, DomHandler, Element, Comment } from "domhandler";
import render from "dom-serializer";
import { URLMeta, rewriteUrl } from "@rewriters/url";
import { rewriteCss } from "@rewriters/css";
import { rewriteJs } from "@rewriters/js";
import { FolioContext } from "@/shared";
import { htmlRules } from "@/shared/htmlRules";
import { parseDeclarativeRefresh } from "@/shared/refresh";
import { bytesToBase64 } from "@/shared/util";
import { Tap } from "@/Tap";
import { RawHeaders } from "@mercuryworkshop/proxy-transports";
import { TrackedHistoryState } from "@/fetch";
import {
	Performance_now,
	atob,
	Object_entries,
	JSON_parse,
	JSON_stringify,
	TextEncoder_encode,
	_URL,
} from "@/shared/snapshot";
import { flagEnabled } from "..";
import {
	getScriptBlockTypeString,
	isModuleScriptType,
	isScriptType,
} from "@/shared/mime";

export type ForeignContext = "svg" | "math" | "html";

export type HtmlContext = {
	// should we inject folio scripts at the top of the document?
	loadScripts: boolean;
	// did the document come from the service worker, or from document.write/innerHTML?
	inline: boolean;
	// for worker originating documents, the source URL, otherwise the url of the page that triggered the rewrite
	source: string;
	// for api originating documents, the name of the api that triggered the rewrite
	apisource?: string;
	// response headers for worker originating documents
	headers?: RawHeaders;
	foreignContext?: ForeignContext;
	history?: TrackedHistoryState[];
};

const renderOptions = {
	encodeEntities: "utf8" as const,
	decodeEntities: false,
};
function serializeHtmlNode(node: ChildNode) {
	return render(node, renderOptions);
}

function isElementNode(node: ChildNode): node is Element {
	return (
		node.type === ElementType.Tag ||
		node.type === ElementType.Script ||
		node.type === ElementType.Style
	);
}

class StreamingDomHandler extends DomHandler {
	isPendingComment(node: ChildNode) {
		return node.type === ElementType.Comment && this.lastNode === node;
	}

	release(node: ChildNode) {
		if (this.lastNode === node) this.lastNode = null;
		node.parent = node.prev = node.next = null;
	}
}

export class IncrementalHtmlRewriter {
	private readonly handler: StreamingDomHandler;
	private readonly parser: Parser;
	private readonly completedElements = new WeakSet<Element>();
	private readonly closingTags = new WeakMap<Element, string>();
	private readonly buffered: string[] | null;
	private injected: boolean;
	private ended = false;

	constructor(
		private readonly context: FolioContext,
		private readonly meta: URLMeta,
		private readonly htmlcontext: HtmlContext
	) {
		// Whole-document hooks must still see the complete original document.
		this.buffered = [context.hooks.rewriter.html.pre, context.hooks.rewriter.html.post]
			.some((hook) => Tap.getTappers(hook).length > 0) ? [] : null;
		this.injected = !htmlcontext.loadScripts;
		this.handler = new StreamingDomHandler(undefined, undefined, (element) => {
			this.completedElements.add(element);
		});
		this.parser = new Parser(this.handler, {
			startingForeignContext: htmlcontext.foreignContext,
		});
	}

	write(html: string) {
		if (this.ended) {
			throw new Error("html rewrite stream already ended... /ᐠ - ˕ -マ");
		}
		if (this.buffered) {
			this.buffered.push(html);
			return "";
		}
		this.parser.write(html);
		return this.flush();
	}

	end(html = "") {
		if (this.ended) {
			return "";
		}
		if (this.buffered) {
			this.ended = true;
			this.buffered.push(html);
			const source = this.buffered.join("");
			this.buffered.length = 0;
			return rewriteHtmlInner(source, this.context, this.meta, this.htmlcontext);
		}

		if (html) {
			this.parser.write(html);
		}

		this.parser.end();
		this.ended = true;

		return this.flush() + this.inject();
	}

	private inject() {
		if (this.injected) return "";
		this.injected = true;
		return this.context.interface.getInjectScripts(
			this.meta, this.handler, this.htmlcontext,
			(src) => new Element("script", { src, "folio-injected": "true" })
		).map(serializeHtmlNode).join("");
	}

	private before(node: ChildNode) {
		if (this.injected) return "";
		if (isElementNode(node) && (node.name === "html" || node.name === "head")) return "";
		if (!isElementNode(node) && (node.type !== ElementType.Text || !node.data.trim())) return "";
		const scripts = this.inject();
		return node.parent?.type === ElementType.Tag && node.parent.name === "html"
			? `<head>${scripts}</head>` : scripts;
	}

	private flush(parent: ParentNode = this.handler.root): string {
		let output = "";
		let consumed = 0;
		for (const node of parent.children) {
			if (this.handler.isPendingComment(node)) break;
			if (isElementNode(node)) {
				// Keep raw text and foreign subtrees intact for their existing rewriters.
				if (["script", "style", "svg", "math"].includes(node.name)) {
					if (!this.completedElements.has(node)) break;
					output += this.before(node);
					output += serializeHtmlNode(traverseParsedHtml(node, this.context, this.meta));
				} else {
					if (!this.closingTags.has(node)) {
						output += this.before(node);
						const shell = new Element(node.name, { ...node.attribs }, []);
						shell.parent = node.parent;
						const rewritten = traverseParsedHtml(shell, this.context, this.meta);
						const serialized = serializeHtmlNode(rewritten);
						const close = `</${node.name}>`;
						const closing = serialized.endsWith(close) ? close : "";
						this.closingTags.set(node, closing);
						output += closing ? serialized.slice(0, -closing.length) : serialized;
						if (node.name === "head") output += this.inject();
					}
					output += this.flush(node);
					if (!this.completedElements.has(node)) break;
					output += this.closingTags.get(node);
				}
			} else {
				output += this.before(node) + serializeHtmlNode(node);
			}
			this.handler.release(node);
			consumed++;
		}
		parent.children.splice(0, consumed);
		if (parent.children[0]) parent.children[0].prev = null;
		return output;
	}
}

function rewriteHtmlInner(
	html: string | ChildNode,
	context: FolioContext,
	meta: URLMeta,
	htmlcontext: HtmlContext
) {
	if (typeof html !== "string") {
		html = serializeHtmlNode(html);
	}

	const handler = new DomHandler((err, dom) => dom);
	const parser = new Parser(handler, {
		startingForeignContext: htmlcontext.foreignContext,
	});

	parser.write(html);
	parser.end();
	Tap.dispatch(
		context.hooks!.rewriter.html.pre,
		{
			handler,
			meta,
			htmlcontext,
			origHtml: html,
		},
		undefined
	);
	traverseParsedHtml(handler.root, context, meta);

	let htmlRoot: Element | undefined;
	let headElement: Element | undefined;
	let bodyElement: Element | undefined;

	function detectQuirks() {
		for (const child of handler.root.childNodes) {
			if (
				child.type === ElementType.Directive ||
				child.type === ElementType.Comment ||
				child.type === ElementType.Text
			) {
				continue;
			}

			if (child.type === ElementType.Tag && child.name === "html") {
				htmlRoot = child as Element;
			} else {
				// there's a child of the root that isn't an html element or a doctype/comment/text
				return true;
			}
		}

		if (!htmlRoot) return true; // no html tag or it's somewhere else other than first child

		for (const child of htmlRoot.childNodes) {
			if (
				child.type === ElementType.Directive ||
				child.type === ElementType.Comment ||
				child.type === ElementType.Text
			) {
				continue;
			}

			if (child.type === ElementType.Tag && child.name === "head") {
				if (bodyElement) {
					// head comes after body
					return true;
				}
				headElement = child as Element;
			} else if (child.type === ElementType.Tag && child.name === "body") {
				bodyElement = child as Element;
			} else {
				// there's a child of html that isn't head or body
				// fine if head already exists, bad if it doesn't
				if (!headElement) {
					return true;
				}
			}

			return false;
		}
	}

	const isQuirky = detectQuirks();

	if (htmlcontext.loadScripts) {
		const script = (src: string) =>
			new Element("script", { src, "folio-injected": "true" });
		const injectScripts = context.interface.getInjectScripts(
			meta,
			handler,
			htmlcontext,
			script
		);

		if (isQuirky) {
			if (flagEnabled("rewriterLogs", context, meta.base)) {
				dbg.warn(
					`detected quirky document structure parsing @ ${meta.origin.href}!`
				);
			}
			// there's weird stuff going on with the document that could result in page scripts being loaded before our inject scripts
			// so inject them at position 0
			handler.root.children.unshift(...injectScripts);
		} else {
			if (!headElement) {
				headElement = new Element("head", {}, []);
				htmlRoot.children.unshift(headElement);
			}

			headElement.children.unshift(...injectScripts);
		}
	}

	const props: typeof context.hooks.rewriter.html.post.props = {};
	Tap.dispatch(
		context.hooks!.rewriter.html.post,
		{
			handler,
			meta,
			htmlcontext,
			origHtml: html,
		},
		props
	);

	if (props.setRawHtml !== undefined) {
		return props.setRawHtml;
	}

	return render(handler.root, renderOptions);
}

export function rewriteHtml(
	html: string,
	context: FolioContext,
	meta: URLMeta,
	htmlcontext: HtmlContext
) {
	const before = Performance_now();
	const ret = rewriteHtmlInner(html, context, meta, htmlcontext);
	if (flagEnabled("rewriterLogs", context, meta.base)) {
		dbg.time(meta, before, "html rewrite");
	}

	return ret;
}

// type ParseState = {
// 	base: string;
// 	origin?: URL;
// };

export function unrewriteHtml(html: string, foreignContext?: ForeignContext) {
	const handler = new DomHandler((err, dom) => dom);
	const parser = new Parser(handler, {
		startingForeignContext: foreignContext,
	});

	parser.write(html);
	parser.end();

	function traverse(node: ChildNode) {
		if ("attribs" in node) {
			for (const key in node.attribs) {
				if (key == "folio-attr-script-source-src") {
					if (node.children[0] && "data" in node.children[0])
						node.children[0].data = atob(node.attribs[key]);
					continue;
				}

				if (key.startsWith("folio-attr-")) {
					node.attribs[key.slice("folio-attr-".length)] = node.attribs[key];
					delete node.attribs[key];
				}
			}
		}

		if ("childNodes" in node) {
			for (const child of node.childNodes) {
				traverse(child);
			}
		}
	}

	traverse(handler.root);

	return render(handler.root, {
		...renderOptions,
	});
}

// i need to add the attributes in during rewriting

function traverseParsedHtml(
	node: any,
	context: FolioContext,
	meta: URLMeta
) {
	if (node.name === "base" && node.attribs.href !== undefined) {
		meta.base = new _URL(node.attribs.href, meta.origin);
	}

	if (node.attribs) {
		for (const rule of htmlRules) {
			for (const attr in rule) {
				if (node.attribs[attr] === undefined) continue;
				const sel = rule[attr.toLowerCase()];
				if (typeof sel === "function") continue;

				if (sel === "*" || sel.includes(node.name)) {
					if (node.attribs[attr] !== undefined) {
						const value = node.attribs[attr];
						const v = rule.fn(value, context, meta, node.attribs);

						if (v === null) delete node.attribs[attr];
						else {
							node.attribs[attr] = v;
						}
						node.attribs[`folio-attr-${attr}`] = value;
					}
				}
			}
		}
		for (const [attr, value] of Object_entries(node.attribs)) {
			if (attr.startsWith("on") && eventAttributes.includes(attr)) {
				node.attribs[`folio-attr-${attr}`] = value;
				node.attribs[attr] = rewriteJs(
					value as string,
					`(inline ${attr} on element)`,
					context,
					meta
				);
			}
		}
	}

	if (node.name === "style" && node.children[0] !== undefined)
		node.children[0].data = rewriteCss(node.children[0].data, context, meta);

	if (
		node.name === "script" &&
		node.attribs.type?.toLowerCase() === "importmap" &&
		node.children[0] !== undefined
	) {
		const json = node.children[0].data;
		try {
			const map = JSON_parse(json);
			if (map.imports) {
				for (const key in map.imports) {
					let url = map.imports[key];
					if (typeof url === "string") {
						url = rewriteUrl(url, context, meta, { isModule: true });
						map.imports[key] = url;
					}
				}
			}

			node.children[0].data = JSON_stringify(map);
		} catch (e) {
			dbg.error("Failed to parse importmap JSON:", e);
		}
	}
	if (
		node.name === "script" &&
		node.attribs &&
		node.children[0] !== undefined
	) {
		const scriptBlockType = getScriptBlockTypeString(
			"type" in node.attribs ? node.attribs.type : undefined,
			"language" in node.attribs ? node.attribs.language : undefined,
			"type" in node.attribs,
			"language" in node.attribs
		);
		if (isScriptType(scriptBlockType)) {
			let js = node.children[0].data;
			const module = isModuleScriptType(scriptBlockType);
			node.attribs["folio-attr-script-source-src"] = bytesToBase64(
				TextEncoder_encode(js)
			);
			const htmlcomment = /<!--[\s\S]*?-->/g;
			js = js.replace(htmlcomment, "");
			node.children[0].data = rewriteJs(
				js,
				"(inline script element)",
				context,
				meta,
				module
			);
		}
	}

	if (node.name === "meta" && node.attribs["http-equiv"] !== undefined) {
		if (
			node.attribs["http-equiv"].toLowerCase() === "content-security-policy"
		) {
			// just delete it. this needs to be emulated eventually but like
			node = new Comment(node.attribs.content);
		} else if (node.attribs["http-equiv"].toLowerCase() === "refresh") {
			const refresh = parseDeclarativeRefresh(node.attribs.content || "");
			if (refresh && refresh.url !== null && refresh.url.length > 0) {
				const rewritten = rewriteUrl(refresh.url.trim(), context, meta);
				node.attribs.content =
					node.attribs.content.slice(0, refresh.urlStart) +
					rewritten +
					node.attribs.content.slice(refresh.urlEnd);
			}
		}
	}

	if (node.childNodes) {
		for (const childNode in node.childNodes) {
			node.childNodes[childNode] = traverseParsedHtml(
				node.childNodes[childNode],
				context,
				meta
			);
		}
	}

	return node;
}

export function rewriteSrcset(
	srcset: string,
	context: FolioContext,
	meta: URLMeta
) {
	const sources = srcset.split(/ .*,/).map((src) => src.trim());
	const rewrittenSources = sources.map((source) => {
		// Split into URLs and descriptors (if any)
		// e.g. url0, url1 1.5x, url2 2x
		const [url, ...descriptors] = source.split(/\s+/);

		// Rewrite the URLs and keep the descriptors (if any)
		const rewrittenUrl = rewriteUrl(url.trim(), context, meta);

		return descriptors.length > 0
			? `${rewrittenUrl} ${descriptors.join(" ")}`
			: rewrittenUrl;
	});

	return rewrittenSources.join(", ");
}

// function base64ToBytes(base64) {
// 	const binString = atob(base64);

// 	return Uint8Array.from(binString, (m) => m.codePointAt(0));
// }

const eventAttributes = [
	"onbeforexrselect",
	"onabort",
	"onbeforeinput",
	"onbeforematch",
	"onbeforetoggle",
	"onblur",
	"oncancel",
	"oncanplay",
	"oncanplaythrough",
	"onchange",
	"onclick",
	"onclose",
	"oncontentvisibilityautostatechange",
	"oncontextlost",
	"oncontextmenu",
	"oncontextrestored",
	"oncuechange",
	"ondblclick",
	"ondrag",
	"ondragend",
	"ondragenter",
	"ondragleave",
	"ondragover",
	"ondragstart",
	"ondrop",
	"ondurationchange",
	"onemptied",
	"onended",
	"onerror",
	"onfocus",
	"onformdata",
	"oninput",
	"oninvalid",
	"onkeydown",
	"onkeypress",
	"onkeyup",
	"onload",
	"onloadeddata",
	"onloadedmetadata",
	"onloadstart",
	"onmousedown",
	"onmouseenter",
	"onmouseleave",
	"onmousemove",
	"onmouseout",
	"onmouseover",
	"onmouseup",
	"onmousewheel",
	"onpause",
	"onplay",
	"onplaying",
	"onprogress",
	"onratechange",
	"onreset",
	"onresize",
	"onscroll",
	"onsecuritypolicyviolation",
	"onseeked",
	"onseeking",
	"onselect",
	"onslotchange",
	"onstalled",
	"onsubmit",
	"onsuspend",
	"ontimeupdate",
	"ontoggle",
	"onvolumechange",
	"onwaiting",
	"onwebkitanimationend",
	"onwebkitanimationiteration",
	"onwebkitanimationstart",
	"onwebkittransitionend",
	"onwheel",
	"onauxclick",
	"ongotpointercapture",
	"onlostpointercapture",
	"onpointerdown",
	"onpointermove",
	"onpointerrawupdate",
	"onpointerup",
	"onpointercancel",
	"onpointerover",
	"onpointerout",
	"onpointerenter",
	"onpointerleave",
	"onselectstart",
	"onselectionchange",
	"onanimationend",
	"onanimationiteration",
	"onanimationstart",
	"ontransitionrun",
	"ontransitionstart",
	"ontransitionend",
	"ontransitioncancel",
	"oncopy",
	"oncut",
	"onpaste",
	"onscrollend",
	"onscrollsnapchange",
	"onscrollsnapchanging",
];
