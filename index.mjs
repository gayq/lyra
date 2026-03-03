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
  if (req.path.startsWith("/api/") || req.url.startsWith("/!!/") || req.path.startsWith("/b")) return next();
  const key = req.originalUrl;
  const val = pageCache.get(key);
  if (val) {
    res.setHeader("X-Cache", "HIT");
    return res.send(val);
  }
  const originalSend = res.send;
  res.send = (body) => {
    if (res.statusCode === 200) {
      pageCache.set(key, body);
      res.setHeader("X-Cache", "MISS");
    }
    originalSend.call(res, body);
  };
  next();
});

const staticOpts = { maxAge: "365d", immutable: true, etag: false };
const hashedOpts = { maxAge: "365d", immutable: true, etag: false };

if (NODE_ENV === 'production') {
  const COMPRESSIBLE = /\.(js|css|html|mjs|json|svg|xml)$/i;
  const ENCODING_MAP = [
    { ext: '.br', encoding: 'br' },
    { ext: '.gz', encoding: 'gzip' }
  ];
  const CONTENT_TYPES = {
    '.js': 'application/javascript; charset=utf-8',
    '.mjs': 'application/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.html': 'text/html; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.xml': 'application/xml'
  };

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
        if (fs.existsSync(filePath)) {
          const fileExt = path.extname(req.path);
          res.setHeader('Content-Encoding', encoding);
          res.setHeader('Content-Type', CONTENT_TYPES[fileExt] || 'application/octet-stream');
          res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
          res.setHeader('Vary', 'Accept-Encoding');
          return res.sendFile(filePath);
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

app.use("/bmux/", express.static(baremuxPath, staticOpts));
app.use("/epoxy/", express.static(epoxyPath, hashedOpts));
app.use("/libcurl/", express.static(libcurlPath, hashedOpts));
app.use("/s/", express.static(path.join(__dirname, "scramjet"), staticOpts));
app.use("/assets/data", express.static(path.join(publicPath, "assets", "data"), { maxAge: 0, immutable: false, etag: true }));
app.use("/assets", express.static(path.join(publicPath, "assets"), staticOpts));
app.use("/b", express.static(path.join(publicPath, "b"), staticOpts));
app.use(express.static(srcPath, { ...staticOpts, index: false }));

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
  res.status(418).sendFile(path.join(srcPath, "index.html"));
});

app.use((_req, res) => {
  res.status(404).sendFile(path.join(srcPath, "404.html"));
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
  console.log(`server listening on ${PORT}!!`);
});