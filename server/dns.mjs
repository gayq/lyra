import { Resolver } from "node:dns/promises";
import { isIP } from "node:net";
import { domainToASCII } from "node:url";
import { httpError } from "./errors.mjs";

const FLAGS = new Set([
  "allow_name_collisions", "bypass_cache", "canonical_name", "disable_ipv4",
  "disable_ipv6", "disable_trr", "offline", "priority_low", "priority_medium", "speculate",
]);

function hostname(value) {
  if (typeof value !== "string" || !value || value.length > 1024 || /[\s/@?#\\]/.test(value)) return null;
  if (isIP(value)) return value;
  const name = domainToASCII(value).toLowerCase().replace(/\.$/, "");
  if (!name || name.length > 253 || !name.includes(".") ||
      name.split(".").some((label) => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) ||
      /(?:^|\.)(?:localhost|local|internal|home\.arpa)$/.test(name)) return null;
  return name;
}

async function records(query) {
  try {
    return await query;
  } catch (error) {
    if (error?.code === "ENODATA" || error?.code === "ENOTFOUND") return [];
    throw error;
  }
}

async function canonicalName(resolver, initial) {
  let current = initial;
  const visited = new Set([current]);
  for (let depth = 0; depth <= 8; depth++) {
    const aliases = await records(resolver.resolveCname(current));
    if (!aliases.length) return current;
    const next = hostname(aliases[0]);
    if (aliases.length !== 1 || !next || isIP(next) || visited.has(next) || depth === 8) {
      throw new Error("dns alias chain is invalid... /ᐠ - ˕ -マ");
    }
    visited.add(next);
    current = next;
  }
}

export function createDnsService({
  createResolver = () => new Resolver({ timeout: 1500, tries: 1 }),
  timeoutMs = 2000,
  maxConcurrent = 64,
} = {}) {
  const pending = new Map();
  let active = 0;
  const failure = () => httpError(502, "DNS_LOOKUP_FAILED", "dns lookup failed");

  async function resolve(input, requestedFlags = []) {
    const name = hostname(input);
    if (!name || !Array.isArray(requestedFlags) || requestedFlags.length > FLAGS.size ||
        requestedFlags.some((flag) => !FLAGS.has(flag))) {
      return httpError(400, "INVALID_DNS_QUERY", "dns query is invalid");
    }
    const flags = new Set(requestedFlags);
    const family = isIP(name);
    if (flags.has("disable_ipv4") && flags.has("disable_ipv6")) return failure();
    if (family) {
      if (flags.has(family === 4 ? "disable_ipv4" : "disable_ipv6")) return failure();
      if (name === "127.0.53.53" && !flags.has("allow_name_collisions")) return failure();
      return { status: 200, body: {
        addresses: [name], isTRR: false,
        ...(flags.has("canonical_name") ? { canonicalName: name } : {}),
      } };
    }
    if (flags.has("offline")) return failure();
    const key = JSON.stringify([name, [...flags].filter((flag) =>
      ["canonical_name", "disable_ipv4", "disable_ipv6", "allow_name_collisions"].includes(flag)).sort()]);
    if (!flags.has("bypass_cache") && pending.has(key)) return pending.get(key);
    if (active >= maxConcurrent) return httpError(503, "DNS_BUSY", "dns lookup is temporarily unavailable");
    active++;
    const lookup = (async () => {
      let resolver;
      let timer;
      try {
        resolver = createResolver();
        const query = Promise.all([
          flags.has("disable_ipv4") ? [] : records(resolver.resolve4(name)),
          flags.has("disable_ipv6") ? [] : records(resolver.resolve6(name)),
          flags.has("canonical_name") ? canonicalName(resolver, name) : undefined,
        ]);
        const [v4, v6, canonical] = await Promise.race([
          query,
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error("dns lookup timed out... /ᐠ - ˕ -マ")), timeoutMs);
          }),
        ]);
        const addresses = [...new Set([...v4, ...v6])].filter((address) =>
          isIP(address) && (flags.has("allow_name_collisions") || address !== "127.0.53.53"));
        if (!addresses.length) return failure();
        return { status: 200, body: {
          addresses, isTRR: false,
          ...(canonical === undefined ? {} : { canonicalName: canonical }),
        } };
      } catch {
        return failure();
      } finally {
        clearTimeout(timer);
        resolver?.cancel();
        active--;
      }
    })();
    if (!flags.has("bypass_cache")) pending.set(key, lookup);
    try {
      return await lookup;
    } finally {
      if (pending.get(key) === lookup) pending.delete(key);
    }
  }

  async function handle(request) {
    let result;
    if (request.method !== "GET") {
      result = httpError(405, "METHOD_NOT_ALLOWED", "request method is not supported");
    } else if (request.headers.get("x-rivet-dns") !== "1" ||
        ["cross-site", "same-site"].includes(request.headers.get("sec-fetch-site"))) {
      result = httpError(403, "DNS_REQUEST_DENIED", "dns request is not allowed");
    } else {
      const params = new URL(request.url).searchParams;
      result = await resolve(params.get("hostname"), params.getAll("flag"));
    }
    return new Response(JSON.stringify(result.body), {
      status: result.status,
      headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store",
        "Cross-Origin-Resource-Policy": "same-origin", "X-Content-Type-Options": "nosniff",
        ...(result.status === 405 ? { Allow: "GET" } : {}),
      },
    });
  }
  return { resolve, handle };
}