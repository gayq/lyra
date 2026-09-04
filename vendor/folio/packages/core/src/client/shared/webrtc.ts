import { FolioClient } from "@client/index";
import { shouldBypassFingerprintPatches } from "@client/compat";

type LyraTurnConfig = {
	enabled?: boolean;
	forceRelay?: boolean;
	iceServers?: RTCIceServer[];
};

type WrappedIceListener = {
	original: EventListenerOrEventListenerObject;
	wrapped: EventListener;
};

const listenerMap = new WeakMap<EventTarget, WrappedIceListener[]>();

function isTurnUrl(url: unknown): boolean {
	return (
		typeof url === "string" &&
		(url.toLowerCase().startsWith("turn:") ||
			url.toLowerCase().startsWith("turns:"))
	);
}

function turnOnlyServers(servers: unknown): RTCIceServer[] {
	if (!Array.isArray(servers)) return [];

	const out: RTCIceServer[] = [];
	for (const server of servers as RTCIceServer[]) {
		const urls = Array.isArray(server?.urls) ? server.urls : [server?.urls];
		const turnUrls = urls.filter(isTurnUrl) as string[];
		if (turnUrls.length === 0) continue;

		out.push({
			...server,
			urls: Array.isArray(server.urls) ? turnUrls : turnUrls[0],
		});
	}

	return out;
}

function defaultTurnServer(self: GlobalThis): RTCIceServer {
	const host = self.location.hostname;
	return {
		urls: [`turn:${host}:3478?transport=udp`, `turn:${host}:3478?transport=tcp`],
		username: "lyly",
		credential: "rara",
	};
}

function readTurnConfig(self: GlobalThis): Required<LyraTurnConfig> {
	const globals = self as GlobalThis & {
		__LYRA_WEBRTC_TURN__?: LyraTurnConfig;
		parent?: (Window & { __LYRA_WEBRTC_TURN__?: LyraTurnConfig }) | null;
		top?: (Window & { __LYRA_WEBRTC_TURN__?: LyraTurnConfig }) | null;
	};
	let configured: LyraTurnConfig | undefined;

	try {
		configured = globals.__LYRA_WEBRTC_TURN__;
	} catch {}
	if (!configured) {
		try {
			configured = globals.parent?.__LYRA_WEBRTC_TURN__;
		} catch {}
	}
	if (!configured) {
		try {
			configured = globals.top?.__LYRA_WEBRTC_TURN__;
		} catch {}
	}

	const configuredTurnServers = turnOnlyServers(configured?.iceServers);
	return {
		enabled: configured?.enabled !== false,
		forceRelay: configured?.forceRelay !== false,
		iceServers:
			configuredTurnServers.length > 0
				? configuredTurnServers
				: [defaultTurnServer(self)],
	};
}

function mergeIceServers(existing: unknown, required: RTCIceServer[]): RTCIceServer[] {
	const merged = [...turnOnlyServers(existing)];

	for (const server of required) {
		const urls = Array.isArray(server.urls) ? server.urls : [server.urls];
		const key = urls.filter(Boolean).join("\n");
		if (!key) continue;
		const hasServer = merged.some((candidate) => {
			const candidateUrls = Array.isArray(candidate.urls)
				? candidate.urls
				: [candidate.urls];
			return candidateUrls.filter(Boolean).join("\n") === key;
		});
		if (!hasServer) merged.push(server);
	}

	return merged;
}

function secureConfiguration(
	self: GlobalThis,
	config?: RTCConfiguration
): RTCConfiguration {
	const turn = readTurnConfig(self);
	if (!turn.enabled) return config ? { ...config } : {};

	const secured = config ? { ...config } : {};
	secured.iceServers = mergeIceServers(secured.iceServers, turn.iceServers);
	if (turn.forceRelay) secured.iceTransportPolicy = "relay";

	return secured;
}

function isRelayCandidate(candidate: unknown): boolean {
	if (candidate == null) return true;
	const text =
		typeof candidate === "string"
			? candidate
			: typeof (candidate as RTCIceCandidate).candidate === "string"
				? (candidate as RTCIceCandidate).candidate
				: "";
	if (!text) return true;

	return /(?:^|\s)typ\s+relay(?:\s|$)/i.test(text);
}

function stripNonRelayCandidates(sdp: string): string {
	return sdp
		.split(/\r?\n/)
		.filter((line) => {
			if (!line.toLowerCase().startsWith("a=candidate:")) return true;
			return isRelayCandidate(line);
		})
		.join("\r\n");
}

function secureSessionDescription(
	description: RTCSessionDescriptionInit
): RTCSessionDescriptionInit;
function secureSessionDescription(description: unknown): unknown;
function secureSessionDescription(description: unknown): unknown {
	if (!description || typeof description !== "object") return description;
	const desc = description as RTCSessionDescriptionInit;
	if (typeof desc.sdp !== "string") return description;

	return {
		...desc,
		sdp: stripNonRelayCandidates(desc.sdp),
	};
}

function wrapIceEvent(listener: EventListenerOrEventListenerObject): EventListener {
	return function (event: Event) {
		const candidate = (event as RTCPeerConnectionIceEvent).candidate;
		if (!isRelayCandidate(candidate)) return;

		if (typeof listener === "function") {
			return listener.call(this, event);
		}

		return listener.handleEvent(event);
	};
}

function rememberListener(
	target: EventTarget,
	original: EventListenerOrEventListenerObject,
	wrapped: EventListener
) {
	const listeners = listenerMap.get(target) ?? [];
	listeners.push({ original, wrapped });
	listenerMap.set(target, listeners);
}

function takeWrappedListener(
	target: EventTarget,
	original: EventListenerOrEventListenerObject
): EventListenerOrEventListenerObject {
	const listeners = listenerMap.get(target);
	if (!listeners) return original;

	const index = listeners.findIndex((item) => item.original === original);
	if (index === -1) return original;
	const [entry] = listeners.splice(index, 1);
	return entry.wrapped;
}

function secureStats(report: RTCStatsReport): RTCStatsReport {
	const secured = new Map<string, RTCStats>();
	try {
		for (const [key, value] of report.entries()) {
			const stat = value as RTCStats & {
				candidateType?: string;
				address?: string;
				ip?: string;
			};
			if (
				stat.type === "local-candidate" &&
				stat.candidateType &&
				stat.candidateType !== "relay"
			) {
				continue;
			}
			if (stat.type === "local-candidate") {
				const redacted = { ...stat };
				delete redacted.address;
				delete redacted.ip;
				secured.set(key, redacted);
				continue;
			}
			secured.set(key, value);
		}
		return secured;
	} catch {
		return report;
	}
}

export default function (client: FolioClient, self: GlobalThis) {
	const global = self as GlobalThis & {
		RTCPeerConnection?: typeof RTCPeerConnection;
	};
	if (!global.RTCPeerConnection) return;
	if (shouldBypassFingerprintPatches(client)) return;

	client.Proxy("RTCPeerConnection", {
		construct(ctx) {
			ctx.args[0] = secureConfiguration(
				self,
				ctx.args[0] as RTCConfiguration | undefined
			);
		},
	});

	client.Proxy("RTCPeerConnection.prototype.setConfiguration", {
		apply(ctx) {
			ctx.args[0] = secureConfiguration(
				self,
				ctx.args[0] as RTCConfiguration | undefined
			);
		},
	});

	client.Proxy("RTCPeerConnection.prototype.getConfiguration", {
		apply(ctx) {
			const config = ctx.call() as RTCConfiguration;
			ctx.return(secureConfiguration(self, config) as RTCConfiguration);
		},
	});

	client.Proxy("RTCPeerConnection.prototype.createOffer", {
		apply(ctx) {
			const secured = (ctx.call() as Promise<RTCSessionDescriptionInit>).then(
				(description) => secureSessionDescription(description)
			);
			ctx.return(secured);
		},
	});

	client.Proxy("RTCPeerConnection.prototype.createAnswer", {
		apply(ctx) {
			const secured = (ctx.call() as Promise<RTCSessionDescriptionInit>).then(
				(description) => secureSessionDescription(description)
			);
			ctx.return(secured);
		},
	});

	client.Proxy("RTCPeerConnection.prototype.setLocalDescription", {
		apply(ctx) {
			if (ctx.args[0]) {
				ctx.args[0] = secureSessionDescription(
					ctx.args[0]
				) as RTCSessionDescriptionInit;
			}
		},
	});

	client.Trap(
		[
			"RTCPeerConnection.prototype.localDescription",
			"RTCPeerConnection.prototype.currentLocalDescription",
			"RTCPeerConnection.prototype.pendingLocalDescription",
		],
		{
			get(ctx) {
				return secureSessionDescription(ctx.get()) as RTCSessionDescription;
			},
		}
	);

	client.Proxy("RTCPeerConnection.prototype.addEventListener", {
		apply(ctx) {
			if (ctx.args[0] !== "icecandidate") return;
			const listener = ctx.args[1];
			if (typeof listener !== "function" && !listener?.handleEvent) return;

			const wrapped = wrapIceEvent(listener);
			rememberListener(ctx.this, listener, wrapped);
			ctx.args[1] = wrapped;
		},
	});

	client.Proxy("RTCPeerConnection.prototype.removeEventListener", {
		apply(ctx) {
			if (ctx.args[0] !== "icecandidate") return;
			const listener = ctx.args[1];
			if (typeof listener !== "function" && !listener?.handleEvent) return;

			ctx.args[1] = takeWrappedListener(ctx.this, listener);
		},
	});

	client.Trap("RTCPeerConnection.prototype.onicecandidate", {
		get(ctx) {
			return ctx.get();
		},
		set(ctx, listener) {
			if (typeof listener !== "function") {
				ctx.set(listener);
				return;
			}

			ctx.set(wrapIceEvent(listener));
		},
	});

	client.Proxy("RTCPeerConnection.prototype.getStats", {
		apply(ctx) {
			ctx.return(
				ctx.call().then((report: RTCStatsReport) => secureStats(report))
			);
		},
	});
}
