/**
 * @fileoverview
 * Validates the package structure needed by the Lyra Folio vendor build.
 */

import test from "ava";
import { existsSync } from "node:fs";
import { stat } from "node:fs/promises";

/**
 * Expected distribution files produced by scripts/build-folio.mjs.
 * All JS files listed must have corresponding source maps.
 * These aren't globs.
 */
const EXPECTED_DIST_FILES = [
	"packages/core/dist/folio.js",
	"packages/core/dist/folio.mjs",
	"packages/core/dist/folio.wasm",
	"packages/controller/dist/controller.api.js",
	"packages/controller/dist/controller.inject.js",
	"packages/controller/dist/controller.sw.js",
	"packages/utils/dist/folio-utils.js",
	"packages/utils/dist/folio-utils-external.mjs",
];

const UTILS_EXPORTS = [
	"CACHE_NAME",
	"CatchEscapedLinksPlugin",
	"EventHandlerPlugin",
	"HttpCachePlugin",
	"LinkHandlerPlugin",
	"ManagedPlugin",
	"UrlWatcherPlugin",
	"setupAlwaysLastBubble",
	"versionInfo",
];

/**
 * Validates that all required distribution files exist in the package.
 * @param {import("ava").ExecutionContext} t - AVA unit test context.
 */
test("Package contains all required distribution files", async (t) => {
	const missingFiles = [];

	for (const filePath of EXPECTED_DIST_FILES) {
		if (!existsSync(filePath)) {
			missingFiles.push(filePath);
		}
	}

	t.deepEqual(
		missingFiles,
		[],
		`Missing required distribution files: ${missingFiles.join(", ")}`
	);
});

/**
 * Validates that all required JS files have their corresponding source maps.
 * @param {import("ava").ExecutionContext} t - AVA unit test context.
 */
test("All required JS bundles have corresponding source maps", async (t) => {
	const jsFiles = EXPECTED_DIST_FILES.filter((file) => file.endsWith(".js"));
	const missingMaps = [];

	for (const jsFile of jsFiles) {
		const mapFile = `${jsFile}.map`;
		if (!existsSync(mapFile)) {
			missingMaps.push(mapFile);
		}
	}

	t.deepEqual(
		missingMaps,
		[],
		`Missing source map files: ${missingMaps.join(", ")}`
	);
});

/**
 * Validates that the tiny public path helper retained for package compatibility exists.
 * @param {import("ava").ExecutionContext} t - AVA unit test context.
 */
test("Package contains the public path helper", async (t) => {
	t.true(existsSync("packages/core/lib/index.cjs"));
	t.true(existsSync("packages/core/lib/index.d.ts"));
});

/**
 * Validates that generated runtime artifacts are non-empty.
 * @param {import("ava").ExecutionContext} t - AVA unit test context.
 */
test("Runtime artifacts are non-empty", async (t) => {
	for (const filePath of EXPECTED_DIST_FILES) {
		const response = await stat(filePath);
		t.true(response.size > 0, `${filePath} should be non-empty`);
	}
});

test.serial("utility package module re-exports the runtime api", async (t) => {
	const previous = globalThis.$folioUtils;
	const runtime = Object.fromEntries(
		UTILS_EXPORTS.map((name, index) => [name, index])
	);
	globalThis.$folioUtils = runtime;

	try {
		const module = await import(
			`../../packages/utils/dist/folio-utils-external.mjs?validation=${Date.now()}`
		);
		t.deepEqual(Object.keys(module).sort(), [...UTILS_EXPORTS].sort());
		for (const name of UTILS_EXPORTS) t.is(module[name], runtime[name]);
	} finally {
		if (previous === undefined) delete globalThis.$folioUtils;
		else globalThis.$folioUtils = previous;
	}
});
