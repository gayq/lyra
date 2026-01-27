import { Readable } from "stream";
import { Agent, ProxyAgent, setGlobalDispatcher } from "undici";
import { HTMLRewriter } from 'html-rewriter-wasm';
import dns from 'dns';

const HTML_REWRITING = true;
const isDevMode = process.env.NODE_ENV === 'development';
const BRIDGE_PREFIX = "/!!/";

const logBridge = (...args) => {
    if (isDevMode) console.log("[bridge]", ...args);
};

const agentOptions = {
    keepAliveTimeout: 120000,
    connections: 16384, 
    pipelining: 16,     
    allowH2: false,
    connect: { 
        rejectUnauthorized: false, 
        timeout: 15000,
        keepAlive: true,
        noDelay: true   
    },
    headersTimeout: 60000,
    bodyTimeout: 3600000
};

let dispatcher;
if (process.env.HTTP_PROXY) {
    dispatcher = new ProxyAgent({
        uri: process.env.HTTP_PROXY,
        ...agentOptions
    });
} else {
    dispatcher = new Agent(agentOptions);
}
setGlobalDispatcher(dispatcher);

const DNS_CACHE = new Map();
const DNS_CACHE_TTL_MS = 10 * 60 * 1000;
const DNS_SWEEP_INTERVAL_MS = 60 * 1000;
const originalLookup = dns.lookup;

const sweepDnsCache = () => {
    if (!DNS_CACHE.size) return;
    const cutoff = Date.now() - DNS_CACHE_TTL_MS;
    for (const [host, entry] of DNS_CACHE) {
        if (entry.timestamp < cutoff) DNS_CACHE.delete(host);
    }
};

dns.lookup = (hostname, options, callback) => {
    if (typeof options === 'function') { callback = options; options = {}; }
    const cached = DNS_CACHE.get(hostname);
    if (cached) {
        if (Date.now() - cached.timestamp < DNS_CACHE_TTL_MS) {
            return callback(null, cached.address, cached.family);
        }
        DNS_CACHE.delete(hostname);
    }
    originalLookup(hostname, options, (err, address, family) => {
        if (!err) {
            DNS_CACHE.set(hostname, { address, family, timestamp: Date.now() });
        }
        callback(err, address, family);
    });
};
setInterval(sweepDnsCache, DNS_SWEEP_INTERVAL_MS).unref();

const ORDER = [
    'host', 'connection', 'sec-ch-ua', 'sec-ch-ua-mobile', 'sec-ch-ua-platform',
    'upgrade-insecure-requests', 'user-agent', 'accept', 'sec-fetch-site',
    'sec-fetch-mode', 'sec-fetch-user', 'sec-fetch-dest', 'accept-encoding',
    'accept-language', 'range', 'cookie', 'if-none-match', 'save-data'
];

const sortHeaders = (headers) => {
    const sorted = {};
    const lowerKeys = {};
    for (const key in headers) lowerKeys[key.toLowerCase()] = headers[key];

    for (const key of ORDER) {
        if (lowerKeys[key]) {
            sorted[key] = lowerKeys[key];
            delete lowerKeys[key];
        }
    }
    for (const key in lowerKeys) sorted[key] = lowerKeys[key];
    return sorted;
};

let NOW = Date.now();
setInterval(() => { NOW = Date.now(); }, 500).unref(); 

const CACHE = new Map();
const MAX_CACHE_SIZE_BYTES = 1024 * 1024 * 1024;
let currentCacheSize = 0;
const CACHE_LIFETIME_MS = 15 * 60 * 1000; 
const CACHE_SWEEP_INTERVAL_MS = 30 * 1000; 

const URL_MEMO = new Map();
const MAX_MEMO_SIZE = 50000;

const blockedUrlPatterns = [
    /google-analytics\.com/i,
    /googletagmanager\.com/i,
    /googleAnalytics\.js/i,
    /ima3\.js/i,
    /doubleclick\.net/i,
    /pagead2/i,
    /adsbygoogle/i,
    /cpmstar\.com/i
];

const getCacheLimitForType = (ext, contentType) => {
    if (ext === '.assets' || ext === '.data' || ext === '.wasm' || ext === '.unityweb' || 
        ext === '.pck' || ext === '.zip' || ext === '.rar' || ext === '.gz' || ext === '.br' || 
        ext === '.unity3d' || ext === '.bundle' || ext === '.resource' || ext === '.resS' || 
        ext === '.blob' || ext === '.bin') {
        return 512 * 1024 * 1024;
    }
    if (contentType.startsWith('image/') || contentType.startsWith('video/') || contentType.startsWith('audio/')) {
        return 5 * 1024 * 1024;
    }
    return 16 * 1024 * 1024;
};

const evictExpiredCacheEntries = () => {
    if (!CACHE.size) return;
    const cutoff = NOW - CACHE_LIFETIME_MS;
    let reclaimed = 0;
    for (const [key, value] of CACHE) {
        if (value.timestamp < cutoff) {
            reclaimed += value.buffer?.byteLength || 0;
            CACHE.delete(key);
        }
    }
    if (reclaimed) {
        currentCacheSize -= reclaimed;
        if (currentCacheSize < 0) currentCacheSize = 0;
    }
};
setInterval(evictExpiredCacheEntries, CACHE_SWEEP_INTERVAL_MS).unref();

const ensureCacheCapacity = (neededBytes = 0) => {
    if (neededBytes > MAX_CACHE_SIZE_BYTES) return false;
    evictExpiredCacheEntries();
    while (CACHE.size && currentCacheSize + neededBytes > MAX_CACHE_SIZE_BYTES) {
        const oldest = CACHE.entries().next().value;
        if (!oldest) break;
        const [oldKey, oldValue] = oldest;
        currentCacheSize -= oldValue.buffer?.byteLength || 0;
        if (currentCacheSize < 0) currentCacheSize = 0;
        CACHE.delete(oldKey);
    }
    return currentCacheSize + neededBytes <= MAX_CACHE_SIZE_BYTES;
};

const H_PREFIX = `<script>
(function() {
    var hud;
    function initHud() {
        if (hud) return;
        try {
            hud = document.createElement('div');
            hud.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:300px;background:rgba(0,0,0,0.85);color:#0f0;font-family:monospace;font-size:11px;overflow-y:scroll;z-index:2147483647;pointer-events:none;padding:5px;word-break:break-all;pointer-events:auto;display:none;';
            (document.body || document.documentElement).appendChild(hud);
        } catch(e) {}
    }
    window.addEventListener('load', initHud);
    window.addEventListener('DOMContentLoaded', initHud);

    window.addEventListener('keydown', function(e) {
        if (e.code === 'Semicolon' && e.ctrlKey) {
            e.preventDefault();
            e.stopImmediatePropagation();
            if (hud) {
                hud.style.display = (hud.style.display === 'none') ? 'block' : 'none';
            } else {
                initHud();
                if(hud) hud.style.display = 'block';
            }
        }
    }, true);

    function log(type, args) {
        if (!hud) initHud();
        if (hud) {
            var el = document.createElement('div');
            el.textContent = '[' + type + '] ' + Array.from(args).map(String).join(' ');
            el.style.borderBottom = '1px solid #333';
            if (type === 'ERR') el.style.color = '#ff5555';
            if (type === 'WARN') el.style.color = '#ffff55';
            hud.insertBefore(el, hud.firstChild);
        }
    }
    var _log=console.log, _err=console.error, _warn=console.warn;
    console.log = function() { log('LOG', arguments); _log.apply(console, arguments); };
    console.error = function() { log('ERR', arguments); _err.apply(console, arguments); };
    console.warn = function() { log('WARN', arguments); _warn.apply(console, arguments); };

    window.addEventListener('error', function(e) { log('ERR', [e.message, e.filename, e.lineno]); });
    window.addEventListener('unhandledrejection', function(e) { log('ERR', ['Promise:', e.reason]); });

    try {
        const _U = window.URL;
        window.URL = function(u, b) {
            if ((!u || u === "") && !b) return new _U(window.location.href);
            return new _U(u, b);
        };
        window.URL.prototype = _U.prototype;
        window.URL.createObjectURL = function(o) { return _U.createObjectURL(o); };
        window.URL.revokeObjectURL = function(u) { return _U.revokeObjectURL(u); };
        for (let k in _U) { if (!(k in window.URL)) window.URL[k] = _U[k]; }
        
        const _p = history.pushState;
        const _r = history.replaceState;
        history.pushState = function(s, t, u) { try { _p.call(this, s, t, u); } catch(e) {} };
        history.replaceState = function(s, t, u) { try { _r.call(this, s, t, u); } catch(e) {} };
    } catch(e) {}

    window.__BRIDGE_PREFIX__="${BRIDGE_PREFIX}`;

const H_MID = `";window.__BRIDGE_TARGET__="`;

const H_SUFFIX = `";
    window.__BRIDGE_BASE__ = window.__BRIDGE_BASE__ || ((window.location.origin || "") + window.__BRIDGE_PREFIX__);
    
    try {
        const baseEl = document.querySelector('base[href]');
        if (baseEl && baseEl.href) {
             window.__BRIDGE_TARGET__ = baseEl.href;
        }
    } catch(e) {}

    const rewrite = (url) => {
        if (!url || typeof url !== "string") return url;
        if (url.startsWith("data:") || url.startsWith("blob:") || url.startsWith(window.__BRIDGE_PREFIX__)) return url;
        if (url.startsWith(window.location.origin + window.__BRIDGE_PREFIX__)) return url;
        if (url.startsWith("http")) return window.__BRIDGE_PREFIX__ + url;
        
        let base = window.__BRIDGE_TARGET__;
        try {
            const baseEl = document.querySelector('base[href]');
            if (baseEl && baseEl.href) base = baseEl.href;
        } catch(e) {}

        try {
            const resolved = new URL(url, base).href;
            return window.__BRIDGE_PREFIX__ + resolved;
        } catch (e) {
            return url;
        }
    };

    const originalFetch = window.fetch;
    window.fetch = function(input, init) {
        if (typeof input === "string") input = rewrite(input);
        else if (input instanceof Request) input = new Request(rewrite(input.url), input);
        return originalFetch(input, init)
    };
    
    const originalOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function(method, url, ...args) {
        return originalOpen.call(this, method, rewrite(url), ...args)
    };
    
    const originalWS = window.WebSocket;
    window.WebSocket = function(url, protocols) {
        if (!url) return new originalWS(url, protocols);
        let target = url;
        if (!target.startsWith("ws")) {
            try {
                target = new URL(url, window.__BRIDGE_TARGET__).href
            } catch (e) {}
            target = target.replace("http", "ws")
        }
        const proxyUrl = (window.location.protocol === "https:" ? "wss://" : "ws://") + window.location.host + window.__BRIDGE_PREFIX__ + "ws/" + encodeURIComponent(target);
        const ws = new originalWS(proxyUrl, protocols);
        ws.binaryType = "arraybuffer";
        return ws
    };
    
    const originalWorker = window.Worker;
    window.Worker = function(scriptURL, options) {
        return new originalWorker(rewrite(scriptURL), options)
    };
    
    const downloadExts = [".zip", ".rar", ".7z", ".tar", ".gz", ".tgz", ".bz2", ".xz", ".exe", ".msi", ".apk", ".dmg", ".deb", ".rpm", ".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx", ".iso", ".img", ".bin", ".msix", ".pkg", ".mp3", ".mp4", ".wav", ".flac", ".mkv", ".mov"];
    document.addEventListener("click", function(e) {
        if (e.defaultPrevented) return;
        const a = e.target.closest("a");
        if (!a) return;
        const href = a.getAttribute("data-bridge-orig-href") || a.getAttribute("href");
        if (!href) return;
        if (href.startsWith("javascript:") || href.startsWith("#")) return;
        const lower = href.toLowerCase();
        const hasDownload = a.hasAttribute("download") || downloadExts.some(ext => lower.endsWith(ext));
        const bridged = rewrite(href);
        if (!hasDownload) return;
        e.preventDefault();
        if (a.target === "_blank" || e.ctrlKey || e.metaKey || a.hasAttribute("download")) {
            window.open(bridged, "_blank");
        } else {
            window.location.assign(bridged);
        }
    });

    if (navigator.serviceWorker && navigator.serviceWorker.controller) {
        try {
            navigator.serviceWorker.controller.postMessage({
                type: "bridge-base",
                base: window.__BRIDGE_BASE__
            });
        } catch (e) {}
    }

    window.dataLayer = [];
    window.gtag = function() {};
    window.ga = function() {};
    window.google = window.google || {};
    window.google.ima = window.google.ima || {
        AdsLoader: function() { return { addEventListener: function(){}, contentComplete: function(){}, requestAds: function(){} }; },
        AdDisplayContainer: function() { return { initialize: function(){} }; },
        AdsManagerLoadedEvent: { Type: { ADS_MANAGER_LOADED: 'adsManagerLoaded' } },
        AdErrorEvent: { Type: { AD_ERROR: 'adError' } },
        ViewMode: { NORMAL: 'normal' }
    };
})()
</script>`;

const CSS_URL_REGEX = /url\(\s*(['"]?)(.*?)\1\s*\)/gi;

const cssRewrite = (cssText, resolutionBase, bridgePrefix) => {
    if (cssText.indexOf('url(') === -1) return cssText;
    return cssText.replace(CSS_URL_REGEX, (match, quote, urlPath) => {
        urlPath = urlPath.trim().replace(/^['"]|['"]$/g, '');
        if (urlPath.charCodeAt(0) === 104 && urlPath.startsWith('http')) {
            return `url(${quote}${bridgePrefix}${urlPath}${quote})`;
        }
        try {
            return `url(${quote}${bridgePrefix}${new URL(urlPath, resolutionBase).href}${quote})`;
        } catch(e) { return match; }
    });
};

const GAME_MIME_TYPES = {
    '.wasm': 'application/wasm',
    '.data': 'application/octet-stream',
    '.mem': 'application/octet-stream',
    '.symbols': 'application/octet-stream',
    '.pck': 'application/octet-stream',
    '.unityweb': 'application/octet-stream',
    '.js': 'application/javascript',
    '.json': 'application/json',
    '.unity3d': 'application/octet-stream',
    '.bundle': 'application/octet-stream',
    '.resource': 'application/octet-stream',
    '.resS': 'application/octet-stream',
    '.blob': 'application/octet-stream',
    '.bin': 'application/octet-stream'
};

const MIME_TYPES = {
    '.html': 'text/html', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg',
    '.webp': 'image/webp', '.svg': 'image/svg+xml', '.woff2': 'font/woff2',
    ...GAME_MIME_TYPES
};

const BLACKLIST_REQ_HEADERS = new Set([
    'host', 'connection', 'content-length', 'transfer-encoding', 'accept-encoding', 
    'upgrade', 'sec-websocket-key', 'sec-websocket-version', 'sec-websocket-extensions', 
    'origin', 'sec-fetch-dest', 'sec-fetch-mode', 'sec-fetch-site', 'cookie',
    'sec-ch-ua', 'sec-ch-ua-mobile', 'sec-ch-ua-platform', 'user-agent', 'pragma', 'cache-control'
]); 

const BLACKLIST_RES_HEADERS = new Set(['connection', 'content-encoding', 'content-length', 'transfer-encoding', 'content-security-policy', 'strict-transport-security', 'x-frame-options', 'access-control-allow-origin', 'access-control-allow-methods', 'access-control-allow-headers', 'access-control-expose-headers']);

const ensureResponseCompat = (res) => {
    if (typeof res.status !== 'function') {
        res.status = (code) => {
            res.statusCode = code;
            return res;
        };
    }
    if (typeof res.send !== 'function') {
        res.send = (body) => {
            if (res.headersSent) return res;
            if (body === undefined) { res.end(); return res; }
            if (Buffer.isBuffer(body) || body instanceof Uint8Array || typeof body === 'string') { res.end(body); return res; }
            if (body && typeof body === 'object') {
                if (!res.headersSent) res.setHeader('Content-Type', 'application/json; charset=utf-8');
                res.end(JSON.stringify(body));
                return res;
            }
            res.end(String(body));
            return res;
        };
    }
    if (typeof res.json !== 'function') {
        res.json = (payload) => {
            if (!res.headersSent) res.setHeader('Content-Type', 'application/json; charset=utf-8');
            return res.send(payload);
        };
    }
    if (typeof res.appendHeader !== 'function') {
        res.appendHeader = (name, value) => {
            const existing = res.getHeader(name);
            if (existing === undefined) { res.setHeader(name, value); return res; }
            const values = Array.isArray(existing) ? [...existing, value] : [existing, value];
            res.setHeader(name, values);
            return res;
        };
    }
};

export async function bridgeHandler(req, res) {
    ensureResponseCompat(res);
    
    if (req.method === 'OPTIONS') {
        res.setHeader("Access-Control-Allow-Origin", "*");
        res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, PATCH, OPTIONS");
        res.setHeader("Access-Control-Allow-Headers", "*");
        return res.status(204).end();
    }

    try {
        const prefix = BRIDGE_PREFIX;
        const fullRequestUrl = req.originalUrl || req.url;
        const prefixIndex = fullRequestUrl.indexOf(prefix);
            
        if (prefixIndex === -1) return res.status(400).json({ error: "No URL prefix found" });

        let targetUrl = fullRequestUrl.substring(prefixIndex + prefix.length);
        while (targetUrl.startsWith(prefix)) targetUrl = targetUrl.substring(prefix.length);
        
        if (blockedUrlPatterns.some(pattern => pattern.test(targetUrl))) {
            res.setHeader("Content-Type", "application/javascript");
            res.setHeader("Access-Control-Allow-Origin", "*");
            return res.status(200).send("/* Blocked by Bridge */");
        }

        if (targetUrl.startsWith('ws/')) return res.status(400).send("WebSocket connections must use a WebSocket endpoint");
        if (!targetUrl.startsWith('http')) targetUrl = 'https://' + targetUrl;

        if (req.method === 'GET') {
            const cached = CACHE.get(targetUrl);
            if (cached) {
                if (NOW - cached.timestamp < CACHE_LIFETIME_MS) { 
                    CACHE.delete(targetUrl);
                    CACHE.set(targetUrl, cached);
                    res.setHeader("X-Cache", "HIT");
                    res.setHeader("Access-Control-Allow-Origin", "*");
                    res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
                    res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
                    const keys = Object.keys(cached.headers);
                    for (let i = 0; i < keys.length; i++) res.setHeader(keys[i], cached.headers[keys[i]]);
                    return res.status(200).send(cached.buffer);
                } else {
                    currentCacheSize -= cached.buffer?.byteLength || 0;
                    if (currentCacheSize < 0) currentCacheSize = 0;
                    CACHE.delete(targetUrl);
                }
            }
        }

        let targetObj;
        try { targetObj = new URL(targetUrl); } catch(e) { return res.status(400).send("Invalid URL"); }

        let requestHeaders = {};
        const reqHeaderKeys = Object.keys(req.headers);
        for(let i = 0; i < reqHeaderKeys.length; i++) {
            const key = reqHeaderKeys[i];
            const keyLower = key.toLowerCase();
            if (!BLACKLIST_REQ_HEADERS.has(keyLower) && !keyLower.startsWith('cf-') && !keyLower.startsWith('x-')) {
                requestHeaders[keyLower] = req.headers[key];
            }
        }
            
        requestHeaders['user-agent'] = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
        requestHeaders['accept'] = 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7';
        requestHeaders['upgrade-insecure-requests'] = '1';
        requestHeaders['save-data'] = 'on';
            
        if (req.headers['range']) requestHeaders['range'] = req.headers['range'];
        if (req.method !== 'GET' && req.method !== 'HEAD') requestHeaders['origin'] = targetObj.origin;
        
        let upstreamReferer = targetObj.origin + '/';
        const incomingReferer = req.headers['referer'];
        if (incomingReferer && incomingReferer.includes(prefix)) {
            const temp = incomingReferer.substring(incomingReferer.indexOf(prefix) + prefix.length);
            if (temp.startsWith('http')) {
                upstreamReferer = temp;
            }
        }
        requestHeaders['referer'] = upstreamReferer;

        if (req.method === 'POST' && !requestHeaders['content-type']) requestHeaders['content-type'] = 'application/json';

        requestHeaders = sortHeaders(requestHeaders);

        const fetchOptions = {
            method: req.method,
            headers: requestHeaders,
            redirect: 'follow', 
            priority: 'high',
            dispatcher: dispatcher
        };

        if (req.method !== 'GET' && req.method !== 'HEAD') {
            fetchOptions.body = req;
            fetchOptions.duplex = 'half';
        }

        let response;
        let retries = 1;
        
        while(retries >= 0) {
            try {
                response = await fetch(targetUrl, fetchOptions);
                if (response.status === 429 && retries > 0) {
                    await new Promise(r => setTimeout(r, 200 + Math.random() * 500));
                    retries--;
                    continue;
                }
                break;
            } catch(e) {
                if (retries > 0) {
                    await new Promise(r => setTimeout(r, 100));
                    retries--;
                } else {
                    break;
                }
            }
        }

        if (!response) return res.status(502).end();

        res.statusCode = response.status;
        res.statusMessage = response.statusText;
        res.setHeader("Access-Control-Allow-Origin", "*");
        res.setHeader("X-Cache", "MISS");
        res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
        res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
        res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");

        const responseHeaders = Object.create(null);
        response.headers.forEach((value, key) => {
            const keyLower = key.toLowerCase();
            if (BLACKLIST_RES_HEADERS.has(keyLower)) return;
            if (keyLower === 'set-cookie') {
                const safeCookie = value.replace(/Domain=[^;]+;?/gi, '').replace(/Secure;?/gi, '').replace(/SameSite=[^;]+;?/gi, 'SameSite=Lax');
                res.appendHeader('Set-Cookie', safeCookie);
                responseHeaders['Set-Cookie'] = safeCookie;
            } else {
                res.setHeader(key, value);
                responseHeaders[key] = value;
            }
        });

        const pathname = targetObj.pathname;
        const lastDot = pathname.lastIndexOf('.');
        const ext = lastDot !== -1 ? pathname.substring(lastDot).toLowerCase() : '';
        const isBinaryGameFile = ext === '.wasm' || ext === '.pck' || ext === '.data' || ext === '.unityweb' || ext === '.mem' || ext === '.json' || ext === '.js' || ext === '.symbols' || ext === '.unity3d' || ext === '.bundle' || ext === '.resource' || ext === '.resS' || ext === '.blob' || ext === '.bin';

        if (isBinaryGameFile && response.status === 200) {
            const cacheHeader = "public, max-age=600, stale-while-revalidate=604800";
            res.setHeader("Cache-Control", cacheHeader);
            responseHeaders['Cache-Control'] = cacheHeader;
        }

        let contentType = response.headers.get("content-type");
        if (response.status >= 200 && response.status < 300) {
            contentType = GAME_MIME_TYPES[ext] || MIME_TYPES[ext] || contentType || "application/octet-stream";
        } else {
            contentType = contentType || "text/html";
        }

        const clientWantsHtml = req.headers['sec-fetch-dest'] === 'document' || (req.headers['accept'] && req.headers['accept'].indexOf('text/html') !== -1);
        if (clientWantsHtml && (ext === '.html' || ext === '.htm' || ext === '.php' || ext === '')) {
            contentType = 'text/html';
        }

        const semiIndex = contentType.indexOf(';');
        if (semiIndex !== -1) contentType = contentType.substring(0, semiIndex);
        res.setHeader("Content-Type", contentType);

        const shouldRewrite = HTML_REWRITING && contentType === 'text/html' && response.status === 200 && !isBinaryGameFile;
        
        if (shouldRewrite) {
            let resolutionBase = response.url || targetUrl;
            let detectedGameBase = null;
            let cacheBuffer = [];
            let totalCacheSize = 0;
            let canCache = true;
            const maxForThis = getCacheLimitForType(ext, contentType);

            const rewriter = new HTMLRewriter((chunk) => {
                if (res.writableEnded) return;
                res.cork();
                res.write(chunk);
                res.uncork();

                if (canCache) {
                    totalCacheSize += chunk.length;
                    if (totalCacheSize > maxForThis) {
                        canCache = false;
                        cacheBuffer = null; 
                    } else {
                        cacheBuffer.push(chunk); 
                    }
                }
            });

            const processUrl = (url) => {
                if (!url) return null;
                const cacheKey = url.length < 256 ? url + '|' + resolutionBase : null;
                if (cacheKey) {
                    const hit = URL_MEMO.get(cacheKey);
                    if (hit) return hit;
                }
                let result = url;
                const firstChar = url.charCodeAt(0);
                if (url.startsWith('data:') || url.startsWith('#') || url.startsWith(prefix) || url.startsWith('blob:')) {
                    result = url;
                } else {
                    try {
                        if (firstChar === 104 && url.startsWith('http')) {
                            result = prefix + url;
                        } else {
                            result = prefix + new URL(url, resolutionBase).href;
                        }
                    } catch (e) { result = url; }
                }
                if (cacheKey) {
                    if (URL_MEMO.size > MAX_MEMO_SIZE) URL_MEMO.clear();
                    URL_MEMO.set(cacheKey, result);
                }
                return result;
            };

            const urlHandler = {
                element(el) {
                    if (el.getAttribute('integrity')) el.removeAttribute('integrity');
                    if (el.getAttribute('crossorigin')) el.removeAttribute('crossorigin');
                        
                    const tagName = el.tagName;
                        
                    if (tagName === 'script') {
                        const src = el.getAttribute('src');
                        if (src) {
                            if (src.includes('loader.js') || src.includes('UnityLoader.js')) {
                                const fullUrl = processUrl(src);
                                el.setAttribute('src', fullUrl);
                                try {
                                    const urlObj = new URL(src, resolutionBase);
                                    const pathParts = urlObj.href.split('/');
                                    pathParts.pop(); 
                                    detectedGameBase = prefix + pathParts.join('/') + '/';
                                } catch(e) {}
                                return;
                            }
                            const n = processUrl(src); 
                            if(n) el.setAttribute('src', n); 
                        }
                    }
                    if (tagName === 'img' || tagName === 'iframe') {
                        const src = el.getAttribute('src');
                        if (src) { const n = processUrl(src); if(n) el.setAttribute('src', n); }
                    }
                    if (tagName === 'link' || tagName === 'a') {
                        const href = el.getAttribute('href');
                        if (href) { 
                            if (!el.getAttribute('data-bridge-orig-href')) el.setAttribute('data-bridge-orig-href', href);
                            const n = processUrl(href); 
                            if(n) el.setAttribute('href', n); 
                        }
                    }
                    if (tagName === 'form') {
                        const action = el.getAttribute('action');
                        if (action) { const n = processUrl(action); if(n) el.setAttribute('action', n); }
                    }
                    const srcset = el.getAttribute('srcset');
                    if (srcset) {
                        const newSrcset = srcset.split(',').map(srcPart => {
                            const parts = srcPart.trim().split(/\s+/);
                            if(parts[0]) parts[0] = processUrl(parts[0]);
                            return parts.join(' ');
                        }).join(', ');
                        el.setAttribute('srcset', newSrcset);
                    }
                    const style = el.getAttribute('style');
                    if (style) {
                        const newStyle = cssRewrite(style, resolutionBase, prefix);
                        if (newStyle !== style) el.setAttribute('style', newStyle);
                    }
                }
            };

            const scriptTextHandler = {
                text(textChunk) {
                    let text = textChunk.text;
                    let changed = false;

                    if (!detectedGameBase) {
                        const loaderMatch = text.match(/["']([^"']+\.(?:loader\.js|UnityLoader\.js|json))["']/);
                        if (loaderMatch) {
                            try {
                                const urlObj = new URL(loaderMatch[1], resolutionBase);
                                const pathParts = urlObj.href.split('/');
                                pathParts.pop(); 
                                detectedGameBase = prefix + pathParts.join('/') + '/';
                            } catch(e) {}
                        }
                    }

                    const unityAssets = /\b(Build\/[\w\-\.]+\.(?:data|wasm|js|json|unityweb|bin|mem))/g;
                    if (unityAssets.test(text)) {
                        text = text.replace(unityAssets, (match) => {
                            if (detectedGameBase) {
                                return detectedGameBase + match.replace('Build/', '');
                            }
                            return match;
                        });
                        changed = true;
                    }

                    if (text.includes('EJS_pathtodata') || text.includes('EJS_gameUrl')) {
                         text = text.replace(/(EJS_pathtodata|EJS_gameUrl)\s*=\s*(['"])(.*?)\2/g, (match, varName, quote, path) => {
                            const rewritten = processUrl(path);
                            return `${varName} = ${quote}${rewritten || path}${quote}`;
                        });
                        changed = true;
                    }

                    if (changed) {
                        textChunk.replace(text, { html: true });
                    }
                }
            };

            let headFound = false;
            rewriter.on('head', {
                element(el) {
                    headFound = true;
                    el.prepend(H_SUFFIX, { html: true });
                    el.prepend(resolutionBase, { html: true });
                    el.prepend(H_MID, { html: true });
                    el.prepend(H_PREFIX, { html: true });
                }
            });

            rewriter.on('base', {
                element(el) {
                    const href = el.getAttribute('href');
                    if (href) {
                        try {
                            resolutionBase = new URL(href, response.url).href;
                            URL_MEMO.clear(); 
                            el.setAttribute('href', `${prefix}${resolutionBase}`);
                        } catch(e) {}
                    }
                }
            });

            rewriter.on('script[src*="googletagmanager.com"]', { element(el) { el.remove(); } });
            rewriter.on('script[src*="google-analytics.com"]', { element(el) { el.remove(); } });
            rewriter.on('img,script,iframe,link,a,form,*[style]', urlHandler);
            rewriter.on('script', scriptTextHandler);

            rewriter.on('style', {
                text(text) {
                    if (!text.lastInTextNode) return; 
                    const rewritten = cssRewrite(text.text, resolutionBase, prefix);
                    if (rewritten !== text.text) text.replace(rewritten, { html: true });
                }
            });

            try {
                for await (const chunk of Readable.fromWeb(response.body, { highWaterMark: 64 * 1024 })) {
                    rewriter.write(chunk);
                }
                rewriter.end();

                if (!headFound) {
                    res.write(H_PREFIX);
                    res.write(H_MID);
                    res.write(resolutionBase);
                    res.write(H_SUFFIX);
                }

                res.end();

                if (canCache && cacheBuffer && cacheBuffer.length > 0 && response.status === 200) {
                    setImmediate(() => {
                        const finalBuffer = Buffer.concat(cacheBuffer);
                        const existing = CACHE.get(targetUrl);
                        if (existing) {
                            currentCacheSize -= existing.buffer?.byteLength || 0;
                            if (currentCacheSize < 0) currentCacheSize = 0;
                            CACHE.delete(targetUrl);
                        }
                        if (!ensureCacheCapacity(finalBuffer.byteLength)) return;

                        responseHeaders['content-type'] = contentType;
                        CACHE.set(targetUrl, {
                            buffer: finalBuffer,
                            headers: responseHeaders, 
                            timestamp: NOW
                        });
                        currentCacheSize += finalBuffer.byteLength;
                        logBridge("cache SAVED", targetUrl, finalBuffer.byteLength, "current cache bytes", currentCacheSize);
                    });
                }

            } catch (e) {
                if (!res.writableEnded) res.end();
            } finally {
                rewriter.free();
            }

        } else {
            let cacheBuffer = [];
            let totalCacheSize = 0;
            let canCache = true;
            const maxForThis = getCacheLimitForType(ext, contentType);

            if (response.body) {
                const stream = Readable.fromWeb(response.body, { highWaterMark: 64 * 1024 });
                stream.on('data', (chunk) => {
                    res.write(chunk);
                    if (canCache) {
                        totalCacheSize += chunk.length;
                        if (totalCacheSize > maxForThis) {
                            canCache = false;
                            cacheBuffer = null;
                        } else {
                            cacheBuffer.push(chunk);
                        }
                    }
                });
                stream.on('end', () => {
                    res.end();
                    if (canCache && cacheBuffer && cacheBuffer.length > 0 && response.status === 200) {
                        setImmediate(() => {
                            const finalBuffer = Buffer.concat(cacheBuffer);
                            if (!ensureCacheCapacity(finalBuffer.byteLength)) return;
                            
                            responseHeaders['content-type'] = contentType;
                            CACHE.set(targetUrl, {
                                buffer: finalBuffer,
                                headers: responseHeaders, 
                                timestamp: NOW
                            });
                            currentCacheSize += finalBuffer.byteLength;
                            logBridge("cached", targetUrl, finalBuffer.byteLength);
                        });
                    }
                });
                stream.on('error', (err) => {
                    if (!res.writableEnded) res.end();
                });
            } else {
                res.end();
            }
        }

    } catch (err) {
        if (!res.headersSent) res.status(502).end(); 
    }
}