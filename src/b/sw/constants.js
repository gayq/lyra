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
const isScramjet = scope.endsWith("/b/s/r/");
const isUltraviolet = scope.endsWith("/b/u/r/");
const UV_PREFIX = "/b/u/r/";
const MOCHI_PREFIX = "/!!/";
const CACHE_VERSION = "__BUILD_ID__";
const SHELL_CACHE = "waves-shell-" + CACHE_VERSION;
const RUNTIME_CACHE = "waves-runtime-" + CACHE_VERSION;
const PREFETCH_CACHE = "waves-prefetch-nav-" + CACHE_VERSION;
const LARGE_CACHE = "waves-large-files-" + CACHE_VERSION;
const MAX_PREFETCH_ENTRIES = 48;
const MAX_LARGE_CACHE_ENTRIES = 20;
const MAX_RUNTIME = 300;
const MAX_MEM = 10;
const MAX_PRELOADED = 5;
const MAX_PRECONNECTED = 10;
const PRECACHE = [
  "/",
  "/assets/images/icons/favicon.ico",
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
const BANDWIDTH_SIZE = 10;
const DEFAULT_CHUNK = 2 * 1024 * 1024;
const MIN_CHUNK = 512 * 1024;
const MAX_CHUNK = 10 * 1024 * 1024;
const MOCHI_TIMEOUT_MS = 15000;
const PROXY_NAV_TIMEOUT_MS = 12000;
const PROXY_SUBRESOURCE_TIMEOUT_MS = 8000;
const MOCHI_SECONDARY_MS = 12000;
const PREFETCH_HEADER = "x-waves-prefetch";
const MAX_HTML_INJECT_BYTES = 4_500_000;