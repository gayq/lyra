if (
  typeof crossOriginIsolated === "undefined" &&
  navigator.userAgent.includes("Firefox")
) {
  Object.defineProperty(self, "crossOriginIsolated", {
    value: true,
    writable: false,
  });
}

const scope = self.registration.scope;
const isFolio = scope.endsWith("/b/fl/r/");
const MOCHI_PREFIX = "/!!/";
const BUILD_FINGERPRINT = "__BUILD_ID__";
const SHELL_CACHE = "lyra-shell-" + BUILD_FINGERPRINT;
const RUNTIME_CACHE = "lyra-runtime-" + BUILD_FINGERPRINT;
const PREFETCH_CACHE = "lyra-prefetch-nav-" + BUILD_FINGERPRINT;
const LARGE_CACHE = "lyra-large-files-" + BUILD_FINGERPRINT;
const MAX_PREFETCH_ENTRIES = 48;
const MAX_LARGE_CACHE_ENTRIES = 20;
const MAX_RUNTIME = 300;
const MAX_MEM = 10;
const MAX_PRECONNECTED = 10;
const PRECACHE = [
  "/",
  "/assets/images/icons/favicon.svg",
  ..."__PRECACHE_ASSETS__",
];

const STATIC_REGEX =
  /\.(png|jpg|jpeg|gif|ico|webp|bmp|tiff|svg|mp3|wav|ogg|mp4|webm|woff|woff2|ttf|otf|eot)(\?.*)?$/i;
const CACHEABLE_EXT =
  /\.(css|js|mjs|woff2|woff|ttf|otf|eot|png|jpg|jpeg|gif|ico|webp|svg|wasm)$/i;
const HASHED_ASSET_REGEX = /[-_.][a-f0-9]{6,16}\.\w+$/i;

const CACHEABLE_ASSET_EXTS = new Set([
  ".css", ".wasm", ".mp4", ".m3u8", ".webm", ".mp3", ".wav",
  ".ogg", ".aac", ".flac", ".png", ".jpg", ".jpeg", ".gif",
  ".webp", ".svg", ".ico", ".woff", ".woff2", ".ttf", ".otf",
  ".eot",
]);

const LARGE_EXTENSIONS = new Set([
  ".flac", ".wav", ".aiff", ".alac", ".wma", ".ape", ".dsd",
  ".m4a", ".aac", ".ogg", ".opus", ".wv", ".tta", ".tak",
  ".mkv", ".mp4", ".webm", ".avi", ".mov", "wmv",
  ".zip", ".rar", ".7z", ".tar", ".gz", ".iso",
  ".wasm", ".data", ".pck", ".unityweb", ".bin",
]);

const LARGE_SIZE_THRESHOLD = 50 * 1024 * 1024;
const LARGE_TIMEOUT_MS = 60000;
const PREFETCH_VALIDITY = 30000;
const MOCHI_TIMEOUT_MS = 15000;
const PROXY_NAV_TIMEOUT_MS = 12000;
const PROXY_SUBRESOURCE_TIMEOUT_MS = 8000;
const RUNTIME_REVALIDATE_MS = 5 * 60 * 1000;
const CACHE_TRIM_INTERVAL_MS = 4000;
const PREFETCH_HEADER = "x-lyra-prefetch";
const MAX_HTML_INJECT_BYTES = 4_500_000;
const NEGATIVE = "... /ᐠ - ˕ -マ";

function swNegativeMessage(message) {
  let base = String(message).trimEnd();
  while (base.endsWith(NEGATIVE)) {
    base = base.slice(0, -NEGATIVE.length).trimEnd();
  }
  return `${base.replace(/[.!]+$/u, "")}${NEGATIVE}`;
}
