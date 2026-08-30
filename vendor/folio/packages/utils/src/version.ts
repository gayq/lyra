declare const FOLIO_EXPECTED_VERSION: string;
declare const CONTROLLER_EXPECTED_VERSION: string;

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

export function assertDependencyVersions() {
	if (typeof $folio === "undefined") {
		console.error(
			"@mercuryworkshop/folio is not loaded. Load folio before folio-utils."
		);
	}

	assertVersionMatch(
		"@mercuryworkshop/folio",
		FOLIO_EXPECTED_VERSION,
		$folio.versionInfo.version
	);

	if (typeof $folioController === "undefined") {
		console.error(
			"@mercuryworkshop/folio-controller is not loaded. Load the controller before folio-utils."
		);
	}

	assertVersionMatch(
		"@mercuryworkshop/folio-controller",
		CONTROLLER_EXPECTED_VERSION,
		$folioController.VERSION
	);
}
