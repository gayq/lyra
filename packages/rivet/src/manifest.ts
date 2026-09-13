import type { ChromeManifest, ChromeManifestAction, ChromeManifestIcons } from "./types";

function getManifestVersion(manifest: ChromeManifest): number {
  return Number(manifest.manifest_version) || 2;
}

export type BackgroundInfo =
  | { type: "worker"; script: string; isModule: boolean }
  | { type: "page"; page: string }
  | { type: "scripts"; scripts: string[] }
  | null;

export function getBackgroundInfo(manifest: ChromeManifest): BackgroundInfo {
  if (getManifestVersion(manifest) === 3) {
    const sw = manifest.background?.service_worker;
    return sw ? { type: "worker", script: sw, isModule: manifest.background?.type === "module" } : null;
  }
  if (manifest.background?.page) {
    return { type: "page", page: manifest.background.page };
  }
  if (manifest.background?.scripts?.length) {
    return { type: "scripts", scripts: manifest.background.scripts };
  }
  return null;
}

interface CompiledPattern {
  scheme: string;
  host: string;
  subdomains: boolean;
  port: string;
  path: RegExp;
}

const patternCache = new Map<string, CompiledPattern | null>();

function compilePattern(pattern: string): CompiledPattern | null {
  const parts = /^(\*|http|https|file|ftp):\/\/(\[[\da-f:]+\]|[^/:]*)(?::(\*|\d+))?(\/.*)$/i.exec(pattern);
  if (!parts) return null;
  const [, scheme = "", authority = "", port = "", path = ""] = parts;
  const subdomains = authority.startsWith("*.");
  const host = (subdomains ? authority.slice(2) : authority).toLowerCase();
  if ((host !== "*" && /[*?#@]/.test(host)) || (subdomains && (!host || host === "*"))) return null;
  if (!host && scheme.toLowerCase() !== "file") return null;
  if (port !== "*" && port && Number(port) > 65535) return null;
  return {
    scheme: scheme.toLowerCase(), host, subdomains, port,
    path: new RegExp("^" + path.split("*").map((part) =>
      part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
    ).join(".*") + "$"),
  };
}

export function matchPattern(pattern: string, url: string): boolean {
  try {
    const parsed = new URL(url);
    if (pattern === "<all_urls>") return /^(https?|file|ftp):$/.test(parsed.protocol);
    let compiled = patternCache.get(pattern);
    if (compiled === undefined) {
      compiled = compilePattern(pattern);
      if (patternCache.size >= 2048) patternCache.delete(patternCache.keys().next().value!);
      patternCache.set(pattern, compiled);
    }
    if (!compiled) return false;
    const { scheme, host, subdomains, port, path } = compiled;
    if (scheme === "*" ? !/^https?:$/.test(parsed.protocol) : parsed.protocol !== scheme + ":") return false;
    if (host !== "*" && parsed.hostname !== host && !(subdomains && parsed.hostname.endsWith("." + host))) return false;
    const actualPort = parsed.port || ({ "http:": "80", "https:": "443", "ftp:": "21" }[parsed.protocol] ?? "");
    if (port && port !== "*" && Number(port) !== Number(actualPort)) return false;
    return path.test(parsed.pathname + parsed.search);
  } catch {
    return false;
  }
}

export function urlMatchesPatterns(url: string, matches: string[], excludeMatches: string[] = []): boolean {
  if (excludeMatches.some((p) => matchPattern(p, url))) return false;
  return matches.some((p) => matchPattern(p, url));
}

export function resolveManifestI18n(manifest: ChromeManifest, messages: Record<string, { message: string }>): ChromeManifest {
  const resolve = (s: string | undefined): string | undefined => {
    if (!s) return s;
    const key = s.match(/^__MSG_(.+)__$/)?.[1];
    if (!key) return s;
    return messages[key]?.message ?? s;
  };
  manifest.name = resolve(manifest.name) ?? manifest.name;
  const shortName = resolve(manifest.short_name);
  if (shortName === undefined) delete manifest.short_name;
  else manifest.short_name = shortName;
  const description = resolve(manifest.description);
  if (description === undefined) delete manifest.description;
  else manifest.description = description;
  for (const key of ["action", "browser_action", "page_action"] as const) {
    const action = manifest[key] as ChromeManifestAction | undefined;
    if (action?.default_title) {
      const title = resolve(action.default_title);
      if (title === undefined) delete action.default_title;
      else action.default_title = title;
    }
  }
  return manifest;
}

export function getDefaultIcon(manifest: ChromeManifest): string | null {
  const icons: string | ChromeManifestIcons | undefined =
    (manifest.action as ChromeManifestAction | undefined)?.default_icon ??
    (manifest.browser_action as ChromeManifestAction | undefined)?.default_icon ??
    (manifest.page_action as ChromeManifestAction | undefined)?.default_icon ??
    manifest.icons;
  if (!icons) return null;
  if (typeof icons === "string") return icons;
  const sizes = Object.keys(icons)
    .map(Number)
    .filter((n) => !Number.isNaN(n))
    .sort((a, b) => b - a);
  const largest = sizes[0];
  if (largest !== undefined) return icons[String(largest)] ?? null;
  const firstKey = Object.keys(icons)[0];
  return firstKey ? (icons[firstKey] ?? null) : null;
}
