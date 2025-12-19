const BLACKLISTED = ['.nip.io', '.sslip.io'];
const PORT = 3001;

console.log(`ASK server listening on port ${PORT}`);

Bun.serve({
  port: PORT,
  fetch(req) {
    const url = new URL(req.url, "http://localhost");
    const domain = (url.searchParams.get('domain') || '').toLowerCase();

    if (!domain) {
      return new Response('No', { status: 400 });
    }

    for (const pattern of BLACKLISTED) {
      if (domain.endsWith(pattern)) {
        console.log(`[DENY] ${domain}`);
        return new Response('No', { status: 403 });
      }
    }

    console.log(`[ALLOW] ${domain}`);
    return new Response('Yes', { status: 200 });
  },
});