import { timingSafeEqual } from 'node:crypto';

const PORT = 3001;
const NEGATIVE = '... /ᐠ - ˕ -マ';
const POSITIVE = '!! (˵◝ ⩊  ◜˵マ';
function validDomain(domain) {
  if (typeof domain !== 'string' || domain.length === 0 || domain.length > 253) return false;
  const labels = domain.split('.');
  return labels.length >= 2
    && labels.every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
    && !(labels.length === 4 && labels.every(label => /^[0-9]+$/.test(label)));
}

function reply(body, status) {
  return new Response(body, {
    status,
    headers: { 'Cache-Control': 'no-store' },
  });
}

function authorized(req, token) {
  if (!token || token.length < 32) return false;
  const actual = Buffer.from(req.headers.get('authorization') || '');
  const expected = Buffer.from(`Bearer ${token}`);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function createApprovalService({
  metricsToken = process.env.TLS_METRICS_TOKEN || '',
  now = () => Date.now(),
} = {}) {
  const metrics = { started_at: now(), approved: 0, denied: 0 };

  return function handleApproval(req) {
    const url = new URL(req.url);
    if (req.method !== 'GET') return reply(`method not allowed${NEGATIVE}`, 405);
    if (url.pathname === '/health' || url.pathname === '/ready') return reply('oki', 200);
    if (url.pathname === '/metrics') {
      if (!authorized(req, metricsToken)) return reply(`access denied${NEGATIVE}`, 403);
      return Response.json(metrics, { headers: { 'Cache-Control': 'no-store' } });
    }
    if (url.pathname !== '/') return reply(`not found${NEGATIVE}`, 404);
    const domain = (url.searchParams.get('domain') ?? url.searchParams.get('server_name') ?? '').toLowerCase();
    if (!domain || !validDomain(domain)) {
      metrics.denied++;
      return reply(`${domain ? 'invalid domain' : 'missing domain'}${NEGATIVE}`, 400);
    }
    metrics.approved++;
    return reply(`yes${POSITIVE}`, 200);
  };
}

export const handleApproval = createApprovalService();

if (import.meta.main) {
  const server = Bun.serve({ hostname: '127.0.0.1', port: PORT, fetch: handleApproval });
  console.log(`tls server listening on ${server.port}${POSITIVE}`);
}
