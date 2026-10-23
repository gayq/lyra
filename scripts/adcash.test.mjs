import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createAdcash, normalizeAdcashZoneTag } from "../server/adcash.mjs";

test("rejects empty or external/multiple zone tags", () => {
  expect(() => normalizeAdcashZoneTag("")).toThrow();
  expect(() => normalizeAdcashZoneTag('<script src="https://example.test/x.js"></script>')).toThrow();
  expect(() => normalizeAdcashZoneTag("<script>ok();</script><script>bad();</script>")).toThrow();
  expect(normalizeAdcashZoneTag("<script>hello();</script>")).toBe("hello();");
});

test("ads are disabled without a configured tag", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "lyra-adcash-"));
  try {
    const ads = createAdcash({ root: dir });
    expect(ads.enabled).toBe(false);
    expect(ads.injectHtml("<head></head>")).toBe("<head></head>");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("library is fetched once and cached for an hour; zones only served when configured", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "lyra-adcash-"));
  let current = 1000;
  let requests = 0;
  const tagFile = path.join(dir, ".adcash-zone.tag");
  writeFileSync(tagFile, "<script>window.testZone = true;</script>");
  try {
    const ads = createAdcash({
      root: dir,
      now: () => current,
      fetchImpl: async () => { requests++; return new Response("window.testLibrary = true;", { status: 200 }); },
    });
    const get = new Request("https://example.test/", { method: "GET" });
    expect(ads.enabled).toBe(true);
    expect(ads.injectHtml("<head></head>")).toContain("/_lyra/adcash/library.js");
    expect(await (await ads.handle(get, "/_lyra/adcash/library.js")).text()).toContain("testLibrary");
    expect(await (await ads.handle(get, "/_lyra/adcash/library.js")).text()).toContain("testLibrary");
    expect(requests).toBe(1);
    expect(await (await ads.handle(get, "/_lyra/adcash/zone.js")).text()).toBe("window.testZone = true;");
    expect(ads.handle(get, "/other")).toBeNull();
    current += 3_600_001;
    await ads.handle(get, "/_lyra/adcash/library.js");
    expect(requests).toBe(2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("uses stale cached library after refresh errors", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "lyra-adcash-"));
  writeFileSync(path.join(dir, ".adcash-zone.tag"), "window.adcash = 1;");
  const cacheDir = path.join(dir, "cache");
  mkdirSync(cacheDir);
  writeFileSync(path.join(cacheDir, "adcash-lib.js"), "window.stale = true;");
  try {
    const ads = createAdcash({
      root: dir,
      now: () => Date.now() + 3_600_001,
      logger: { warn() {} },
      fetchImpl: async () => { throw new Error("network unavailable"); },
    });
    const response = await ads.handle(new Request("https://example.test/"), "/_lyra/adcash/library.js");
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("stale");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
