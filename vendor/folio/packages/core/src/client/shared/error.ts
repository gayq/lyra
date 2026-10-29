import { FolioClient } from "@client/index";
import { proxiedSiteUrl } from "@client/helpers";
import { shouldBypassFingerprintPatches } from "@client/compat";
import {
	String,
	_RegExp,
	Object_defineProperty,
	Object_getOwnPropertyDescriptor,
} from "@/shared/snapshot";

type CallSite = {
	getFileName(): string | null | undefined;
	getEvalOrigin(): string | undefined;
	isEval(): boolean;
};

export const enabled = (client: FolioClient) =>
	client.flagEnabled("cleanErrors") && !shouldBypassFingerprintPatches(client);

const MAX_SITE_PREPARE_DEPTH = 64;

function escapeRegExp(text: string) {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export default function (client: FolioClient, self: GlobalThis) {
	const SelfError = self.Error as unknown as {
		captureStackTrace?: unknown;
		prepareStackTrace?: unknown;
	};
	if (typeof SelfError.captureStackTrace !== "function") return;

	const proxyOrigin = client.context.prefix.origin;
	const proxyUrls = new _RegExp(
		"(blob:)?" + escapeRegExp(proxyOrigin) + "/[^\\s)]+",
		"g"
	) as RegExp;

	const isInternalFile = (file: string | null | undefined) => {
		if (!file) return false;
		if (file.startsWith("data:")) return true;
		if (client.config.maskedfiles.some((f) => file.endsWith(f))) return true;
		if (!file.startsWith(proxyOrigin + "/")) return false;

		return proxiedSiteUrl(client, file.split("#")[0]) === null;
	};

	const toSiteUrls = (text: string) =>
		text.replace(proxyUrls, (url, blob: string | undefined) => {
			if (blob) return "blob:" + client.url.origin + url.slice(blob.length + proxyOrigin.length);
			const position = /(:\d+){1,2}$/.exec(url);
			const bare = position ? url.slice(0, position.index) : url;
			const siteUrl = proxiedSiteUrl(client, bare);

			return siteUrl === null ? url : siteUrl + (position ? position[0] : "");
		});

	const isInternalFrame = (frame: CallSite) => {
		if (isInternalFile(frame.getFileName())) return true;
		if (!frame.isEval()) return false;
		const evalOrigin = frame.getEvalOrigin() || "";
		const match = /\((\S+?)(?::\d+){0,2}\)/.exec(evalOrigin);
		return isInternalFile(match ? match[1] : evalOrigin);
	};

	const sitePrepares: unknown[] = [];

	const prepare = function (error: unknown, frames: CallSite[]) {
		const kept = frames.filter((frame) => !isInternalFrame(frame));
		const sitePrepare = sitePrepares[sitePrepares.length - 1];
		if (typeof sitePrepare === "function") {
			return sitePrepare(error, kept);
		}

		let header: string;
		try {
			header = String(error);
		} catch {
			header = "Error";
		}

		let stack = toSiteUrls(header);
		for (const frame of kept) {
			stack += "\n    at " + toSiteUrls(String(frame));
		}

		return stack;
	};

	client.box.unproxy.set(prepare, function () {}.bind(null));

	Object_defineProperty(SelfError, "prepareStackTrace", {
		get: Object_getOwnPropertyDescriptor(
			{
				get prepareStackTrace() {
					return prepare;
				},
			},
			"prepareStackTrace"
		).get,
		set: Object_getOwnPropertyDescriptor(
			{
				set prepareStackTrace(value: unknown) {
					if (value === prepare) {
						sitePrepares.pop();
						return;
					}
					if (sitePrepares.length >= MAX_SITE_PREPARE_DEPTH) {
						sitePrepares.shift();
					}
					sitePrepares.push(value);
				},
			},
			"prepareStackTrace"
		).set,
		configurable: true,
		enumerable: false,
	});
}
