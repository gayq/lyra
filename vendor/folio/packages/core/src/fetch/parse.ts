import { openRoute } from "@/shared/route";
import { Object_entries, Object_keys, _URL, Error } from "@/shared/snapshot";
import { unrewriteUrl, URLMeta } from "@rewriters/url";
import {
	FolioFetchHandler,
	FolioFetchParsed,
	FolioFetchRequest,
	FolioFetchTrackedClient,
} from ".";

export const QP = {
	referrerPolicy: "$rfp",
	referrerSource: "$rfs",
	isModule: "$module",
	topFrame: "$tf",
	parentFrame: "$pf",
	isIframe: "$iframe",
	mode: "$mode",
	credentials: "$cred",
	destination: "$dest",
	initiatorOrigin: "$io",
	fetchSite: "$fs",
	crossSiteRedirect: "$csr",
	fakeDataURL: "$fakedataurl",
} as const;

const MAX_TRACKED_CLIENTS = 256;

export type QueryParamKey = keyof typeof QP;

export type QueryParams = Partial<Record<QueryParamKey, string>>;

const QP_INVERSE: Record<string, QueryParamKey> = (() => {
	const inv: Record<string, QueryParamKey> = {};
	for (const key of Object_keys(QP) as QueryParamKey[]) {
		inv[QP[key]] = key;
	}
	return inv;
})();

export function parseQueryParams(searchParams: URLSearchParams): {
	params: QueryParams;
	extras: Record<string, string>;
} {
	const params: QueryParams = {};
	const extras: Record<string, string> = {};
	for (const [key, value] of [...searchParams.entries()]) {
		const logical = QP_INVERSE[key];
		if (logical) {
			params[logical] = value;
		} else {
			dbg.warn(
				`extraneous query parameter ${key}=${value}. Assuming <form> element`
			);
			extras[key] = value;
		}
	}
	return { params, extras };
}

export function parseRequest(
	request: FolioFetchRequest,
	handler: FolioFetchHandler
): FolioFetchParsed {
	const strippedUrl = openRoute(request.rawUrl);
	const { params, extras } = parseQueryParams(strippedUrl.searchParams);
	strippedUrl.search = "";

	const hadExtraParams = Object_keys(extras).length > 0;

	if (!_URL.canParse(unrewriteUrl(strippedUrl, handler.context))) {
		throw new Error(`unable to parse rewritten url: ${strippedUrl.href}`);
	}
	const url = new _URL(unrewriteUrl(strippedUrl, handler.context));

	if (url.origin === new _URL(request.rawUrl).origin) {
		// uh oh!
		throw new Error(
			"attempted to fetch from same origin - this means the site has obtained a reference to the real origin, aborting"
		);
	}

	for (const [key, value] of Object_entries(extras)) {
		url.searchParams.set(key, value);
	}

	const clientId = request.clientId;
	let trackedClient: FolioFetchTrackedClient | undefined;
	if (clientId) {
		trackedClient = handler.trackedClients.get(clientId);
		if (!trackedClient) {
			if (handler.trackedClients.size >= MAX_TRACKED_CLIENTS) {
				const oldest = handler.trackedClients.keys().next().value;
				if (oldest !== undefined) handler.trackedClients.delete(oldest);
			}
			trackedClient = new FolioFetchTrackedClient(clientId);
			handler.trackedClients.set(clientId, trackedClient);
		}
	}

	const referrerSourceUrl =
		params.referrerSource === undefined
			? undefined
			: params.referrerSource
				? new _URL(params.referrerSource)
				: null;

	const fetchSiteState =
		params.fetchSite === "same-origin" ||
		params.fetchSite === "same-site" ||
		params.fetchSite === "cross-site"
			? params.fetchSite
			: undefined;

	const fetchMode =
		params.mode === "cors" ||
		params.mode === "no-cors" ||
		params.mode === "same-origin" ||
		params.mode === "navigate"
			? params.mode
			: undefined;
	const destination =
		(params.destination as RequestDestination | undefined) ||
		request.rawDestination;

	const meta: URLMeta = {
		origin: url,
		base: url,
		topFrameName: params.topFrame,
		parentFrameName: params.parentFrame,
		referrerPolicy: params.referrerPolicy,
	};

	const parsed: FolioFetchParsed = {
		meta,
		url,
		isModule: params.isModule === "module",
		referrerPolicy: params.referrerPolicy,
		referrerSourceUrl,
		trackedClient,
		hadExtraParams,
		crossSiteRedirect: params.crossSiteRedirect === "1",
		fetchSiteState,
		fetchInitiatorOrigin: params.initiatorOrigin || undefined,
		// TODO: should really just be a boolean
		fetchCredentialsInclude: params.credentials === "include",
		fetchMode,
		destination,
		isIframe: params.isIframe === "1",
		isFakeDataURL: params.fakeDataURL === "1",
	};

	if (request.rawClientUrl) {
		parsed.clientUrl = new _URL(
			unrewriteUrl(request.rawClientUrl, handler.context)
		);
	}

	return parsed;
}
