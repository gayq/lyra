const PORT = 3001;
const YES = new Response('yes!!', { status: 200 });
const NO = new Response('no!!', { status: 410 });
const MISSING = new Response('missing domain', { status: 400 });
const INVALID = new Response('invalid domain', { status: 400 });
const BANNED = new Response('domain temporarily banned', { status: 429 });
const LIMITED = new Response('domain rate limited', { status: 429 });
const UNAVAIL = new Response('temporarily unavailable :(', { status: 503 });
const approved = new Map();
const A_TTL = 86_400_000;
const denied = new Map();
const D_TTL = 3_600_000;

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

const dstate = new Map();
const DW = 300_000;
const DMAX = 10;
const DBAN = 1_800_000;

let gcount = 0;
let gstart = Date.now();
let glock = 0;
const GW = 60_000;
const GMAX = 200;
const GLOCK = 300_000;

function blockedSuffix(s) {
  for (let i = s.indexOf('.'); i !== -1; i = s.indexOf('.', i + 1)) {
    if (blocked.has(s.slice(i))) return true;
  }
  return false;
}

function validDomain(s) {
  const len = s.length;
  if (len === 0 || len > 253) return false;

  const f = s.charCodeAt(0);
  const l = s.charCodeAt(len - 1);
  if (f === 46 || f === 45 || l === 46 || l === 45) return false;

  let hasDot = false;
  let pd = false;
  let dcount = 0;
  let slen = 0;
  let ip = true;

  for (let i = 0; i < len; i++) {
    const c = s.charCodeAt(i);
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
        if (i === len - 1 || i > 0 && s.charCodeAt(i - 1) === 46) return false;
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
  let i = url.indexOf('domain=');
  if (i !== -1) {
    i += 7;
    const e = url.indexOf('&', i);
    const raw = e === -1 ? url.slice(i) : url.slice(i, e);
    return ~raw.indexOf('%') ? decodeURIComponent(raw).toLowerCase() : raw.toLowerCase();
  }
  i = url.indexOf('server_name=');
  if (i !== -1) {
    i += 12;
    const e = url.indexOf('&', i);
    const raw = e === -1 ? url.slice(i) : url.slice(i, e);
    return ~raw.indexOf('%') ? decodeURIComponent(raw).toLowerCase() : raw.toLowerCase();
  }
  return '';
}

console.log(`tls server listening on ${PORT}!!`);

Bun.serve({
  port: PORT,
  fetch(req) {
    const now = Date.now();
    const domain = extractDomain(req.url);
    if (!domain) return MISSING;

    const ae = approved.get(domain);
    if (ae) {
      if (now < ae) return YES;
      approved.delete(domain);
    }

    const de = denied.get(domain);
    if (de) {
      if (now < de) return NO;
      denied.delete(domain);
    }

    if (!validDomain(domain)) {
      denied.set(domain, now + D_TTL);
      return INVALID;
    }

    if (blockedSuffix(domain)) {
      denied.set(domain, now + D_TTL);
      return NO;
    }

    if (now < glock) return UNAVAIL;
    if (now - gstart > GW) { gcount = 1; gstart = now; }
    else if (++gcount > GMAX) { glock = now + GLOCK; console.log(`[abuse] GLOBAL_LOCKDOWN: ${gcount} req/min`); return UNAVAIL; }

    const st = dstate.get(domain);
    if (st) {
      if (st.banned > now) return BANNED;
      if (now - st.window > DW) { st.count = 1; st.window = now; }
      else if (++st.count > DMAX) { st.banned = now + DBAN; console.log(`[abuse] DOMAIN_BANNED: ${domain} ${st.count} req`); return LIMITED; }
    } else {
      dstate.set(domain, { count: 1, window: now, banned: 0 });
    }

    approved.set(domain, now + A_TTL);
    return YES;
  },
});