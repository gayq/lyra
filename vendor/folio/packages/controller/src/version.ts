declare const FOLIO_EXPECTED_VERSION: string;
declare const CONTROLLER_VERSION: string;

export const VERSION = CONTROLLER_VERSION;

function assertVersionMatch(
	packageName: string,
	expected: string,
	actual: string
) {
	if (expected !== actual) {
		throw new Error(
			`${packageName} version mismatch: this build expects ${expected}, but the loaded runtime is ${actual}`
		);
	}
}

export function assertRuntimeFolioVersion() {
	if (typeof $folio === "undefined") {
		throw new Error(
			"@mercuryworkshop/folio is not loaded. Load folio before the controller."
		);
	}

	assertVersionMatch(
		"@mercuryworkshop/folio",
		FOLIO_EXPECTED_VERSION,
		$folio.versionInfo.version
	);
}
