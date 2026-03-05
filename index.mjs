import dotenv from "dotenv";
dotenv.config();
import fs from "fs";
import path from "path";
import { createServer, request } from "http";
import express from "express";
import compression from "compression";
import helmet from "helmet";
import wisp from "wisp-server-node";
import { LRUCache } from "lru-cache";
import { baremuxPath } from "@mercuryworkshop/bare-mux/node";
import { epoxyPath } from "@mercuryworkshop/epoxy-transport";
import { libcurlPath } from "@mercuryworkshop/libcurl-transport";
import rateLimit from "express-rate-limit";

process.env.UV_THREADPOOL_SIZE = 32;
const PORT = parseInt(process.env.PORT || "3000", 10);
const NODE_ENV = process.env.NODE_ENV || 'development';
const packageJsonPath = path.resolve("package.json");
const notificationsPath = path.resolve("notifications.json");

const CACHING_ENABLED = NODE_ENV === 'production';
const fileCache = CACHING_ENABLED ? new LRUCache({
  maxSize: 800 * 1024 * 1024,
  sizeCalculation: (buf) => buf.length,
}) : null;

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.mp3': 'audio/mpeg',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.xml': 'application/xml',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json',
  '.wasm': 'application/wasm',
};

function cachedRead(absPath) {
  if (!CACHING_ENABLED) {
    try { return fs.readFileSync(absPath); } catch { return null; }
  }
  let buf = fileCache.get(absPath);
  if (buf) return buf;
  try {
    buf = fs.readFileSync(absPath);
    fileCache.set(absPath, buf);
    return buf;
  } catch {
    return null;
  }
}

function sendCached(res, absPath, cacheControl, extraHeaders) {
  const buf = cachedRead(absPath);
  if (!buf) return false;
  const ext = path.extname(absPath).toLowerCase();
  res.setHeader('Content-Type', MIME_TYPES[ext] || 'application/octet-stream');
  res.setHeader('Cache-Control', cacheControl);
  if (extraHeaders) for (const [k, v] of Object.entries(extraHeaders)) res.setHeader(k, v);
  res.setHeader('X-File-Cache', 'HIT');
  res.send(buf);
  return true;
}

function cachedStatic(root, cacheControl = 'public, max-age=31536000, immutable', opts = {}) {
  return (req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    const relative = decodeURIComponent(req.path).replace(/\\/g, '/');
    if (relative.includes('..')) return next();
    const absPath = path.join(root, relative);
    if (opts.noIndex && relative === '/') return next();
    if (sendCached(res, absPath, cacheControl)) return;
    if (!opts.noIndex) {
      const indexPath = path.join(absPath, 'index.html');
      if (sendCached(res, indexPath, cacheControl)) return;
    }
    next();
  };
}

const apiLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 2000,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "too many requests, please try again later!" }
});

let cachedNotifications = [];
let notificationError = null;
let location = "unknown";

fetch("https://get.geojs.io/v1/ip/geo.json")
  .then(res => res.json())
  .then(data => {
    if (data && data.country_code && data.region) {
      location = `${data.country_code}, ${data.region}`;
    }
  })
  .catch(err => console.error("failed to fetch location:", err.message));

try {
  const data = fs.readFileSync(notificationsPath, "utf8");
  cachedNotifications = JSON.parse(data);
} catch (err) {
  notificationError = { error: "unable to load notification :(" };
}

const __dirname = process.cwd();
const srcPath = path.join(__dirname, NODE_ENV === 'production' ? 'dist' : 'src');
const publicPath = path.join(__dirname, "public");
const app = express();
app.set("trust proxy", true);
const server = createServer(app);
const pageCache = new LRUCache({ max: 1000, ttl: 1000 * 60 * 5 });

import cookieParser from "cookie-parser";

app.use(cookieParser());
app.use(helmet({
  contentSecurityPolicy: false,
  crossOriginEmbedderPolicy: false,
  xPoweredBy: false,
  frameguard: false,
  hsts: false
}));

app.use((req, res, next) => {
  if (NODE_ENV === 'development' && req.url.startsWith('/!!/')) {
    const options = {
      hostname: '127.0.0.1',
      port: 4000,
      path: req.url,
      method: req.method,
      headers: req.headers,
    };

    const proxyReq = request(options, (proxyRes) => {
      res.writeHead(proxyRes.statusCode, proxyRes.headers);
      proxyRes.pipe(res);
    });

    proxyReq.on('error', (e) => {
      console.error(`mochi forwarding failed: ${e.message}`);
      if (!res.headersSent) res.status(502).send("make sure mochi is running!");
    });

    req.pipe(proxyReq);
  } else if (NODE_ENV === 'development' && (req.url.startsWith('/api/auth') || req.url.startsWith('/api/sync'))) {
    const options = {
      hostname: '127.0.0.1',
      port: 5000,
      path: req.url,
      method: req.method,
      headers: req.headers,
    };

    const proxyReq = request(options, (proxyRes) => {
      res.writeHead(proxyRes.statusCode, proxyRes.headers);
      proxyRes.pipe(res);
    });

    proxyReq.on('error', (e) => {
      console.error(`cloudsync forwarding failed: ${e.message}`);
      if (!res.headersSent) res.status(502).send("make sure cloudsync is running!");
    });

    req.pipe(proxyReq);
  } else {
    next();
  }
});

app.use('/api/', apiLimiter);
app.use(express.json({ limit: '50mb' }));

app.use(compression({
  filter: (req, res) => {
    if (req.headers['x-no-compression']) return false;
    return compression.filter(req, res);
  },
  level: 6,
  threshold: '1kb'
}));

app.use((req, res, next) => {
  if (!CACHING_ENABLED || req.method !== 'GET') return next();
  if (req.path.startsWith("/api/") || req.url.startsWith("/!!/") || req.path.startsWith("/b")) return next();
  const key = req.originalUrl;
  const val = pageCache.get(key);
  if (val) {
    if (val.headers) {
      for (const [k, v] of Object.entries(val.headers)) {
        if (v) res.setHeader(k, v);
      }
    }
    res.setHeader("X-Cache", "HIT");
    return res.send(val.body);
  }
  const originalSend = res.send;
  res.send = (body) => {
    if (res.statusCode === 200) {
      pageCache.set(key, {
        body,
        headers: {
          'Content-Type': res.getHeader('Content-Type'),
          'Content-Encoding': res.getHeader('Content-Encoding'),
          'Cache-Control': res.getHeader('Cache-Control'),
          'Vary': res.getHeader('Vary')
        }
      });
      res.setHeader("X-Cache", "MISS");
    }
    originalSend.call(res, body);
  };
  next();
});

if (NODE_ENV === 'production') {
  const COMPRESSIBLE = /\.(js|css|html|mjs|json|svg|xml)$/i;
  const ENCODING_MAP = [
    { ext: '.br', encoding: 'br' },
    { ext: '.gz', encoding: 'gzip' }
  ];

  app.use((req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') return next();
    if (!COMPRESSIBLE.test(req.path)) return next();
    if (req.path.startsWith('/api/') || req.url.startsWith('/!!/')) return next();

    const accept = req.headers['accept-encoding'] || '';
    for (const { ext, encoding } of ENCODING_MAP) {
      if (!accept.includes(encoding)) continue;

      const candidates = [
        path.join(srcPath, req.path + ext),
        path.join(publicPath, req.path + ext)
      ];

      for (const filePath of candidates) {
        const buf = cachedRead(filePath);
        if (buf) {
          const fileExt = path.extname(req.path).toLowerCase();
          res.setHeader('Content-Encoding', encoding);
          res.setHeader('Content-Type', MIME_TYPES[fileExt] || 'application/octet-stream');
          res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
          res.setHeader('Vary', 'Accept-Encoding');
          res.setHeader('X-File-Cache', 'HIT');
          return res.send(buf);
        }
      }
    }
    next();
  });
}

app.use((req, res, next) => {
  if (req.method !== 'GET') return next();
  const accept = req.headers['accept'] || '';
  if (accept.includes('text/html') || req.path === '/' || req.path.endsWith('.html')) {
    res.setHeader('Link', [
      '</assets/fonts/Lexend-Regular.woff2>; rel=preload; as=font; crossorigin',
    ].join(', '));
  }
  next();
});

const bMap = {
  "1": path.join(baremuxPath, "index.js"),
  "2": path.join(publicPath, "b/s/jetty.all.js"),
  "3": path.join(publicPath, "b/u/bunbun.js"),
  "4": path.join(publicPath, "b/u/concon.js")
};

const bCache = {};
for (const [id, filePath] of Object.entries(bMap)) {
  try { bCache[id] = fs.readFileSync(filePath); } catch { }
}

app.get("/b", (req, res) => {
  const buf = bCache[req.query.id];
  if (!buf) return res.status(404).send("file not found :(");
  res.setHeader("Content-Type", "application/javascript; charset=utf-8");
  res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
  res.send(buf);
});

const IMMUTABLE_CC = 'public, max-age=31536000, immutable';
const NO_CACHE_CC = 'public, max-age=0, must-revalidate';

if (CACHING_ENABLED) {
  app.use("/bmux/", cachedStatic(baremuxPath, IMMUTABLE_CC));
  app.use("/epoxy/", cachedStatic(epoxyPath, IMMUTABLE_CC));
  app.use("/libcurl/", cachedStatic(libcurlPath, IMMUTABLE_CC));
  app.use("/s/", cachedStatic(path.join(__dirname, "scramjet"), IMMUTABLE_CC));
  app.use("/assets/data", cachedStatic(path.join(publicPath, "assets", "data"), NO_CACHE_CC));
  app.use("/assets", cachedStatic(path.join(publicPath, "assets"), IMMUTABLE_CC));
  app.use("/b", cachedStatic(path.join(publicPath, "b"), IMMUTABLE_CC));
  app.use(cachedStatic(srcPath, IMMUTABLE_CC, { noIndex: true }));
} else {
  const staticOpts = { maxAge: 0, etag: true };
  app.use("/bmux/", express.static(baremuxPath, staticOpts));
  app.use("/epoxy/", express.static(epoxyPath, staticOpts));
  app.use("/libcurl/", express.static(libcurlPath, staticOpts));
  app.use("/s/", express.static(path.join(__dirname, "scramjet"), staticOpts));
  app.use("/assets/data", express.static(path.join(publicPath, "assets", "data"), staticOpts));
  app.use("/assets", express.static(path.join(publicPath, "assets"), staticOpts));
  app.use("/b", express.static(path.join(publicPath, "b"), staticOpts));
  app.use(express.static(srcPath, { ...staticOpts, index: false }));
}

app.get("/api/stuff", (_req, res) => {
  fs.readFile(packageJsonPath, "utf8", (err, data) => {
    if (err) return res.status(500).json({ error: "stuff error" });
    try {
      const parsedData = JSON.parse(data);
      res.json({ version: parsedData.version, location: location });
    } catch {
      res.status(500).json({});
    }
  });
});

app.get("/api/notifications", (_req, res) => {
  if (notificationError) return res.status(500).json(notificationError);
  res.json(cachedNotifications);
});

app.get("/", (_req, res) => {
  const fp = path.join(srcPath, "index.html");
  if (CACHING_ENABLED) {
    const buf = cachedRead(fp);
    if (buf) {
      res.status(418);
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('X-File-Cache', 'HIT');
      return res.send(buf);
    }
  }
  res.status(418).sendFile(fp);
});

app.use((_req, res) => {
  const fp = path.join(srcPath, "404.html");
  if (CACHING_ENABLED) {
    const buf = cachedRead(fp);
    if (buf) {
      res.status(404);
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('X-File-Cache', 'HIT');
      return res.send(buf);
    }
  }
  res.status(404).sendFile(fp);
});

server.on("upgrade", (req, sock, head) => {
  if (req.url.startsWith("/w/")) {
    sock.setNoDelay(true);
    wisp.routeRequest(req, sock, head);
  } else if (NODE_ENV === 'development' && req.url.startsWith("/!!/")) {
    const proxyReq = request({
      hostname: '127.0.0.1',
      port: 4000,
      path: req.url,
      method: 'GET',
      headers: req.headers
    });

    proxyReq.on('upgrade', (proxyRes, proxySock, proxyHead) => {
      if (head && head.length) proxySock.unshift(head);

      sock.write(
        `HTTP/${proxyRes.httpVersion} ${proxyRes.statusCode} ${proxyRes.statusMessage}\r\n` +
        Object.keys(proxyRes.headers).map(k => `${k}: ${proxyRes.headers[k]}`).join('\r\n') +
        '\r\n\r\n'
      );

      sock.pipe(proxySock).pipe(sock);
    });

    proxyReq.on('error', () => sock.destroy());
    proxyReq.end();
  } else {
    sock.destroy();
  }
});

server.keepAliveTimeout = 60000;
server.headersTimeout = 61000;
server.listen(PORT, () => {
  console.log(`server listening on ${PORT}!! ~ cache: ${CACHING_ENABLED ? 'yes' : 'no'}`);
});