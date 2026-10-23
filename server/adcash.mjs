import fs from "node:fs";
import { mkdir, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

export const ADCASH_LIBRARY_PATH = "/_lyra/adcash/library.js";
export const ADCASH_ZONE_PATH = "/_lyra/adcash/zone.js";
const LIBRARY_URL = "https://adbpage.com/adblock?v=3&format=js";
const REFRESH_MS = 60 * 60 * 1000;
const RETRY_MS = 60 * 1000;
const MAX_LIBRARY_BYTES = 1024 * 1024;

const BOOTSTRAP = [
  "<script>",
  "(function () {",
  "  if (window.__lyraAdcashLoading) return;",
  "  window.__lyraAdcashLoading = true;",
  "  var library = document.createElement('script');",
  "  library.async = true;",
  "  library.src = '" + ADCASH_LIBRARY_PATH + "';",
  "  library.onload = function () {",
  "    var zone = document.createElement('script');",
  "    zone.async = true;",
  "    zone.src = '" + ADCASH_ZONE_PATH + "';",
  "    document.head.appendChild(zone);",
  "  };",
  "  document.head.appendChild(library);",
  "})();",
  "</script>",
].join("\n");

const JS_HEADERS = {
  "Content-Type": "application/javascript; charset=utf-8",
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
};

export function normalizeAdcashZoneTag(input) {
  if (typeof input !== "string" || !input.trim() || input.length > 64 * 1024) {
    throw new Error("the Adcash zone tag must contain at most 64 KiB of JavaScript");
  }

  let code = input.trim();
  if (/^<script\b/i.test(code)) {
    const match = /^<script\b([^>]*)>([\s\S]*?)<\/script\s*>$/i.exec(code);
    if (!match || /\bsrc\s*=/i.test(match[1])) {
      throw new Error("paste only the inline zone script, not the Adcash library tag");
    }
    code = match[2].trim();
  }
  if (!code || /<\/?script\b/i.test(code)) {
    throw new Error("only one inline Adcash zone script is supported");
  }

  // Parse but never execute the publisher-supplied script during setup.
  try {
    new Function(code);
  } catch {
    throw new Error("the Adcash zone script contains invalid JavaScript");
  }
  return code;
}

export function createAdcash({
  root = process.cwd(),
  fetchImpl = fetch,
  now = Date.now,
  logger = console,
  tagFile = path.join(root, ".adcash-zone.tag"),
  cacheFile = path.join(root, "cache", "adcash-lib.js"),
} = {}) {
  let zone;
  try {
    zone = normalizeAdcashZoneTag(fs.readFileSync(tagFile, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") {
      logger.warn("[adcash] invalid zone tag; ads disabled: " + error.message);
    }
    return { enabled: false, injectHtml: (html) => html, handle: () => null };
  }

  let cached = null;
  let freshUntil = 0;
  let retryAt = 0;
  let pending = null;

  try {
    const previous = fs.readFileSync(cacheFile, "utf8");
    if (previous.trim() && Buffer.byteLength(previous) <= MAX_LIBRARY_BYTES) {
      cached = previous;
      freshUntil = fs.statSync(cacheFile).mtimeMs + REFRESH_MS;
    }
  } catch {
    // First installation: no fallback library is available yet.
  }

  async function library() {
    if (cached && now() < freshUntil) return cached;
    if (now() < retryAt) return cached;
    if (pending) return pending;

    pending = (async () => {
      try {
        const response = await fetchImpl(LIBRARY_URL, {
          redirect: "error",
          signal: AbortSignal.timeout(8000),
        });
        if (!response.ok || /text\/html/i.test(response.headers.get("content-type") || "")) {
          throw new Error("upstream did not return JavaScript");
        }
        const claimedLength = Number(response.headers.get("content-length") || 0);
        if (claimedLength > MAX_LIBRARY_BYTES) throw new Error("library is too large");
        const content = await response.text();
        if (!content.trim() || Buffer.byteLength(content) > MAX_LIBRARY_BYTES) {
          throw new Error("library is empty or too large");
        }

        cached = content;
        freshUntil = now() + REFRESH_MS;
        retryAt = 0;
        const tempFile = cacheFile + "." + process.pid + ".tmp";
        try {
          await mkdir(path.dirname(cacheFile), { recursive: true });
          await writeFile(tempFile, content, { mode: 0o600 });
          await rename(tempFile, cacheFile);
        } catch (error) {
          await unlink(tempFile).catch(() => {});
          logger.warn("[adcash] cannot persist library cache: " + error.message);
        }
        return content;
      } catch (error) {
        retryAt = now() + RETRY_MS;
        logger.warn("[adcash] library refresh failed; using cached copy if present: " + error.message);
        return cached;
      } finally {
        pending = null;
      }
    })();
    return pending;
  }

  return {
    enabled: true,
    injectHtml(html) {
      return html.replace(/<\/head\s*>/i, BOOTSTRAP + "\n</head>");
    },
    async handle(req, pathname) {
      if (pathname !== ADCASH_LIBRARY_PATH && pathname !== ADCASH_ZONE_PATH) return null;
      const content = pathname === ADCASH_ZONE_PATH ? zone : await library();
      return new Response(req.method === "HEAD" || content == null ? null : content, {
        status: content == null ? 503 : 200,
        headers: {
          ...JS_HEADERS,
          ...(content == null ? { "Retry-After": "60" } : {}),
        },
      });
    },
  };
}
