import { join } from 'path';
import { unlinkSync } from 'fs';

const LOG_DIR = process.cwd();
const LOG_FILE = join(LOG_DIR, 'ban_log.jsonl');
const STORAGE_FILE = join(LOG_DIR, 'approved_domains.json');

const approvedDomains = new Map();
const APPROVED_TTL = 24 * 60 * 60 * 1000;

async function loadApprovedDomains() {
  try {
    const data = await Bun.file(STORAGE_FILE).json();
    const now = Date.now();
    for (const [domain, expiry] of Object.entries(data)) {
      if (expiry > now) approvedDomains.set(domain, expiry);
    }
    console.log(`loaded ${approvedDomains.size} approved domains`);
  } catch {
    console.log('no existing approved domains found or error loading');
  }
}

let savePending = false;
function scheduleSave() {
  if (savePending) return;
  savePending = true;
  setTimeout(flushSave, 5_000);
}

async function flushSave() {
  savePending = false;
  try {
    await Bun.write(STORAGE_FILE, JSON.stringify(Object.fromEntries(approvedDomains)));
  } catch (err) {
    console.error(`failed to save approved domains: ${err.message}`);
  }
}

function approveDomain(domain) {
  approvedDomains.set(domain, Date.now() + APPROVED_TTL);
  scheduleSave();
}

const deniedDomains = new Map();
const DENIED_TTL = 60 * 60 * 1000;

function denyDomain(domain) {
  deniedDomains.set(domain, Date.now() + DENIED_TTL);
}

const BLOCKED_SUFFIXES = [
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
];
const blockedSet = new Set(BLOCKED_SUFFIXES);

function isBlockedSuffix(domain) {
  let idx = domain.indexOf('.');
  while (idx !== -1) {
    if (blockedSet.has(domain.slice(idx))) return true;
    idx = domain.indexOf('.', idx + 1);
  }
  return false;
}

const domainState = new Map();
const DOMAIN_WINDOW = 5 * 60 * 1000;
const DOMAIN_MAX_REQUESTS = 10;
const DOMAIN_BAN_DURATION = 30 * 60 * 1000;

function checkDomainRateLimit(domain) {
  const now = Date.now();
  let state = domainState.get(domain);
  if (!state) {
    domainState.set(domain, { count: 1, windowStart: now, bannedUntil: 0 });
    return 0;
  }
  if (state.bannedUntil > now) return 2;
  if (now - state.windowStart > DOMAIN_WINDOW) {
    state.count = 1;
    state.windowStart = now;
    return 0;
  }
  if (++state.count > DOMAIN_MAX_REQUESTS) {
    state.bannedUntil = now + DOMAIN_BAN_DURATION;
    logAbuse(domain, 'DOMAIN_BANNED', `${state.count} requests in ${DOMAIN_WINDOW / 1000}s`);
    return 1;
  }
  return 0;
}

let globalRequestCount = 0;
let globalWindowStart = Date.now();
let lockdownUntil = 0;
const GLOBAL_WINDOW = 60_000;
const GLOBAL_MAX = 200;
const LOCKDOWN_DURATION = 5 * 60_000;

function checkGlobalRateLimit() {
  const now = Date.now();
  if (now < lockdownUntil) return true;
  if (now - globalWindowStart > GLOBAL_WINDOW) {
    globalRequestCount = 1;
    globalWindowStart = now;
    return false;
  }
  if (++globalRequestCount > GLOBAL_MAX) {
    lockdownUntil = now + LOCKDOWN_DURATION;
    logAbuse('SYSTEM', 'GLOBAL_LOCKDOWN', `${globalRequestCount} req/min exceeded limit`);
    return true;
  }
  return false;
}

function logAbuse(subject, event, detail) {
  const entry = JSON.stringify({ t: Date.now(), subject, event, detail });
  Bun.write(LOG_FILE, entry + '\n').catch(() => {});
  console.log(`[abuse] ${event}: ${subject} - ${detail}`);
}

function isValidDomain(domain) {
  const len = domain.length;
  if (len === 0 || len > 253) return false;
  const first = domain.charCodeAt(0);
  const last = domain.charCodeAt(len - 1);
  if (first === 46 || first === 45 || last === 46 || last === 45) return false;
  let hasDot = false;
  let prevDot = false;
  for (let i = 0; i < len; i++) {
    const c = domain.charCodeAt(i);
    if (c === 46) {
      if (prevDot) return false;
      hasDot = true;
      prevDot = true;
    } else {
      prevDot = false;
      if (c === 45) continue;
      if (c >= 48 && c <= 57) continue;
      if (c >= 97 && c <= 122) continue;
      return false;
    }
  }
  if (!hasDot) return false;
  if (domain === 'localhost' || domain.endsWith('.localhost')) return false;
  let digitRun = 0;
  let dots = 0;
  let allDigitsAndDots = true;
  for (let i = 0; i < len; i++) {
    const c = domain.charCodeAt(i);
    if (c === 46) {
      if (digitRun === 0 || digitRun > 3) { allDigitsAndDots = false; break; }
      digitRun = 0;
      dots++;
    } else if (c >= 48 && c <= 57) {
      digitRun++;
    } else {
      allDigitsAndDots = false;
      break;
    }
  }
  if (allDigitsAndDots && dots === 3 && digitRun > 0 && digitRun <= 3) return false;
  return true;
}

function extractDomain(url) {
  let idx = url.indexOf('domain=');
  if (idx !== -1) {
    const start = idx + 7;
    const end = url.indexOf('&', start);
    const raw = end === -1 ? url.slice(start) : url.slice(start, end);
    return raw.indexOf('%') === -1 ? raw.toLowerCase() : decodeURIComponent(raw).toLowerCase();
  }
  idx = url.indexOf('server_name=');
  if (idx !== -1) {
    const start = idx + 12;
    const end = url.indexOf('&', start);
    const raw = end === -1 ? url.slice(start) : url.slice(start, end);
    return raw.indexOf('%') === -1 ? raw.toLowerCase() : decodeURIComponent(raw).toLowerCase();
  }
  return '';
}

function cleanOldLogs() {
  try {
    const stat = Bun.file(LOG_FILE);
    if (stat.size > 10 * 1024 * 1024) {
      unlinkSync(LOG_FILE);
    }
  } catch {}
}

setInterval(() => {
  const now = Date.now();
  for (const [d, expiry] of approvedDomains) {
    if (now > expiry) approvedDomains.delete(d);
  }
  for (const [d, expiry] of deniedDomains) {
    if (now > expiry) deniedDomains.delete(d);
  }
  for (const [d, state] of domainState) {
    if (state.bannedUntil < now && (now - state.windowStart) > 2 * 60 * 60 * 1000) {
      domainState.delete(d);
    }
  }
}, 5 * 60_000);

setInterval(cleanOldLogs, 24 * 60 * 60_000);

const PORT = 3001;
await loadApprovedDomains();
console.log(`tls server listening on ${PORT}!!`);

Bun.serve({
  port: PORT,
  fetch(req) {
    const domain = extractDomain(req.url);

    if (!domain) return new Response('missing domain', { status: 400 });

    const approvedExpiry = approvedDomains.get(domain);
    if (approvedExpiry) {
      if (Date.now() < approvedExpiry) return new Response('yes!!', { status: 200 });
      approvedDomains.delete(domain);
    }

    const deniedExpiry = deniedDomains.get(domain);
    if (deniedExpiry) {
      if (Date.now() < deniedExpiry) return new Response('no!!', { status: 410 });
      deniedDomains.delete(domain);
    }

    if (!isValidDomain(domain)) {
      denyDomain(domain);
      return new Response('invalid domain', { status: 400 });
    }

    if (isBlockedSuffix(domain)) {
      denyDomain(domain);
      return new Response('no!!', { status: 410 });
    }

    if (Date.now() < lockdownUntil) return new Response('temporarily unavailable :(', { status: 503 });

    if (checkGlobalRateLimit()) return new Response('temporarily unavailable :(', { status: 503 });

    const rl = checkDomainRateLimit(domain);
    if (rl === 2) return new Response('domain temporarily banned', { status: 429 });
    if (rl === 1) return new Response('domain rate limited', { status: 429 });

    approveDomain(domain);
    return new Response('yes!!', { status: 200 });
  },
});