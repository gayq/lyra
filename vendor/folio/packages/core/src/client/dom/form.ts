import { FolioClient } from "@client/index";
import { _URL, _URLSearchParams } from "@/shared/snapshot";

export default function (client: FolioClient, self: Self) {
	const nativeSubmit = self.HTMLFormElement.prototype.submit;
	const NativeFormData = self.FormData;
	const imageClicks = new WeakMap<HTMLInputElement, { x: number; y: number }>();
	self.addEventListener("click", (event: MouseEvent) => {
		const input = event.target;
		if (input instanceof self.HTMLInputElement && input.type === "image") {
			imageClicks.set(input, { x: Math.max(0, Math.floor(event.offsetX)), y: Math.max(0, Math.floor(event.offsetY)) });
		}
	}, true);

	function submit(form: HTMLFormElement, submitter?: HTMLButtonElement | HTMLInputElement | null): boolean {
		const method = submitter?.hasAttribute("formmethod") ? submitter.formMethod : form.method;
		if (method.toLowerCase() !== "get") return false;
		const action = submitter?.hasAttribute("formaction") ? submitter.formAction : form.action;
		const destination = new _URL(action || client.url.href, client.url.href);
		if (!/^https?:$/.test(destination.protocol)) return false;
		const values = new NativeFormData(form, submitter);
		const query = new _URLSearchParams();
		for (const [name, value] of values) query.append(name, typeof value === "string" ? value : value.name);
		if (submitter instanceof self.HTMLInputElement && submitter.type === "image") {
			const point = imageClicks.get(submitter) ?? { x: 0, y: 0 };
			const prefix = submitter.name ? submitter.name + "." : "";
			query.set(prefix + "x", String(point.x));
			query.set(prefix + "y", String(point.y));
		}
		destination.search = query.toString();
		const route = new _URL(client.rewriteUrl(destination));
		const carrier = self.document.createElement("form");
		carrier.hidden = true;
		carrier.method = "get";
		carrier.target = (submitter?.hasAttribute("formtarget") ? submitter.formTarget : form.target) || self.document.querySelector("base[target]")?.getAttribute("target") || "_self";
		carrier.rel = form.rel;
		// Use the native setter so this local action isn't rewritten again.
		client.descriptors.set("HTMLFormElement.prototype.action", carrier, route.href);
		const input = self.document.createElement("input");
		input.type = "hidden";
		input.name = "s";
		input.value = route.searchParams.get("s")!;
		carrier.append(input);
		self.document.documentElement.append(carrier);
		try { nativeSubmit.call(carrier); } finally { carrier.remove(); }
		return true;
	}

	self.addEventListener("submit", (event: SubmitEvent) => {
		if (event.defaultPrevented || !(event.target instanceof self.HTMLFormElement)) return;
		if (submit(event.target, event.submitter as HTMLButtonElement | HTMLInputElement | null)) event.preventDefault();
	});
	client.Proxy("HTMLFormElement.prototype.submit", {
		apply(ctx) {
			if (submit(ctx.this)) return ctx.return(undefined);
		},
	});
}
