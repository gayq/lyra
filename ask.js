const BLACKLISTED_PATTERNS = ['.nip.io', '.sslip.io'];
const PORT = 3001;

console.log(`Starting on port ${PORT}`);

Bun.serve({
  port: PORT,
  fetch(req) {
    const url = new URL(req.url);
    
    const domainFromQuery = url.searchParams.get('server_name');
    const domainFromHeader = req.headers.get('Host') || '';
    
    const domain = domainFromQuery || domainFromHeader.split(':')[0].toLowerCase();
    
    if (!domain) {
        return new Response('Missing domain parameter.', { status: 400 });
    }

    let isBlacklisted = false;
    for (const pattern of BLACKLISTED_PATTERNS) {
      if (domain.endsWith(pattern)) {
        isBlacklisted = true;
        break;
      }
    }

    if (isBlacklisted) {
      return new Response('No', { status: 403 });
    }

    return new Response('Yes', { status: 200 });
  },
});