import { copyFile, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const NEGATIVE = "... /ᐠ - ˕ -マ";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const rivetRoot = path.join(root, "packages", "rivet");
const routerOut = path.join(root, "public", "b", "rv");
const extensionOut = path.join(root, "public", "b", "rivet");
const ublockOriginSource = path.join(
  rivetRoot,
  "extensions",
  "ublock.crx",
);

async function buildRouter() {
  await rm(routerOut, { recursive: true, force: true });
  await mkdir(routerOut, { recursive: true });
  const result = await Bun.build({
    entrypoints: [path.join(rivetRoot, "src", "router", "swEntry.ts")],
    outdir: routerOut,
    naming: "router.js",
    target: "browser",
    format: "iife",
    minify: true,
  });
  if (!result.success) {
    console.error("rivet router build failed:", result.logs, NEGATIVE);
    throw new Error(`rivet router build failed${NEGATIVE}`);
  }
}

async function buildUblockOrigin() {
  await rm(extensionOut, { recursive: true, force: true });
  await mkdir(extensionOut, { recursive: true });
  await copyFile(
    ublockOriginSource,
    path.join(extensionOut, "ublock.crx"),
  );
}

await buildRouter();
await buildUblockOrigin();