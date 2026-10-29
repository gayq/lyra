import { FolioClient } from "@client/index";
import { htmlRules } from "@/shared/htmlRules";
import { String, _Set } from "@/shared/snapshot";

const ATTRIBUTE_SELECTOR =
	/\[\s*([\w-]+)\s*(?:([~|^$*]?=)\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^\s\]]+)\s*([iIsS])?\s*)?\]/g;

export default function (client: FolioClient, _self: Self) {
	const rewrittenAttributes = new _Set<string>() as Set<string>;
	for (const rule of htmlRules) {
		for (const key in rule) {
			if (key !== "fn") rewrittenAttributes.add(key.toLowerCase());
		}
	}
	const rewriteSelector = (selector: string) =>
		selector.replace(
			ATTRIBUTE_SELECTOR,
			(match, name: string, operator?: string, value?: string, flag?: string) => {
				const attribute = name.toLowerCase();
				if (!rewrittenAttributes.has(attribute)) return match;
				const condition = operator
					? `${operator}${value}${flag ? ` ${flag}` : ""}`
					: "";

				return `:is([folio-attr-${attribute}${condition}],[${attribute}${condition}]:not([folio-attr-${attribute}]))`;
			}
		);

	client.Proxy(
		[
			"Document.prototype.querySelector",
			"Document.prototype.querySelectorAll",
			"DocumentFragment.prototype.querySelector",
			"DocumentFragment.prototype.querySelectorAll",
			"Element.prototype.querySelector",
			"Element.prototype.querySelectorAll",
			"Element.prototype.matches",
			"Element.prototype.webkitMatchesSelector",
			"Element.prototype.closest",
		],
		{
			apply(ctx) {
				if ((ctx.args as unknown[]).length === 0) return;
				if (typeof ctx.args[0] === "symbol") return;
				const selector = String(ctx.args[0]);
				if (!selector.includes("[")) return;
				ctx.args[0] = rewriteSelector(selector);
			},
		}
	);
}
