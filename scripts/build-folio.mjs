import { copyFile, mkdir, readdir, rm, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const root = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const vendorDir = path.join(root, "vendor", "folio");
const publicOutDir = path.join(root, "public", "b", "fl");
const toolPath = [
  "/opt/homebrew/opt/rustup/bin",
  path.join(process.env.HOME || "", ".cargo", "bin"),
  "/opt/homebrew/bin",
  process.env.PATH || "",
]
  .filter(Boolean)
  .join(path.delimiter);
const pnpmCommand = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const corepackCommand = process.platform === "win32" ? "corepack.cmd" : "corepack";
const bunxCommand = process.platform === "win32" ? "bunx.cmd" : "bunx";
const folioPnpmSpec = "pnpm@10.12.1";
const tscPath = path.join(
  root,
  "node_modules",
  ".bin",
  process.platform === "win32" ? "tsc.cmd" : "tsc",
);
const tscAliasPath = path.join(
  vendorDir,
  "node_modules",
  ".bin",
  process.platform === "win32" ? "tsc-alias.cmd" : "tsc-alias",
);
const rspackPath = path.join(
  vendorDir,
  "node_modules",
  "@rspack",
  "cli",
  "bin",
  "rspack.js",
);

const expectedFiles = [
  {
    from: path.join(vendorDir, "packages", "core", "dist", "folio.js"),
    to: "folio.js",
  },
  {
    from: path.join(vendorDir, "packages", "core", "dist", "folio.wasm"),
    to: "folio.wasm",
  },
  {
    from: path.join(vendorDir, "packages", "controller", "dist", "controller.api.js"),
    to: "controller.api.js",
  },
  {
    from: path.join(vendorDir, "packages", "controller", "dist", "controller.inject.js"),
    to: "controller.inject.js",
  },
  {
    from: path.join(vendorDir, "packages", "controller", "dist", "controller.sw.js"),
    to: "controller.sw.js",
  },
  {
    from: path.join(vendorDir, "packages", "utils", "dist", "folio-utils.js"),
    to: "folio-utils.js",
  },
];

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? root,
      env: { ...process.env, CI: "1", PATH: toolPath, ...options.env },
      stdio: "inherit",
    });

    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error("build command failed... /ᐠ - ˕ -マ"));
    });
  });
}

function commandExists(command) {
  return new Promise((resolve) => {
    const checker = process.platform === "win32" ? "where" : "command";
    const args = process.platform === "win32" ? [command] : ["-v", command];
    const child = spawn(checker, args, {
      env: { ...process.env, PATH: toolPath },
      stdio: "ignore",
      shell: process.platform !== "win32",
    });

    child.on("error", () => resolve(false));
    child.on("exit", (code) => resolve(code === 0));
  });
}

async function resolvePnpm() {
  if (await commandExists(bunxCommand)) {
    return { command: bunxCommand, prefix: [folioPnpmSpec] };
  }
  if (await commandExists(corepackCommand)) {
    await run(corepackCommand, ["enable"]);
    return { command: corepackCommand, prefix: ["pnpm"] };
  }
  if (await commandExists(pnpmCommand)) {
    return { command: pnpmCommand, prefix: [] };
  }
  throw new Error("pnpm is required to build vendored folio... /ᐠ - ˕ -マ");
}

async function ensureVendoredSource() {
  if (!existsSync(path.join(vendorDir, "package.json"))) {
    throw new Error("vendored folio source is missing... /ᐠ - ˕ -マ");
  }
}

async function ensureInstall() {
  const pnpm = await resolvePnpm();
  await run(
    pnpm.command,
    [
      ...pnpm.prefix,
      "install",
      "--frozen-lockfile",
      "--config.dangerously-allow-all-builds=true",
    ],
    { cwd: vendorDir },
  );
}

async function buildDeclarations() {
  const declarations = [
    { config: "packages/core/tsconfig.types.json", rewriteAliases: true },
    { config: "packages/controller/tsconfig.types.json", rewriteAliases: false },
    { config: "packages/utils/tsconfig.types.json", rewriteAliases: false },
  ];

  await Promise.all(
    declarations.map(({ config }) =>
      rm(path.join(vendorDir, path.dirname(config), "dist", "types"), {
        recursive: true,
        force: true,
      }),
    ),
  );

  for (const { config, rewriteAliases } of declarations) {
    await run(tscPath, ["--project", config], { cwd: vendorDir });
    if (rewriteAliases) {
      await run(tscAliasPath, ["--project", config], { cwd: vendorDir });
    }
  }
}

async function copyExpectedFiles() {
  await rm(publicOutDir, { recursive: true, force: true });
  await mkdir(publicOutDir, { recursive: true });

  for (const file of expectedFiles) {
    if (!existsSync(file.from)) {
      throw new Error("required folio build artifact is missing... /ᐠ - ˕ -マ");
    }
    await copyFile(file.from, path.join(publicOutDir, file.to));
  }

  for (const fileName of await readdir(publicOutDir)) {
    const fullPath = path.join(publicOutDir, fileName);
    const details = await stat(fullPath);
    if (!details.isFile() || details.size === 0) {
      throw new Error("folio build artifact is invalid... /ᐠ - ˕ -マ");
    }
  }
}

await ensureVendoredSource();
await ensureInstall();
const pnpm = await resolvePnpm();
await run(pnpm.command, [...pnpm.prefix, "--filter", "@mercuryworkshop/folio", "rewriter:build"], {
  cwd: vendorDir,
});
await run(
  process.execPath,
  [
    rspackPath,
    "build",
    "--mode",
    "production",
    "--config-name",
    "folio-iife",
    "--config-name",
    "folio-esmodule",
    "--config-name",
    "folio-controller",
    "--config-name",
    "folio-utils-iife",
  ],
  { cwd: vendorDir, env: { NODE_ENV: "production" } },
);
await buildDeclarations();
await copyExpectedFiles();