export const IMMUTABLE_CACHE_CONTROL =
  "public, max-age=31536000, immutable";
export const REVALIDATE_CACHE_CONTROL =
  "public, max-age=0, must-revalidate";
export const NO_STORE_CACHE_CONTROL = "no-store, max-age=0";

const VITE_HASHED_PATH =
  /^\/assets\/[a-f0-9]{12}\/[a-z0-9_-]{12}\.[a-z0-9]+$/i;
const OPAQUE_RUNTIME_PATH = /^\/b\/[a-f0-9]{10,12}\.[a-z0-9]+$/i;

export function distCacheControl(pathname) {
  if (pathname === "/build-meta.json" || pathname.toLowerCase().endsWith(".html")) {
    return NO_STORE_CACHE_CONTROL;
  }
  if (VITE_HASHED_PATH.test(pathname) || OPAQUE_RUNTIME_PATH.test(pathname)) {
    return IMMUTABLE_CACHE_CONTROL;
  }
  return REVALIDATE_CACHE_CONTROL;
}