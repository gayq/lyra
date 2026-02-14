import { appendFile, readdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';

const PORT = 3001;

const BLOCKED_SUFFIXES = [
  '.nip.io', '.sslip.io', '.securly.cloud', '.traefik.me',
  '.myaddr.io', '.backname.io', '.tiktokv.us', '.localtest.me',
  '.lvh.me', '.xip.io', '.nip.io.br', '.vcap.me',
];

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

const ipState = new Map();
const SCORE_REJECTED_DOMAIN = 3;
const SCORE_INVALID_FORMAT = 5;
const SCORE_RATE_EXCEEDED = 2;
const SCORE_DGA_DETECTED = 8;
const SCORE_BAD_REPUTATION = 4;
const DECAY_RATE = 1;
const DECAY_INTERVAL = 60_000;

function getBanDuration(score) {
  if (score >= 50) return 24 * 60 * 60 * 1000;
  if (score >= 30) return 60 * 60 * 1000;
  if (score >= 15) return 10 * 60 * 1000;
  return 0;
}

function getIpState(ip) {
  let state = ipState.get(ip);
  if (!state) {
    state = { score: 0, bannedUntil: 0, lastDecay: Date.now(), requestCount: 0, windowStart: Date.now() };
    ipState.set(ip, state);
  }
  return state;
}

function decayScore(state) {
  const now = Date.now();
  const elapsed = now - state.lastDecay;
  if (elapsed >= DECAY_INTERVAL) {
    const decayAmount = Math.floor(elapsed / DECAY_INTERVAL) * DECAY_RATE;
    state.score = Math.max(0, state.score - decayAmount);
    state.lastDecay = now;
  }
}

function addScore(ip, points, reason) {
  const state = getIpState(ip);
  decayScore(state);
  state.score += points;

  const banMs = getBanDuration(state.score);
  if (banMs > 0) {
    state.bannedUntil = Date.now() + banMs;
    logAbuse(ip, 'BANNED', `score=${state.score} reason=${reason} duration=${banMs / 1000}s`);
  }
}

function isBanned(ip) {
  const state = ipState.get(ip);
  if (!state) return false;
  decayScore(state);
  if (state.bannedUntil > Date.now()) return true;
  return false;
}

function isRateLimited(ip) {
  const state = getIpState(ip);
  const now = Date.now();
  const WINDOW = 2 * 60 * 1000;
  const MAX = 10;

  if (now - state.windowStart > WINDOW) {
    state.requestCount = 1;
    state.windowStart = now;
    return false;
  }

  state.requestCount++;
  if (state.requestCount > MAX) {
    addScore(ip, SCORE_RATE_EXCEEDED, 'rate_exceeded');
    return true;
  }
  return false;
}

const VOWELS = new Set('aeiou');

function getDgaScore(domain) {
  const parts = domain.split('.');
  if (parts.length < 2) return 0;
  const labels = parts.slice(0, -1);
  const label = labels.reduce((a, b) => a.length >= b.length ? a : b, '');

  if (label.length < 4) return 0;

  let score = 0;

  const vowelCount = [...label].filter(c => VOWELS.has(c)).length;
  const vowelRatio = vowelCount / label.length;
  if (vowelRatio < 0.15) score += 4;
  else if (vowelRatio < 0.25) score += 2;

  const digitCount = [...label].filter(c => c >= '0' && c <= '9').length;
  const digitRatio = digitCount / label.length;
  if (digitRatio > 0.5) score += 3;
  else if (digitRatio > 0.3) score += 1;

  if (label.length > 30) score += 3;
  else if (label.length > 20) score += 1;

  let maxConsec = 0, consec = 0;
  for (const c of label) {
    if (!VOWELS.has(c) && c >= 'a' && c <= 'z') {
      consec++;
      maxConsec = Math.max(maxConsec, consec);
    } else {
      consec = 0;
    }
  }
  if (maxConsec >= 5) score += 3;
  else if (maxConsec >= 4) score += 1;

  const freq = {};
  for (const c of label) freq[c] = (freq[c] || 0) + 1;
  let entropy = 0;
  for (const count of Object.values(freq)) {
    const p = count / label.length;
    entropy -= p * Math.log2(p);
  }
  if (entropy > 4.5) score += 3;
  else if (entropy > 4.2) score += 1;

  return score;
}

function isDga(domain) {
  return getDgaScore(domain) >= 8;
}

const domainReputation = new Map();
const DOMAIN_REP_DECAY = 60_000;

function getDomainRep(domain) {
  let rep = domainReputation.get(domain);
  if (!rep) {
    rep = { score: 0, lastSeen: Date.now(), bannedIpCount: 0 };
    domainReputation.set(domain, rep);
  }
  const elapsed = Date.now() - rep.lastSeen;
  if (elapsed > DOMAIN_REP_DECAY) {
    const decayAmount = Math.floor(elapsed / DOMAIN_REP_DECAY) * 0.5;
    if (rep.score > 0) rep.score = Math.max(0, rep.score - decayAmount);
    if (rep.score < 0) rep.score = Math.min(0, rep.score + decayAmount);
  }
  rep.lastSeen = Date.now();
  return rep;
}

function penalizeDomain(domain, points) {
  const rep = getDomainRep(domain);
  rep.score -= points;
}

function rewardDomain(domain) {
  const rep = getDomainRep(domain);
  rep.score += 1;
}

function markDomainFromBannedIp(domain) {
  const rep = getDomainRep(domain);
  rep.bannedIpCount++;
  if (rep.bannedIpCount >= 3) {
    rep.score -= 5;
  }
}

function hasBadReputation(domain) {
  const rep = domainReputation.get(domain);
  if (!rep) return false;
  return rep.score <= -10;
}

let globalRequestCount = 0;
let globalWindowStart = Date.now();
let lockdownUntil = 0;
const GLOBAL_WINDOW = 60_000;
const GLOBAL_MAX = 100;
const LOCKDOWN_DURATION = 5 * 60_000;

function checkCircuitBreaker() {
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
    logAbuse('SYSTEM', 'LOCKDOWN', `global rate exceeded: ${globalRequestCount} req/min`);
    return true;
  }

  return false;
}

function isInLockdown() {
  return Date.now() < lockdownUntil;
}

const LOG_DIR = process.cwd();
const LOG_FILE = join(LOG_DIR, 'ban_log.jsonl');

async function logAbuse(ip, action, details) {
  const entry = JSON.stringify({
    t: new Date().toISOString(),
    ip,
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
  for (const [ip, state] of ipState) {
    decayScore(state);
    if (state.score === 0 && state.bannedUntil < now && (now - state.windowStart) > 2 * 60 * 60 * 1000) {
      ipState.delete(ip);
    }
  }
  for (const [d, rep] of domainReputation) {
    if ((now - rep.lastSeen) > 2 * 60 * 60 * 1000) {
      domainReputation.delete(d);
    }
  }
}, 5 * 60_000);

setInterval(cleanOldLogs, 24 * 60 * 60_000);

console.log(`tls server listening on ${PORT}!!!!`);

Bun.serve({
  port: PORT,
  fetch(req) {
    try {
      const url = new URL(req.url, 'http://localhost');
      const ip = req.headers.get('x-real-ip') || req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';

      if (isBanned(ip)) {
        return new Response('banned', { status: 403 });
      }

      const inLockdown = isInLockdown();
      if (!inLockdown && checkCircuitBreaker()) { }

      const domainFromQuery = url.searchParams.get('domain') || url.searchParams.get('server_name');
      const domainFromHeader = req.headers.get('Host') || '';
      const domain = (domainFromQuery || domainFromHeader.split(':')[0]).toLowerCase();

      if (!domain) {
        addScore(ip, SCORE_INVALID_FORMAT, 'missing_domain');
        return new Response('missing domain', { status: 400 });
      }

      if (isApproved(domain)) {
        return new Response('yes!!', { status: 200 });
      }

      if (isInLockdown()) {
        logAbuse(ip, 'LOCKDOWN_REJECT', domain);
        return new Response('service temporarily unavailable', { status: 503 });
      }

      if (isRateLimited(ip)) {
        logAbuse(ip, 'RATE_LIMITED', domain);
        return new Response('rate limited', { status: 429 });
      }

      if (!isValidDomain(domain)) {
        addScore(ip, SCORE_INVALID_FORMAT, `invalid_format:${domain}`);
        return new Response('invalid domain', { status: 400 });
      }

      if (BLOCKED_SUFFIXES.some(s => domain.endsWith(s))) {
        addScore(ip, SCORE_REJECTED_DOMAIN, `blocked_suffix:${domain}`);
        penalizeDomain(domain, 3);
        return new Response('no!!', { status: 410 });
      }

      if (hasBadReputation(domain)) {
        addScore(ip, SCORE_BAD_REPUTATION, `bad_rep:${domain}`);
        return new Response('no!!', { status: 410 });
      }

      const ipS = ipState.get(ip);
      if (ipS && ipS.score > 5) {
        markDomainFromBannedIp(domain);
      }

      const dgaThreshold = (ipS && ipS.score > 0) ? 6 : 8;
      const dgaScore = getDgaScore(domain);
      if (dgaScore >= dgaThreshold) {
        addScore(ip, SCORE_DGA_DETECTED, `dga:${domain} score=${dgaScore}`);
        penalizeDomain(domain, 5);
        logAbuse(ip, 'DGA_REJECT', `${domain} dgaScore=${dgaScore}`);
        return new Response('no!!', { status: 410 });
      }

      approveDomain(domain);
      rewardDomain(domain);
      return new Response('yes!!', { status: 200 });

    } catch (err) {
      console.error(`request error: ${err.message}`);
      return new Response('error', { status: 500 });
    }
  },
});
