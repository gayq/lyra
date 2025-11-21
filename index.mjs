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
import { Readable } from "stream";

dotenv.config();
const PORT = parseInt(process.env.PORT || "3000", 10);
const NODE_ENV = process.env.NODE_ENV || 'development';
const packageJsonPath = path.resolve("package.json");

process.on("uncaughtException", err => console.error(`Unhandled Exception: ${err.stack || err.message || err}`));
process.on("unhandledRejection", reason => console.error(`Unhandled Rejection: ${reason}`));

const __dirname = process.cwd();
const srcPath = path.join(__dirname, NODE_ENV === 'production' ? 'dist' : 'src');
const publicPath = path.join(__dirname, "public");

const app = express();
const server = createServer(app);

console.log(`Process ${process.pid} started in ${NODE_ENV} mode`);

const pageCache = new LRUCache({ max: 25000, ttl: 1000 * 60 * 60 });

app.use(helmet({
  contentSecurityPolicy: false, 
  crossOriginEmbedderPolicy: false,
  frameguard: false
}));

app.use(compression({
  level: 6,
  threshold: '1kb', 
  filter: (req, res) => {
    if (req.headers['x-no-compression']) {
      return false;
    }
    return compression.filter(req, res);
  }
}));

app.use((req, res, next) => {
  if (req.path.endsWith(".wasm")) res.setHeader("Content-Type", "application/wasm");
  next();
});

const MIME_TYPES = {
    '.html': 'text/html',
    '.css': 'text/css',
    '.js': 'application/javascript',
    '.json': 'application/json',
    '.wasm': 'application/wasm',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
    '.ttf': 'font/ttf',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2'
};

app.use(/^\/!!\/(.*)/, async (req, res) => {
    try {
        let targetUrl = req.params[0]; 
        
        if (!targetUrl) {
             const prefix = "/!!/";
             if (req.originalUrl.includes(prefix)) {
                 targetUrl = req.originalUrl.substring(req.originalUrl.indexOf(prefix) + prefix.length);
             }
        }

        if (!targetUrl || !targetUrl.startsWith("http")) {
             return res.status(400).send("Invalid URL");
        }

        const response = await fetch(targetUrl);
        
        if (!response.ok) {
            return res.status(response.status).send(response.statusText);
        }

        const urlObj = new URL(targetUrl);
        const ext = path.extname(urlObj.pathname).toLowerCase();
        let contentType = MIME_TYPES[ext];

        if (!contentType) {
            contentType = response.headers.get("content-type");
        }

        if (contentType) {
            res.setHeader("Content-Type", contentType);
        }

        if (ext !== '.html' && ext !== '.json') {
            res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
        } else {
            res.setHeader("Cache-Control", "public, max-age=3600");
        }

        if (response.body) {
           Readable.fromWeb(response.body).pipe(res);
        } else {
           res.end();
        }

    } catch (err) {
        if (err.code !== 'ECONNRESET' && err.code !== 'EPIPE') {
             console.error("Error:", err.message);
        }
        if (!res.headersSent) {
            res.status(500).send("Uh oh!! We got an error while fetching the game :( Check the console for more info");
        }
    }
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
  "2": path.join(publicPath, "b/s/scramjet.all.js"),
  "3": path.join(publicPath, "b/u/bunbun.js"),
  "4": path.join(publicPath, "b/u/concon.js")
};

app.get("/b", (req, res) => {
  const id = req.query.id;
  bMap[id] ? res.sendFile(bMap[id]) : res.status(404).send("File not found ૮◞ ‸ ◟ ა");
});

app.get("/api/version", (_req, res) => {
  fs.readFile(packageJsonPath, "utf8", (err, data) => {
    if (err) return res.status(500).json({ error: "Unable to check version." });
    try {
      res.json({ version: JSON.parse(data).version });
    } catch {
      res.status(500).json({ error: "Invalid package.json file." });
    }
  });
});

app.get("/", (_req, res) => {res.sendFile(path.join(srcPath, "index.html"));});
app.get("/s", (_req, res) => {res.sendFile(path.join(srcPath, "settings.html"));});
app.use((_req, res) => res.status(404).sendFile(path.join(srcPath, "404.html")));

server.keepAliveTimeout = 5000;
server.headersTimeout = 10000;

if (NODE_ENV === 'development') {
  server.on("upgrade", (req, sock, head) => {
    if (req.url.startsWith("/w/")) {
      sock.setNoDelay(true);
      sock.setKeepAlive(true, 30000); 
      wisp.routeRequest(req, sock, head);
    } else {
      sock.destroy();
    }
  });
} else {
}

server.on("error", err => console.error(`Server error: ${err}`));
server.listen(PORT, () => {
  console.log(`Listening on port ${PORT} (˶ᵔ ᵕ ᵔ˶)`);
});