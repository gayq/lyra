import type {
	CookieJar,
	FolioConfig,
	FolioInterface,
} from "@mercuryworkshop/folio";
import type { Config } from ".";

function base64Encode(text: string) {
	const bytes = new TextEncoder().encode(text);
	let binary = "";
	for (let i = 0; i < bytes.length; i += 0x8000) {
		binary += String.fromCharCode.apply(
			null,
			bytes.subarray(i, i + 0x8000) as unknown as number[]
		);
	}
	return btoa(binary);
}

export function yieldGetInjectScripts(
	config: Config,
	flconfig: FolioConfig,
	prefix: URL,
	cookieJar: CookieJar,
	codecEncode: (input: string) => string,
	codecDecode: (input: string) => string
) {
	const getInjectScripts: FolioInterface["getInjectScripts"] = (
		meta,
		handler,
		htmlcontext,
		script
	) => {
		return [
			script(config.folioPath),
			script($folio.sealRoute(prefix.href + config.virtualWasmPath)),
			script(config.injectPath),
			script(
				"data:text/javascript;charset=utf-8;base64," +
					base64Encode(`
					document.querySelectorAll("script[folio-injected]").forEach(script => script.remove());
					$folioController.load({
						config: ${JSON.stringify(config)},
						flconfig: ${JSON.stringify(flconfig)},
						prefix: new URL("${prefix.href}"),
						cookies: ${JSON.stringify(cookieJar.dumpForJs())},
						codecEncode: ${codecEncode.toString()},
						codecDecode: ${codecDecode.toString()},
						initHeaders: ${JSON.stringify(htmlcontext.headers ?? [])},
						history: ${JSON.stringify(htmlcontext.history ?? [])},
					})
				`)
			),
		];
	};
	return getInjectScripts;
}
