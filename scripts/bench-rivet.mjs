import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const current = fileURLToPath(
  new URL("../packages/rivet/src/dnr.ts", import.meta.url),
);
if (process.argv[2] !== "--worker") {
  for (const path of [
    process.argv[2] && resolve(process.argv[2]),
    current,
  ].filter(Boolean)) {
    const result = Bun.spawnSync(
      [process.execPath, import.meta.path, "--worker", path],
      { stdout: "pipe", stderr: "inherit" },
    );
    process.stdout.write(result.stdout);
    if (result.exitCode) process.exit(result.exitCode);
  }
} else {
  const path = process.argv[3];
  const { checkDeclarativeNetRequest } = await import(pathToFileURL(path).href);
  const median = (values) =>
    values.sort((a, b) => a - b)[Math.floor(values.length / 2)];
  const reports = [];
  for (const count of [0, 5000, 30000]) {
    const ext = {
      enabled: true,
      installedAt: 1,
      id: "bench",
      dynamicRules: [],
      sessionRules: [],
      staticRules: Array.from({ length: count }, (_, id) => ({
        id: id + 1,
        priority: 1,
        action: { type: "block" },
        condition: { urlFilter: `||rule${id}.test^` },
      })),
    };
    const registry = { extensions: new Map([[ext.id, ext]]) };
    const check = (url, responseOnly = false) =>
      checkDeclarativeNetRequest(
        registry,
        url,
        "https://page.test/",
        "script",
        responseOnly,
      );
    const start = performance.now();
    if (check("https://miss.test/asset") !== null)
      throw new Error("benchmark decision mismatch... /ᐠ - ˕ -マ");
    const firstMs = performance.now() - start;
    if (
      count &&
      check(`https://rule${count - 1}.test/asset`)?.action !== "block"
    ) {
      throw new Error("benchmark decision mismatch... /ᐠ - ˕ -マ");
    }
    const samples = (responseOnly) =>
      Array.from({ length: 5 }, () => {
        const before = performance.now();
        for (let i = 0; i < 100; i++)
          check(`https://miss.test/asset${i}`, responseOnly);
        return (performance.now() - before) / 100;
      });
    reports.push({
      rules: count,
      first_ms: firstMs,
      warm_ms: median(samples(false)),
      response_ms: median(samples(true)),
    });
  }
  for (const report of reports)
    console.log(JSON.stringify({ implementation: path, ...report }));
}
