import { appendFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';

const PORT = 3001;
const NO = [
  '.nip.io', '.sslip.io', '.securly.cloud', '.traefik.me',
  '.myaddr.io', '.backname.io', '.tiktokv.us', '.localtest.me',
  '.lvh.me', '.xip.io', '.nip.io.br', '.vcap.me',
];

const IPS = new Set(['127.0.0.1', 'localhost', '::1', 'unknown']);
const approvedDomains = new Map();
const APPROVED_TTL = 24 * 60 * 60 * 1000;

function isApproved(domain) {
  const expiry = approvedDomains.get(domain);
  if (expiry && Date.now() < expiry) return true;
  if (expiry) approvedDomains.delete(domain);
  return false;
}

function approveDomain(domain) {
  approvedDomains.set(domain, Date.now() + APPROVED_TTL);
}

const domainState = new Map();
const DOMAIN_WINDOW = 5 * 60 * 1000;
const DOMAIN_MAX_REQUESTS = 10;
const DOMAIN_BAN_DURATION = 30 * 60 * 1000;

function getDomainState(domain) {
  let state = domainState.get(domain);
  if (!state) {
    state = { count: 0, windowStart: Date.now(), bannedUntil: 0 };
    domainState.set(domain, state);
  }
  return state;
}

function isDomainBanned(domain) {
  const state = domainState.get(domain);
  if (!state) return false;
  if (state.bannedUntil > Date.now()) return true;
  return false;
}

function checkDomainRateLimit(domain) {
  const state = getDomainState(domain);
  const now = Date.now();

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
    globalRequestCount = 0;
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

function isInLockdown() {
  return Date.now() < lockdownUntil;
}

const LOG_DIR = process.cwd();
const LOG_FILE = join(LOG_DIR, 'ban_log.jsonl');

async function logAbuse(identifier, action, details) {
  const entry = JSON.stringify({
    t: new Date().toISOString(),
    identifier,
    action,
    details,
  }) + '\n';
  try {
    await appendFile(LOG_FILE, entry);
  } catch { }
}

async function cleanOldLogs() {
  try {
    const stat = Bun.file(LOG_FILE);
    if (stat.size > 10 * 1024 * 1024) {
      await unlink(LOG_FILE);
    }
  } catch { }
}

function isValidDomain(domain) {
  if (!domain || domain.length > 253) return false;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(domain)) return false;
  if (domain.includes(':')) return false;
  if (domain === 'localhost' || domain.endsWith('.localhost')) return false;
  if (!domain.includes('.')) return false;
  if (!/^[a-z0-9.-]+$/.test(domain)) return false;
  if (/\.\./.test(domain) || domain.startsWith('.') || domain.startsWith('-') || domain.endsWith('.') || domain.endsWith('-')) return false;
  return true;
}

setInterval(() => {
  const now = Date.now();
  
  for (const [d, expiry] of approvedDomains) {
    if (now > expiry) approvedDomains.delete(d);
  }
  
  for (const [d, state] of domainState) {
    if (state.bannedUntil < now && (now - state.windowStart) > 2 * 60 * 60 * 1000) {
      domainState.delete(d);
    }
  }
}, 5 * 60_000);

setInterval(cleanOldLogs, 24 * 60 * 60_000);

console.log(`tls server listening on ${PORT}!!`);

Bun.serve({
  port: PORT,
  fetch(req) {
    try {
      const url = new URL(req.url, 'http://localhost');
      const ip = req.headers.get('x-real-ip') || req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
      const domainFromQuery = url.searchParams.get('domain') || url.searchParams.get('server_name');
      const domainFromHeader = req.headers.get('Host') || '';
      const domain = (domainFromQuery || domainFromHeader.split(':')[0]).toLowerCase();

      if (!domain) {
        return new Response('missing domain', { status: 400 });
      }

      if (isApproved(domain)) {
        return new Response('yes!!', { status: 200 });
      }

      if (IPS.has(ip)) {
        if (!isValidDomain(domain)) {
          return new Response('invalid domain', { status: 400 });
        }
        if (NO.some(s => domain.endsWith(s))) {
          return new Response('no!!', { status: 410 });
        }
        
        if (checkDomainRateLimit(domain)) {
          return new Response('domain rate limited', { status: 429 });
        }
        
        approveDomain(domain);
        return new Response('yes!!', { status: 200 });
      }

      if (isInLockdown()) {
        logAbuse(ip, 'LOCKDOWN_REJECT', domain);
        return new Response('temporarily unavailable :(', { status: 503 });
      }

      if (checkGlobalRateLimit()) {
        return new Response('temporarily unavailable :(', { status: 503 });
      }

      if (!isValidDomain(domain)) {
        return new Response('invalid domain', { status: 400 });
      }

      if (NO.some(s => domain.endsWith(s))) {
        return new Response('no!!', { status: 410 });
      }

      if (isDomainBanned(domain)) {
        return new Response('domain temporarily banned', { status: 429 });
      }

      if (checkDomainRateLimit(domain)) {
        return new Response('domain rate limited', { status: 429 });
      }

      approveDomain(domain);
      return new Response('yes!!', { status: 200 });

    } catch (err) {
      console.error(`request error: ${err.message}`);
      return new Response('error', { status: 500 });
    }
  },
});