const PATTERNS = [
  '.nip.io', 
  '.sslip.io', 
  '.securly.cloud',
  '.traefik.me',
  '.myaddr.io',
  '.backname.io',
  '.tiktokv.us'
];

const PORT = 3001;

console.log(`starting on port ${PORT}`);

Bun.serve({
  port: PORT,
  fetch(req) {
    try {
      const url = new URL(req.url, 'http://localhost');
      
      const domainFromQuery = url.searchParams.get('domain') || url.searchParams.get('server_name');
      const domainFromHeader = req.headers.get('Host') || '';
      
      const domain = (domainFromQuery || domainFromHeader.split(':')[0]).toLowerCase();
      
      if (!domain) {
        return new Response('missing domain parameter!', { status: 400 });
      }

      const isBlacklisted = PATTERNS.some(pattern => domain.endsWith(pattern));

      if (isBlacklisted) {
        console.log(`rejected: ${domain}`);
        return new Response('no!!', { status: 403 });
      }

      console.log(`allowed: ${domain}`);
      return new Response('yes!!', { status: 200 });

    } catch (err) {
      console.error(`request error: ${err.message}`);
      return new Response('error processing request', { status: 500 });
    }
  },
});