import fs from "fs";
import path from "path";
import { createServer } from "http";
import express from "express";
import compression from "compression";
import helmet from "helmet";
import wisp from "wisp-server-node";
import { LRUCache } from "lru-cache";
import dotenv from "dotenv";
import { baremuxPath } from "@mercuryworkshop/bare-mux/node";
import { epoxyPath } from "@mercuryworkshop/epoxy-transport";
import { libcurlPath } from "@mercuryworkshop/libcurl-transport";
import { uvPath } from "@titaniumnetwork-dev/ultraviolet";
import rateLimit from "express-rate-limit";
import { bridgeHandler } from "./bridge.mjs";
import { WebSocketServer, WebSocket } from "ws";

process.env.UV_THREADPOOL_SIZE = 128;

dotenv.config();
const PORT = parseInt(process.env.PORT || "3000", 10);
const NODE_ENV = process.env.NODE_ENV || 'development';
const packageJsonPath = path.resolve("package.json");
const notificationsPath = path.resolve("notifications.json"); 

const apiLimiter = rateLimit({
    windowMs: 5 * 60 * 1000,
    max: 500,
    standardHeaders: true, 
    legacyHeaders: false,
    message: { error: "Too many requests, please try again later." }
});

let cachedNotifications = [];
let notificationError = null;

try {
  const data = fs.readFileSync(notificationsPath, "utf8");
  cachedNotifications = JSON.parse(data);
} catch (err) {
  notificationError = { error: "Unable to load notification :(" };
}

if (global.gc) {
    setInterval(() => {
        const used = process.memoryUsage().heapUsed / 1024 / 1024;
        if (used > 800) global.gc();
    }, 60000);
}

const __dirname = process.cwd();
const srcPath = path.join(__dirname, NODE_ENV === 'production' ? 'dist' : 'src');
const publicPath = path.join(__dirname, "public");

const app = express();
app.set("trust proxy", true);
const server = createServer(app);

const bridgeWss = new WebSocketServer({ 
    noServer: true,
    handleProtocols: (protocols) => {
        return protocols.size > 0 ? [...protocols][0] : null;
    }
});

const pageCache = new LRUCache({ max: 5000, ttl: 1000 * 60 * 15 });

app.use(helmet({
  contentSecurityPolicy: false, 
  crossOriginEmbedderPolicy: false,
  frameguard: false
}));

app.use('/api/', apiLimiter);

app.use(compression({
  filter: (req, res) => {
    if (req.headers['x-no-compression']) return false;
    if (req.path.includes('/!!/')) return false; 
    return compression.filter(req, res);
  },
  level: 6,
  threshold: '5kb'
}));

app.use((req, res, next) => {
  if (req.path.endsWith(".wasm")) res.setHeader("Content-Type", "application/wasm");
  next();
});

app.use((req, res, next) => {
  if (req.path.startsWith("/api/") || req.originalUrl.includes("/!!/")) return next();
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

const staticOpts = { maxAge: "7d", immutable: true, etag: false };
app.use("/bmux/", express.static(baremuxPath, staticOpts));
app.use("/epoxy/", express.static(epoxyPath, staticOpts));
app.use("/libcurl/", express.static(libcurlPath, staticOpts));
app.use("/u/", express.static(uvPath, staticOpts));
app.use("/s/", express.static(path.join(__dirname, "scramjet")));
app.use("/assets/data", express.static(path.join(publicPath, "assets", "data"), { maxAge: 0, immutable: false, etag: true }));
app.use("/assets", express.static(path.join(publicPath, "assets"), staticOpts));
app.use("/b", express.static(path.join(publicPath, "b")));
app.use(express.static(srcPath, staticOpts));

const bMap = {
  "1": path.join(baremuxPath, "index.js"),
  "2": path.join(publicPath, "b/s/jetty.all.js"),
  "3": path.join(publicPath, "b/u/bunbun.js"),
  "4": path.join(publicPath, "b/u/concon.js")
};

app.get("/b", (req, res) => {
  const id = req.query.id;
  bMap[id] ? res.sendFile(bMap[id]) : res.status(404).send("File not found");
});

app.get("/api/version", (_req, res) => {
  fs.readFile(packageJsonPath, "utf8", (err, data) => {
    if (err) return res.status(500).json({ error: "Version error" });
    try { res.json({ version: JSON.parse(data).version }); } catch { res.status(500).json({}); }
  });
});

app.get("/api/notifications", (_req, res) => {
  if (notificationError) return res.status(500).json(notificationError);
  res.json(cachedNotifications);
});

if (NODE_ENV === 'development') {
  console.log("Mounting Bridge on /!!/");
  app.use(/^\/!!\/(.*)/, bridgeHandler);
}

app.get("/", (_req, res) => {res.sendFile(path.join(srcPath, "index.html"));});
app.use((_req, res) => res.status(404).sendFile(path.join(srcPath, "404.html")));

server.on("upgrade", (req, sock, head) => {
  if (req.url.startsWith("/w/")) {
    sock.setNoDelay(true);
    wisp.routeRequest(req, sock, head);
  } else if (req.url.includes("/!!/ws/")) {
    bridgeWss.handleUpgrade(req, sock, head, (ws) => {
      const targetEncoded = req.url.split("/!!/ws/")[1];
      if (!targetEncoded) return ws.close();
      
      let targetUrl;
      try {
        targetUrl = decodeURIComponent(targetEncoded);
        if (!targetUrl.startsWith('wss://') && !targetUrl.startsWith('ws://')) {
            targetUrl = 'wss://' + targetUrl;
        }
      } catch(e) { return ws.close(); }

      let protocols = req.headers['sec-websocket-protocol'];
      const targetOrigin = new URL(targetUrl).origin;
      const targetHost = new URL(targetUrl).host;

      const wsOptions = {
          headers: { 
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
            'Origin': targetOrigin,
            'Host': targetHost
          },
          rejectUnauthorized: false
      };
      
      if (protocols) {
          if (Array.isArray(protocols)) {
              protocols = protocols.filter(p => p && p !== 'null' && p !== 'undefined');
              if (protocols.length > 0) wsOptions.protocol = protocols.join(',');
          } else if (typeof protocols === 'string' && protocols !== 'null' && protocols !== 'undefined') {
              wsOptions.protocol = protocols;
          }
      }

      const remote = new WebSocket(targetUrl, wsOptions);

      remote.on('error', (e) => {
          if (ws.readyState === WebSocket.OPEN) ws.close();
      });
      ws.on('error', (e) => {
          if (remote.readyState === WebSocket.OPEN) remote.close();
      });

      remote.on('open', () => {
          ws.on('message', (data, isBinary) => {
             if (remote.readyState === WebSocket.OPEN) remote.send(data, { binary: isBinary });
          });
          remote.on('message', (data, isBinary) => {
             if (ws.readyState === WebSocket.OPEN) ws.send(data, { binary: isBinary });
          });
      });

      remote.on('close', () => {
          if (ws.readyState === WebSocket.OPEN) ws.close();
      });
      ws.on('close', () => {
          if (remote.readyState === WebSocket.OPEN) remote.close();
      });
    });
  } else {
    sock.destroy();
  }
});

server.keepAliveTimeout = 60000;
server.headersTimeout = 61000;

server.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
