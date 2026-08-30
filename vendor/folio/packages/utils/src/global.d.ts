import type * as FolioController from "@mercuryworkshop/folio-controller";

declare global {
	const $folio: typeof import("@mercuryworkshop/folio");
	const $folioController: typeof FolioController;
}

export {};
