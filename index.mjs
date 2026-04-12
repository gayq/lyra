import dotenv from "dotenv";
dotenv.config();
import fs from "fs";
import path from "path";
import { createHash } from "crypto";
import { createServer, request } from "http";
import { spawn } from "child_process";
import net from "net";
import express from "express";
import compression from "compression";
import helmet from "helmet";
import { LRUCache } from "lru-cache";
import { baremuxPath } from "@mercuryworkshop/bare-mux/node";
import { epoxyPath } from "@mercuryworkshop/epoxy-transport";
import { libcurlPath } from "@mercuryworkshop/libcurl-transport";
import rateLimit from "express-rate-limit";
import cookieParser from "cookie-parser";

const PORT = parseInt(process.env.PORT || "3000", 10);
const NODE_ENV = process.env.NODE_ENV || "development";
const packageJsonPath = path.resolve("package.json");

const CACHING_ENABLED = NODE_ENV === "production";
const fileCache = CACHING_ENABLED
  ? new LRUCache({
      maxSize: 400 * 1024 * 1024,
      sizeCalculation: (buf) => buf.length,
    })
  : null;

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".mp3": "audio/mpeg",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".xml": "application/xml",
  ".txt": "text/plain; charset=utf-8",
  ".map": "application/json",
  ".wasm": "application/wasm",
};

function cachedRead(absPath) {
  if (!CACHING_ENABLED) {
    try {
      return fs.readFileSync(absPath);
    } catch {
      return null;
    }
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
  res.setHeader("Content-Type", MIME_TYPES[ext] || "application/octet-stream");
  res.setHeader("Cache-Control", cacheControl);
  if (extraHeaders)
    for (const [k, v] of Object.entries(extraHeaders)) res.setHeader(k, v);
  res.setHeader("X-File-Cache", "HIT");
  res.send(buf);
  return true;
}

function cachedStatic(
  root,
  cacheControl = "public, max-age=31536000, immutable",
  opts = {},
) {
  return (req, res, next) => {
    if (req.method !== "GET" && req.method !== "HEAD") return next();
    let relative;
    try {
      relative = decodeURIComponent(req.path).replace(/\\/g, "/");
    } catch {
      return next();
    }
    if (relative.includes("..")) return next();
    const absPath = path.join(root, relative);
    if (opts.noIndex && relative === "/") return next();
    if (sendCached(res, absPath, cacheControl)) return;
    if (!opts.noIndex) {
      const indexPath = path.join(absPath, "index.html");
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
  message: { error: "too many requests, please try again later!" },
});

let location = "unknown";
let packageData = null;

try {
  packageData = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
} catch {}

const geoCtrl = AbortController ? new AbortController() : null;
const geoTimeout = geoCtrl ? setTimeout(() => geoCtrl.abort(), 5000) : null;
fetch("https://get.geojs.io/v1/ip/geo.json", geoCtrl ? { signal: geoCtrl.signal } : {})
  .then((res) => res.json())
  .then((data) => {
    if (data && data.country_code && data.region) {
      location = `${data.country_code}, ${data.region}`;
    }
  })
  .catch(() => {})
  .finally(() => { if (geoTimeout) clearTimeout(geoTimeout); });

const __dirname = process.cwd();
const srcPath = path.join(
  __dirname,
  NODE_ENV === "production" ? "dist" : "src",
);
const publicPath = path.join(__dirname, "public");
const buildFingerprint = (() => {
  const fallback = packageData?.version || "unknown";
  if (!CACHING_ENABLED) return fallback;
  try {
    const indexHtml = fs.readFileSync(path.join(srcPath, "index.html"));
    return createHash("sha1").update(indexHtml).digest("hex").slice(0, 12);
  } catch {
    return fallback;
  }
})();

const app = express();
app.set("trust proxy", 1);
const server = createServer(app);
const pageCache = new LRUCache({ max: 1000, ttl: 1000 * 60 * 5 });

app.use((req, res, next) => {
  if (NODE_ENV !== "development") return next();

  let targetPort = 0;
  let label = "";

  if (req.url.startsWith("/w/")) {
    targetPort = 8080;
    label = "nuru";
  } else if (req.url.startsWith("/!!/") || req.url.startsWith("/!cover!/")) {
    targetPort = 4000;
    label = "mochi";
  } else if (
    req.url.startsWith("/api/auth") ||
    req.url.startsWith("/api/sync")
  ) {
    targetPort = 5000;
    label = "cloudsync";
  }

  if (!targetPort) return next();

  const options = {
    hostname: "127.0.0.1",
    port: targetPort,
    path: req.url,
    method: req.method,
    headers: req.headers,
  };

  const proxyReq = request(options, (proxyRes) => {
    proxyRes.on("error", () => res.destroy());
    res.on("error", () => proxyRes.destroy());
    res.writeHead(proxyRes.statusCode, proxyRes.headers);
    proxyRes.pipe(res);
  });

  proxyReq.on("error", (e) => {
    console.error(`${label} forwarding failed: ${e.message}`);
    if (!res.headersSent)
      res.status(502).json({ error: `make sure ${label} is running!` });
    else res.destroy();
  });

  req.on("error", () => proxyReq.destroy());
  req.pipe(proxyReq);
});

const bMap = {
  1: path.join(baremuxPath, "index.js"),
  2: path.join(publicPath, "b/s/jetty.all.js"),
  3: path.join(publicPath, "b/u/bunbun.js"),
  4: path.join(publicPath, "b/u/concon.js"),
};

const bCache = {};
for (const [id, filePath] of Object.entries(bMap)) {
  try {
    bCache[id] = fs.readFileSync(filePath);
  } catch {}
}

app.get("/b", (req, res) => {
  const buf = bCache[req.query.id];
  if (!buf) return res.status(404).send("file not found :(");
  res.setHeader("Content-Type", "application/javascript; charset=utf-8");
  res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
  res.send(buf);
});

let vite = null;
if (NODE_ENV === "development") {
  const { createServer: createViteServer } = await import("vite");
  vite = await createViteServer({
    server: { middlewareMode: true },
    appType: "custom",
  });
  app.use(vite.middlewares);
}

const IMMUTABLE_CC = "public, max-age=31536000, immutable";
const NO_CACHE_CC = "public, max-age=0, must-revalidate";

app.use(
  compression({
    filter: (req, res) => {
      if (req.headers["x-no-compression"]) return false;
      return compression.filter(req, res);
    },
    level: 6,
    threshold: "1kb",
  }),
);

if (CACHING_ENABLED) {
  app.use("/bmux/", cachedStatic(baremuxPath, IMMUTABLE_CC));
  app.use("/epoxy/", cachedStatic(epoxyPath, IMMUTABLE_CC));
  app.use("/libcurl/", cachedStatic(libcurlPath, IMMUTABLE_CC));
  app.use("/s/", cachedStatic(path.join(__dirname, "scramjet"), IMMUTABLE_CC));
  app.use(
    "/assets/data",
    cachedStatic(path.join(publicPath, "assets", "data"), NO_CACHE_CC),
  );
  app.use(
    "/assets",
    cachedStatic(path.join(publicPath, "assets"), IMMUTABLE_CC),
  );
  app.use("/b", cachedStatic(path.join(publicPath, "b"), IMMUTABLE_CC));
  app.use(cachedStatic(srcPath, IMMUTABLE_CC, { noIndex: true }));
} else {
  const staticOpts = { maxAge: 0, etag: true };
  app.use("/bmux/", express.static(baremuxPath, staticOpts));
  app.use("/epoxy/", express.static(epoxyPath, staticOpts));
  app.use("/libcurl/", express.static(libcurlPath, staticOpts));
  app.use("/s/", express.static(path.join(__dirname, "scramjet"), staticOpts));
  app.use(
    "/assets/data",
    express.static(path.join(publicPath, "assets", "data"), staticOpts),
  );
  app.use(
    "/assets",
    express.static(path.join(publicPath, "assets"), staticOpts),
  );
  app.use("/b", express.static(path.join(publicPath, "b"), staticOpts));
  app.use(express.static(srcPath, { ...staticOpts, index: false }));
}
app.use("/api/", cookieParser());
app.use(
  helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false,
    xPoweredBy: false,
    frameguard: false,
    hsts: false,
  }),
);

app.use("/api/", apiLimiter);
app.use("/api/", express.json({ limit: "2mb" }));

app.use((req, res, next) => {
  if (!CACHING_ENABLED || req.method !== "GET") return next();
  if (
    req.path === "/" ||
    req.path.endsWith(".html") ||
    req.path.startsWith("/api/") ||
    req.url.startsWith("/!!/") ||
    req.url.startsWith("/!cover!/") ||
    req.path.startsWith("/b") ||
    req.path.startsWith("/bmux/") ||
    req.path.startsWith("/epoxy/") ||
    req.path.startsWith("/libcurl/") ||
    req.path.startsWith("/s/") ||
    req.path.startsWith("/assets/")
  )
    return next();
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
          "Content-Type": res.getHeader("Content-Type"),
          "Content-Encoding": res.getHeader("Content-Encoding"),
          "Cache-Control": res.getHeader("Cache-Control"),
          Vary: res.getHeader("Vary"),
        },
      });
      res.setHeader("X-Cache", "MISS");
    }
    originalSend.call(res, body);
  };
  next();
});

if (NODE_ENV === "production") {
  const COMPRESSIBLE = /\.(js|css|html|mjs|json|svg|xml)$/i;
  const ENCODING_MAP = [
    { ext: ".br", encoding: "br" },
    { ext: ".gz", encoding: "gzip" },
  ];

  app.use((req, res, next) => {
    if (req.method !== "GET" && req.method !== "HEAD") return next();
    if (!COMPRESSIBLE.test(req.path)) return next();
    if (
      req.path.startsWith("/api/") ||
      req.url.startsWith("/!!/") ||
      req.url.startsWith("/!cover!/")
    )
      return next();

    let decodedPath;
    try {
      decodedPath = decodeURIComponent(req.path).replace(/\\/g, "/");
    } catch {
      return next();
    }
    if (decodedPath.includes("..")) return next();

    const accept = req.headers["accept-encoding"] || "";
    for (const { ext, encoding } of ENCODING_MAP) {
      if (!accept.includes(encoding)) continue;

      const candidates = [
        path.join(srcPath, decodedPath + ext),
        path.join(publicPath, decodedPath + ext),
      ];

      for (const filePath of candidates) {
        const buf = cachedRead(filePath);
        if (buf) {
          const fileExt = path.extname(req.path).toLowerCase();
          res.setHeader("Content-Encoding", encoding);
          res.setHeader(
            "Content-Type",
            MIME_TYPES[fileExt] || "application/octet-stream",
          );
          res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
          res.setHeader("Vary", "Accept-Encoding");
          res.setHeader("X-File-Cache", "HIT");
          return res.send(buf);
        }
      }
    }
    next();
  });
}

app.get("/api/stuff", (_req, res) => {
  if (!packageData) return res.status(500).json({ error: "stuff error" });
  res.setHeader("Cache-Control", "no-store, max-age=0");
  res.json({
    version: packageData.version,
    build: buildFingerprint,
    location,
  });
});

const EARLY_HINTS_LINKS = [
  "</assets/fonts/Lexend-Regular.woff2>; rel=preload; as=font; crossorigin",
  "</assets/scripts/entry.jsx>; rel=modulepreload",
  "</b?id=1>; rel=preload; as=script",
  "</b?id=2>; rel=preload; as=script",
  "<https://fonts.googleapis.com>; rel=preconnect",
  "<https://fonts.gstatic.com>; rel=preconnect; crossorigin",
];
const LINK_HEADER = EARLY_HINTS_LINKS.join(", ");

app.get("/", async (req, res) => {
  const fp = path.join(srcPath, "index.html");
  if (typeof res.writeEarlyHints === "function") {
    res.writeEarlyHints({ link: EARLY_HINTS_LINKS });
  }
  res.setHeader("Link", LINK_HEADER);
  res.setHeader("Cache-Control", "no-store, max-age=0");
  if (vite) {
    try {
      let html = fs.readFileSync(fp, "utf-8");
      html = await vite.transformIndexHtml(req.originalUrl || "/", html);
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      return res.status(200).end(html);
    } catch (err) {
      console.error("vite transform error:", err.message);
      return res.sendFile(fp);
    }
  }
  if (CACHING_ENABLED) {
    const buf = cachedRead(fp);
    if (buf) {
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.setHeader("X-File-Cache", "HIT");
      return res.send(buf);
    }
  }
  res.sendFile(fp);
});

app.use((_req, res) => {
  const fp = path.join(srcPath, "404.html");
  if (CACHING_ENABLED) {
    const buf = cachedRead(fp);
    if (buf) {
      res.status(404);
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.setHeader("X-File-Cache", "HIT");
      return res.send(buf);
    }
  }
  res.status(404).sendFile(fp);
});

function proxyWebSocketUpgrade(req, sock, head, targetPort, label) {
  const upstream = new net.Socket();

  function cleanup() {
    upstream.destroy();
    sock.destroy();
  }

  upstream.on("error", (err) => {
    console.error(`${label} ws upstream error: ${err.message}`);
    if (sock.writable) {
      sock.write(
        "HTTP/1.1 502 Bad Gateway\r\nContent-Type: text/plain\r\nContent-Length: " +
          Buffer.byteLength(`${label} not reachable`) +
          `\r\n\r\n${label} not reachable`,
      );
    }
    cleanup();
  });

  sock.on("error", () => upstream.destroy());
  upstream.on("close", () => sock.destroy());
  sock.on("close", () => upstream.destroy());

  upstream.connect(targetPort, "127.0.0.1", () => {
    try {
      upstream.setNoDelay(true);
      sock.setNoDelay(true);
    } catch {}

    const rh = req.rawHeaders;
    let raw = `${req.method} ${req.url} HTTP/${req.httpVersion}\r\n`;
    for (let i = 0; i < rh.length; i += 2) {
      raw += `${rh[i]}: ${rh[i + 1]}\r\n`;
    }
    raw += "\r\n";
    upstream.write(raw);

    if (head && head.length) upstream.write(head);

    upstream.pipe(sock);
    sock.pipe(upstream);
  });
}

server.on("upgrade", (req, sock, head) => {
  sock.on("error", () => {});

  if (NODE_ENV === "development" && req.url.startsWith("/w/")) {
    proxyWebSocketUpgrade(req, sock, head, 8080, "nuru");
  } else if (
    NODE_ENV === "development" &&
    (req.url.startsWith("/!!/") || req.url.startsWith("/!cover!/"))
  ) {
    proxyWebSocketUpgrade(req, sock, head, 4000, "mochi");
  } else {
    sock.destroy();
  }
});

server.keepAliveTimeout = 60000;
server.headersTimeout = 61000;

const DEV_SERVICES = [
  {
    name: "nuru",
    dir: "nuru",
    port: 8080,
    args: ["--", "config.toml", "--format", "toml"],
  },
  { name: "mochi", dir: "mochi", port: 4000 },
  { name: "cloudsync", dir: "cloudsync", port: 5000 },
];

const serviceStatus = {};
const serviceProcs = [];
let statusLineCount = 0;

function colorize(status) {
  if (status === "good") return "\x1b[32mgood\x1b[0m";
  if (status === "starting...") return "\x1b[33mstarting...\x1b[0m";
  if (status === "compiling...") return "\x1b[33mcompiling...\x1b[0m";
  return `\x1b[31m${status}\x1b[0m`;
}

function printStatus() {
  if (statusLineCount > 0) {
    process.stdout.write(`\x1b[${statusLineCount}A\x1b[0J`);
  }
  const lines = [];
  lines.push("");
  lines.push("services:");
  for (const svc of DEV_SERVICES) {
    lines.push(
      ` ${svc.name.padEnd(12)} - ${colorize(serviceStatus[svc.name])}`,
    );
  }
  lines.push("");
  process.stdout.write(lines.join("\n"));
  statusLineCount = lines.length - 1;
}

function checkPort(port) {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    sock.setTimeout(400);
    sock.once("connect", () => {
      sock.destroy();
      resolve(true);
    });
    sock.once("error", () => {
      sock.destroy();
      resolve(false);
    });
    sock.once("timeout", () => {
      sock.destroy();
      resolve(false);
    });
    sock.connect(port, "127.0.0.1");
  });
}

async function pollService(svc) {
  while (
    serviceStatus[svc.name] === "starting..." ||
    serviceStatus[svc.name] === "compiling..."
  ) {
    const up = await checkPort(svc.port);
    if (up) {
      serviceStatus[svc.name] = "good";
      printStatus();
      return;
    }
    await new Promise((r) => setTimeout(r, 750));
  }
}

function spawnServices() {
  for (const svc of DEV_SERVICES) {
    serviceStatus[svc.name] = "starting...";
  }
  printStatus();

  for (const svc of DEV_SERVICES) {
    const isWin = process.platform === "win32";
    const cargoArgs = ["run", ...(svc.args || [])];
    const child = spawn("cargo", cargoArgs, {
      cwd: path.join(__dirname, svc.dir),
      stdio: ["ignore", "pipe", "pipe"],
      shell: isWin,
    });

    serviceProcs.push(child);

    child.stdout.on("data", (data) => {
      const text = data.toString();
      if (
        serviceStatus[svc.name] !== "good" &&
        (text.toLowerCase().includes("listening") ||
          text.toLowerCase().includes("started"))
      ) {
        serviceStatus[svc.name] = "good";
        printStatus();
      }
    });

    child.stderr.on("data", (data) => {
      const text = data.toString();
      if (
        serviceStatus[svc.name] === "starting..." &&
        text.includes("Compiling")
      ) {
        serviceStatus[svc.name] = "compiling...";
        printStatus();
      }
    });

    child.on("error", (err) => {
      serviceStatus[svc.name] = `error: ${err.message}`;
      printStatus();
    });

    child.on("exit", (code) => {
      if (serviceStatus[svc.name] === "good") {
        serviceStatus[svc.name] = `stopped (${code})`;
      } else {
        serviceStatus[svc.name] = `exited (${code})`;
      }
      printStatus();
    });

    pollService(svc);
  }
}

function killServices() {
  for (const child of serviceProcs) {
    try {
      if (process.platform === "win32") {
        spawn("taskkill", ["/pid", String(child.pid), "/f", "/t"], {
          stdio: "ignore",
        });
      } else {
        child.kill("SIGTERM");
      }
    } catch {}
  }
}

process.on("SIGINT", () => {
  killServices();
  process.exit(0);
});
process.on("SIGTERM", () => {
  killServices();
  process.exit(0);
});
process.on("exit", killServices);

server.listen(PORT, () => {
  console.log(
    `server listening on ${PORT}!! ~ cache: ${CACHING_ENABLED ? "yes" : "no"}`,
  );

  if (NODE_ENV === "development") {
    spawnServices();
  }
});
