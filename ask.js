import { join } from 'path';
import { unlinkSync } from 'fs';

const LOG_DIR = process.cwd();
const LOG_FILE = join(LOG_DIR, 'ban_log.jsonl');
const STORAGE_FILE = join(LOG_DIR, 'approved_domains.json');
const RES_YES = new Response('yes!!', { status: 200 });
const RES_NO = new Response('no!!', { status: 410 });
const RES_MISSING = new Response('missing domain', { status: 400 });
const RES_INVALID = new Response('invalid domain', { status: 400 });
const RES_RATE_DOMAIN = new Response('domain rate limited', { status: 429 });
const RES_BANNED = new Response('domain temporarily banned', { status: 429 });
const RES_UNAVAIL = new Response('temporarily unavailable :(', { status: 503 });
const RES_ERR = new Response('error', { status: 500 });

function res(r) { return r.clone(); }

const approvedDomains = new Map();
const APPROVED_TTL = 24 * 60 * 60 * 1000;

async function loadApprovedDomains() {
  try {
    const data = await Bun.file(STORAGE_FILE).json();
    const now = Date.now();
    for (const [domain, expiry] of Object.entries(data)) {
      if (expiry > now) {
        approvedDomains.set(domain, expiry);
      }
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

function isApproved(domain) {
  const expiry = approvedDomains.get(domain);
  if (!expiry) return false;
  if (Date.now() < expiry) return true;
  approvedDomains.delete(domain);
  return false;
}

function approveDomain(domain) {
  approvedDomains.set(domain, Date.now() + APPROVED_TTL);
  scheduleSave();
}

const deniedDomains = new Map();
const DENIED_TTL = 60 * 60 * 1000;

function isDenied(domain) {
  const expiry = deniedDomains.get(domain);
  if (!expiry) return false;
  if (Date.now() < expiry) return true;
  deniedDomains.delete(domain);
  return false;
}

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

function isDomainBanned(domain) {
  const state = domainState.get(domain);
  return state ? state.bannedUntil > Date.now() : false;
}

function checkDomainRateLimit(domain) {
  const now = Date.now();
  let state = domainState.get(domain);
  if (!state) {
    state = { count: 1, windowStart: now, bannedUntil: 0 };
    domainState.set(domain, state);
    return false;
  }

  if (now - state.windowStart > DOMAIN_WINDOW) {
    state.count = 1;
    state.windowStart = now;
    return false;
  }

  state.count++;

  if (state.count > DOMAIN_MAX_REQUESTS) {
    state.bannedUntil = now + DOMAIN_BAN_DURATION;
    logAbuse(domain, 'DOMAIN_BANNED', `${state.count} requests in ${DOMAIN_WINDOW / 1000}s`);
    return true;
  }

  return false;
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

  globalRequestCount++;

  if (globalRequestCount > GLOBAL_MAX) {
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

const VALID_DOMAIN_RE = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/;
const IP_RE = /^\d{1,3}(\.\d{1,3}){3}$/;

function isValidDomain(domain) {
  const len = domain.length;
  if (len === 0 || len > 253) return false;
  if (domain.charCodeAt(0) === 46 || domain.charCodeAt(0) === 45) return false;
  if (domain.charCodeAt(len - 1) === 46 || domain.charCodeAt(len - 1) === 45) return false;
  if (!domain.includes('.')) return false;
  if (domain.includes('..') || domain.includes(':')) return false;
  if (domain === 'localhost' || domain.endsWith('.localhost')) return false;
  if (IP_RE.test(domain)) return false;
  if (!VALID_DOMAIN_RE.test(domain)) return false;
  return true;
}

function cleanOldLogs() {
  try {
    const stat = Bun.file(LOG_FILE);
    if (stat.size > 10 * 1024 * 1024) {
      unlinkSync(LOG_FILE);
    }
  } catch {}
}

function extractDomain(url) {
  const qIdx = url.indexOf('?');
  if (qIdx === -1) return '';
  const qs = url.slice(qIdx + 1);
  const params = qs.split('&');
  for (let i = 0; i < params.length; i++) {
    const eq = params[i].indexOf('=');
    if (eq === -1) continue;
    const key = params[i].slice(0, eq);
    if (key === 'domain' || key === 'server_name') {
      return decodeURIComponent(params[i].slice(eq + 1)).toLowerCase();
    }
  }
  return '';
}

const LOCAL_IPS = new Set(['127.0.0.1', 'localhost', '::1', 'unknown']);

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
    try {
      const domain = extractDomain(req.url);

      if (!domain) {
        return res(RES_MISSING);
      }

      if (isApproved(domain)) {
        return res(RES_YES);
      }

      if (isDenied(domain)) {
        return res(RES_NO);
      }

      if (!isValidDomain(domain)) {
        denyDomain(domain);
        return res(RES_INVALID);
      }

      if (isBlockedSuffix(domain)) {
        denyDomain(domain);
        return res(RES_NO);
      }

      const ip = req.headers.get('x-real-ip') || req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';

      if (LOCAL_IPS.has(ip)) {
        approveDomain(domain);
        return res(RES_YES);
      }

      if (Date.now() < lockdownUntil) {
        logAbuse(ip, 'LOCKDOWN_REJECT', domain);
        return res(RES_UNAVAIL);
      }

      if (checkGlobalRateLimit()) {
        return res(RES_UNAVAIL);
      }

      if (isDomainBanned(domain)) {
        return res(RES_BANNED);
      }

      if (checkDomainRateLimit(domain)) {
        return res(RES_RATE_DOMAIN);
      }

      approveDomain(domain);
      return res(RES_YES);

    } catch (err) {
      console.error(`request error: ${err.message}`);
      return res(RES_ERR);
    }
  },
});