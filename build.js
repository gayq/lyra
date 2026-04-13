import crypto from "node:crypto";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { promisify } from "node:util";
import JavaScriptObfuscator from "javascript-obfuscator";

const brotliCompress = promisify(zlib.brotliCompress);
const gzip = promisify(zlib.gzip);
const { obfuscate } = JavaScriptObfuscator;

const CONFIG = {
  compact: true,
  controlFlowFlattening: false,
  deadCodeInjection: false,
  debugProtection: false,
  disableConsoleOutput: true,
  identifierNamesGenerator: "hexadecimal",
  log: false,
  renameGlobals: true,
  selfDefending: false,
  stringArray: false,
  splitStrings: false,
  transformObjectKeys: false,
  unicodeEscapeSequence: false,
};

export default function wavesPlugin() {
  const buildId = crypto.randomBytes(4).toString("hex");
  const serverIp = process.env.IP || "127.0.0.1";
  let distDir;
  let swSrcPath;

  return {
    name: "waves-build",
    enforce: "post",

    configResolved(config) {
      distDir = path.resolve(config.root, config.build.outDir);
      swSrcPath = path.join(config.root, "b", "sw.js");
    },

    async writeBundle(_options, bundle) {
      const precacheAssets = [];
      for (const [fileName, chunk] of Object.entries(bundle)) {
        if (!fileName.startsWith("assets/")) continue;
        if (
          (chunk.type === "chunk" && fileName.endsWith(".js")) ||
          (chunk.type === "asset" && fileName.endsWith(".css"))
        ) {
          precacheAssets.push("/" + fileName);
        }
      }

      let swCode = await fs.readFile(swSrcPath, "utf8");
      swCode = swCode
        .replace(/__SERVER_IP__/g, serverIp)
        .replace(/__BUILD_ID__/g, buildId)
        .replace("'__PRECACHE_ASSETS__'", JSON.stringify(precacheAssets));

      const swObf = obfuscate(swCode, CONFIG).getObfuscatedCode();
      const swHash = crypto
        .createHash("md5")
        .update(swObf)
        .digest("hex")
        .slice(0, 10);
      const swFileName = `b/${swHash}.js`;

      await fs.mkdir(path.join(distDir, "b"), { recursive: true });
      await fs.writeFile(path.join(distDir, swFileName), swObf);

      for (const [fileName, chunk] of Object.entries(bundle)) {
        if (chunk.type !== "chunk") continue;
        const filePath = path.join(distDir, fileName);
        if (!existsSync(filePath)) continue;

        let code = await fs.readFile(filePath, "utf8");

        code = obfuscate(code, {
          ...CONFIG,
          reservedStrings: ["./b/sw.js", "/b/sw.js"],
        }).getObfuscatedCode();

        code = code
          .replace(/(['"`])\.\/b\/sw\.js\1/g, `$1./${swFileName}$1`)
          .replace(/(['"`])\/b\/sw\.js\1/g, `$1/${swFileName}$1`);

        await fs.writeFile(filePath, code);
      }

      const serserAbsPath = path.resolve("public", "b", "u", "serser.js");
      if (existsSync(serserAbsPath)) {
        const serser = await fs.readFile(serserAbsPath, "utf8");
        if (serser.includes("__SERVER_IP__")) {
          await fs.writeFile(
            serserAbsPath,
            serser.replace(/__SERVER_IP__/g, serverIp),
          );
        }
      }

      const compressJobs = [];

      async function scanDir(dir) {
        const entries = await fs.readdir(dir, { withFileTypes: true });
        await Promise.all(
          entries.map(async (entry) => {
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) {
              await scanDir(fullPath);
            } else if (/\.(js|css|html|mjs)$/.test(entry.name)) {
              const buf = await fs.readFile(fullPath);
              compressJobs.push(
                brotliCompress(buf, {
                  params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 },
                }).then((br) => fs.writeFile(fullPath + ".br", br)),
                gzip(buf, { level: 9 }).then((gz) =>
                  fs.writeFile(fullPath + ".gz", gz),
                ),
              );
            }
          }),
        );
      }

      await scanDir(distDir);
      await Promise.all(compressJobs);

      console.log(`\nbuild id:  ${buildId}`);
      console.log(`server ip: ${serverIp}`);
      console.log(`sw:        /${swFileName}`);
      console.log(`precache:  ${precacheAssets.length} asset(s)`);
    },
  };
}