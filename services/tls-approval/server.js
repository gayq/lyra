import { availableParallelism, totalmem } from 'node:os';

const PORT = 3001;
const NEGATIVE = '... /ᐠ - ˕ -マ';
const POSITIVE = '!! (˵◝ ⩊  ◜˵マ';
const YES = `yes${POSITIVE}`;
const OK = 'oki';
const NO = `no${NEGATIVE}`;
const MISSING = `missing domain${NEGATIVE}`;
const INVALID = `invalid domain${NEGATIVE}`;
const BANNED = `domain temporarily banned${NEGATIVE}`;
const LIMITED = `domain rate limited${NEGATIVE}`;
const UNAVAILABLE = `temporarily unavailable${NEGATIVE}`;
const approvedUntilByDomain = new Map();
const APPROVAL_TTL_MS = 86_400_000;
const deniedUntilByDomain = new Map();
const DENIAL_TTL_MS = 3_600_000;

const blocked = new Set([
  '.nip.io', '.sslip.io', '.securly.cloud', '.traefik.me',
  '.myaddr.io', '.backname.io', '.tiktokv.us', '.localtest.me',
  '.lvh.me', '.xip.io', '.nip.io.br', '.vcap.me',
  '.xip.name', '.redirectme.net', '.wildcard.run',
  '.duckdns.org', '.freedns.afraid.org', '.ngrok.io', '.ngrok.app',
  '.serveo.net', '.localhost.run', '.tunnelmole.com',
  '.loca.lt', '.telebit.cloud', '.trycloudflare.com',
  '.burpcollaborator.net', '.interact.sh', '.oast.fun',
  '.oast.live', '.oast.site', '.oast.me', '.oast.online',
  '.oastify.com', '.canarytokens.com',
]);

const domainLimits = new Map();
const DOMAIN_WINDOW_MS = 300_000;
const DOMAIN_MAX_REQUESTS = 10;
const DOMAIN_BAN_MS = 1_800_000;

let globalRequestCount = 0;
let globalWindowStartedAt = Date.now();
let globalLockedUntil = 0;
const GLOBAL_WINDOW_MS = 60_000;
const HOST_CORES = Math.max(1, availableParallelism());
const HOST_MEMORY_BYTES = Math.max(256 * 1024 * 1024, totalmem());
const STATE_MEMORY_BUDGET = Math.max(8 * 1024 * 1024, Math.floor(HOST_MEMORY_BYTES / 128));
const ESTIMATED_DOMAIN_STATE_BYTES = 512;
const MIN_STATE_ENTRIES = HOST_CORES * 256;
const MAX_STATE_ENTRIES = Math.max(
  MIN_STATE_ENTRIES,
  Math.floor(STATE_MEMORY_BUDGET / ESTIMATED_DOMAIN_STATE_BYTES / 3),
);
let stateEntryLimit = Math.max(MIN_STATE_ENTRIES, Math.floor(MAX_STATE_ENTRIES / 2));
const GLOBAL_MAX_REQUESTS = Math.max(200, HOST_CORES * 100);
const GLOBAL_LOCK_MS = 300_000;

function trimMap(map) {
  while (map.size > stateEntryLimit) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
}

function setDomainState(map, domain, value) {
  if (map.has(domain)) map.delete(domain);
  map.set(domain, value);
  trimMap(map);
}

function pruneState(now) {
  for (const [domain, expiresAt] of approvedUntilByDomain) {
    if (expiresAt <= now) approvedUntilByDomain.delete(domain);
  }
  for (const [domain, expiresAt] of deniedUntilByDomain) {
    if (expiresAt <= now) deniedUntilByDomain.delete(domain);
  }
  for (const [domain, state] of domainLimits) {
    if (state.banned <= now && state.window + DOMAIN_WINDOW_MS <= now) {
      domainLimits.delete(domain);
    }
  }
}

function rebalanceState() {
  const now = Date.now();
  pruneState(now);
  const usage = process.memoryUsage();
  const stateEntries = approvedUntilByDomain.size + deniedUntilByDomain.size + domainLimits.size;
  if (usage.rss > STATE_MEMORY_BUDGET * 2 && stateEntryLimit > MIN_STATE_ENTRIES) {
    stateEntryLimit = Math.max(MIN_STATE_ENTRIES, Math.floor(stateEntryLimit * 0.75));
  } else if (
    stateEntries >= stateEntryLimit * 2
    && usage.rss < STATE_MEMORY_BUDGET
    && stateEntryLimit < MAX_STATE_ENTRIES
  ) {
    stateEntryLimit = Math.min(MAX_STATE_ENTRIES, Math.ceil(stateEntryLimit * 1.125));
  }
  trimMap(approvedUntilByDomain);
  trimMap(deniedUntilByDomain);
  trimMap(domainLimits);
}

setInterval(rebalanceState, Math.max(5_000, Math.floor(DOMAIN_WINDOW_MS / 10))).unref?.();

function blockedSuffix(domain) {
  for (
    let index = domain.indexOf('.');
    index !== -1;
    index = domain.indexOf('.', index + 1)
  ) {
    if (blocked.has(domain.slice(index))) return true;
  }
  return false;
}

function validDomain(domain) {
  const len = domain.length;
  if (len === 0 || len > 253) return false;

  const first = domain.charCodeAt(0);
  const last = domain.charCodeAt(len - 1);
  if (first === 46 || first === 45 || last === 46 || last === 45) return false;

  let hasDot = false;
  let pd = false;
  let dcount = 0;
  let slen = 0;
  let ip = true;

  for (let i = 0; i < len; i++) {
    const c = domain.charCodeAt(i);
    if (c === 46) {
      if (pd || slen > 63) return false;
      hasDot = true;
      pd = true;
      slen = 0;
      dcount++;
    } else {
      pd = false;
      slen++;
      if (c === 45) {
        if (i === len - 1 || i > 0 && domain.charCodeAt(i - 1) === 46) return false;
        ip = false;
      } else if (c >= 48 && c <= 57) {
        if (dcount > 3) ip = false;
      } else if (c >= 97 && c <= 122) {
        ip = false;
      } else return false;
    }
  }

  if (!hasDot || pd) return false;
  if (dcount === 3 && ip && slen <= 3) return false;
  return true;
}

function extractDomain(url) {
  try {
    const params = new URL(url).searchParams;
    return (params.get('domain') ?? params.get('server_name') ?? '').toLowerCase();
  } catch {
    return '';
  }
}

function reply(body, status) {
  return new Response(body, { status });
}

export function handleApproval(req) {
  if (new URL(req.url).pathname === '/health') return reply(OK, 200);

  const now = Date.now();
  const domain = extractDomain(req.url);
  if (!domain) return reply(MISSING, 400);

  const approvedUntil = approvedUntilByDomain.get(domain);
  if (approvedUntil) {
    if (now < approvedUntil) return reply(YES, 200);
    approvedUntilByDomain.delete(domain);
  }

  const deniedUntil = deniedUntilByDomain.get(domain);
  if (deniedUntil) {
    if (now < deniedUntil) return reply(NO, 410);
    deniedUntilByDomain.delete(domain);
  }

  if (!validDomain(domain)) {
    setDomainState(deniedUntilByDomain, domain, now + DENIAL_TTL_MS);
    return reply(INVALID, 400);
  }

  if (blockedSuffix(domain)) {
    setDomainState(deniedUntilByDomain, domain, now + DENIAL_TTL_MS);
    return reply(NO, 410);
  }

  if (now < globalLockedUntil) return reply(UNAVAILABLE, 503);
  if (now - globalWindowStartedAt > GLOBAL_WINDOW_MS) {
    globalRequestCount = 1;
    globalWindowStartedAt = now;
  } else if (++globalRequestCount > GLOBAL_MAX_REQUESTS) {
    globalLockedUntil = now + GLOBAL_LOCK_MS;
    console.warn(
      { code: 'GLOBAL_LOCKDOWN', requestsPerMinute: globalRequestCount },
      `global request limit exceeded${NEGATIVE}`,
    );
    return reply(UNAVAILABLE, 503);
  }

  const limit = domainLimits.get(domain);
  if (limit) {
    if (limit.banned > now) return reply(BANNED, 429);
    if (now - limit.window > DOMAIN_WINDOW_MS) {
      limit.count = 1;
      limit.window = now;
    } else if (++limit.count > DOMAIN_MAX_REQUESTS) {
      limit.banned = now + DOMAIN_BAN_MS;
      console.warn(
        { code: 'DOMAIN_BANNED', domain, requests: limit.count },
        `domain request limit exceeded${NEGATIVE}`,
      );
      return reply(LIMITED, 429);
    }
  } else {
    setDomainState(domainLimits, domain, { count: 1, window: now, banned: 0 });
  }

  setDomainState(approvedUntilByDomain, domain, now + APPROVAL_TTL_MS);
  return reply(YES, 200);
}

if (import.meta.main) {
  console.log(`tls server listening on ${PORT}${POSITIVE}`);
  Bun.serve({ port: PORT, fetch: handleApproval });
}
