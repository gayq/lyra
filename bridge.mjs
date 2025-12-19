import { Readable } from "stream";
import { pipeline } from "stream/promises";
import { Agent, ProxyAgent, setGlobalDispatcher } from "undici";
import { HTMLRewriter } from 'html-rewriter-wasm';
import dns from 'dns';

const HTML_REWRITING = true;
const isDevMode = process.env.NODE_ENV === 'development';
const BRIDGE_PREFIX = "/!!/";

const logBridge = (...args) => {
    if (isDevMode) console.log("[Bridge:Dev]", ...args);
};

const agentOptions = {
    keepAliveTimeout: 120000,
    connections: 4096,
    pipelining: 1,
    allowH2: true,
    connect: { 
        rejectUnauthorized: false, 
        timeout: 5000,
        keepAlive: true
    },
    headersTimeout: 30000,
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
const originalLookup = dns.lookup;

dns.lookup = (hostname, options, callback) => {
    if (typeof options === 'function') { callback = options; options = {}; }
    const cached = DNS_CACHE.get(hostname);
    if (cached && Date.now() - cached.timestamp < 300000) {
        logBridge("DNS Cache HIT", hostname);
        return callback(null, cached.address, cached.family);
    }
    originalLookup(hostname, options, (err, address, family) => {
        if (!err) {
            logBridge("DNS Cache MISS/SET", hostname, address);
            DNS_CACHE.set(hostname, { address, family, timestamp: Date.now() });
        }
        callback(err, address, family);
    });
};

const ORDER = [
    'host', 'connection', 'sec-ch-ua', 'sec-ch-ua-mobile', 'sec-ch-ua-platform',
    'upgrade-insecure-requests', 'user-agent', 'accept', 'sec-fetch-site',
    'sec-fetch-mode', 'sec-fetch-user', 'sec-fetch-dest', 'accept-encoding',
    'accept-language', 'range', 'cookie', 'if-none-match'
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

const USER_AGENTS = [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0"
];

let NOW = Date.now();
setInterval(() => { NOW = Date.now(); }, 500).unref();

const CACHE = new Map();
const MAX_CACHE_SIZE_BYTES = 512 * 1024 * 1024;
const MAX_FILE_SIZE_TO_CACHE = 32 * 1024 * 1024;
let currentCacheSize = 0;
const CACHE_LIFETIME_MS = 15 * 60 * 1000;

const URL_MEMO = new Map();
const MAX_MEMO_SIZE = 50000;

const ensureCacheCapacity = (neededBytes = 0) => {
    if (neededBytes > MAX_CACHE_SIZE_BYTES) return false;
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

const H_PREFIX = `<script>(function(){window.__BRIDGE_PREFIX__="${BRIDGE_PREFIX}`;
const H_MID = '";window.__BRIDGE_TARGET__="';
const H_SUFFIX = '";window.__BRIDGE_BASE__=window.__BRIDGE_BASE__||((window.location.origin||"")+window.__BRIDGE_PREFIX__);const downloadExts=[".zip",".rar",".7z",".tar",".gz",".tgz",".bz2",".xz",".exe",".msi",".apk",".dmg",".deb",".rpm",".pdf",".doc",".docx",".xls",".xlsx",".ppt",".pptx",".iso",".img",".bin",".msix",".pkg",".mp3",".mp4",".wav",".flac",".mkv",".mov"];const resolveAbs=(u)=>{if(!u)return null;try{return new URL(u,window.__BRIDGE_TARGET__).href}catch(e){try{return new URL(u).href}catch(err){return null}}};document.addEventListener("click",function(e){if(e.defaultPrevented)return;const a=e.target.closest("a");if(!a)return;const href=a.getAttribute("data-bridge-orig-href")||a.getAttribute("href");if(!href)return;const lower=href.toLowerCase();const hasDownload=a.hasAttribute("download")||downloadExts.some(ext=>lower.endsWith(ext));if(!hasDownload)return;const real=resolveAbs(href);if(!real||real.startsWith("javascript:"))return;e.preventDefault();const bridged=window.__BRIDGE_BASE__+real;if(a.target==="_blank"||e.ctrlKey||e.metaKey||a.hasAttribute("download")){window.open(bridged,"_blank");}else{window.location.assign(bridged);}});if(navigator.serviceWorker&&navigator.serviceWorker.controller){try{navigator.serviceWorker.controller.postMessage({type:"bridge-base",base:window.__BRIDGE_BASE__});}catch(e){}}const rewrite=(url)=>{if(!url||typeof url!=="string")return url;if(url.startsWith("data:")||url.startsWith("blob:")||url.startsWith(window.__BRIDGE_PREFIX__))return url;if(url.startsWith(window.location.origin+window.__BRIDGE_PREFIX__))return url;if(url.startsWith("http"))return window.__BRIDGE_PREFIX__+url;if(url.startsWith("/"))try{return window.__BRIDGE_PREFIX__+new URL(url,window.__BRIDGE_TARGET__).href}catch(e){return url}return url};const originalFetch=window.fetch;window.fetch=function(input,init){if(typeof input==="string")input=rewrite(input);else if(input instanceof Request)input=new Request(rewrite(input.url),input);return originalFetch(input,init)};const originalOpen=XMLHttpRequest.prototype.open;XMLHttpRequest.prototype.open=function(method,url,...args){return originalOpen.call(this,method,rewrite(url),...args)};const originalWS=window.WebSocket;window.WebSocket=function(url,protocols){if(!url)return new originalWS(url,protocols);let target=url;if(!target.startsWith("ws")){try{target=new URL(url,window.__BRIDGE_TARGET__).href}catch(e){}target=target.replace("http","ws")}const proxyUrl=(window.location.protocol==="https:"?"wss://":"ws://")+window.location.host+window.__BRIDGE_PREFIX__+"ws/"+encodeURIComponent(target);const ws=new originalWS(proxyUrl,protocols);ws.binaryType="arraybuffer";return ws};const originalWorker=window.Worker;window.Worker=function(scriptURL,options){return new originalWorker(rewrite(scriptURL),options)};window.dataLayer=[];window.gtag=function(){};window.ga=function(){}})()</script>';
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
    '.json': 'application/json'
};

const MIME_TYPES = {
    '.html': 'text/html', '.css': 'text/css', '.png': 'image/png', '.jpg': 'image/jpeg',
    '.webp': 'image/webp', '.svg': 'image/svg+xml', '.woff2': 'font/woff2',
    ...GAME_MIME_TYPES
};

const BLACKLIST_REQ_HEADERS = new Set([
    'host', 'connection', 'content-length', 'transfer-encoding', 'accept-encoding', 
    'upgrade', 'sec-websocket-key', 'sec-websocket-version', 'sec-websocket-extensions', 
    'origin', 'referer', 'sec-fetch-dest', 'sec-fetch-mode', 'sec-fetch-site', 'cookie',
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
            
            if (body === undefined) {
                res.end();
                return res;
            }
            if (Buffer.isBuffer(body) || body instanceof Uint8Array || typeof body === 'string') {
                res.end(body);
                return res;
            }
            if (body && typeof body === 'object') {
                if (!res.headersSent) {
                    res.setHeader('Content-Type', 'application/json; charset=utf-8');
                }
                res.end(JSON.stringify(body));
                return res;
            }
            res.end(String(body));
            return res;
        };
    }
    if (typeof res.json !== 'function') {
        res.json = (payload) => {
            if (!res.headersSent) {
                res.setHeader('Content-Type', 'application/json; charset=utf-8');
            }
            return res.send(payload);
        };
    }
    if (typeof res.appendHeader !== 'function') {
        res.appendHeader = (name, value) => {
            const existing = res.getHeader(name);
            if (existing === undefined) {
                res.setHeader(name, value);
                return res;
            }
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
        logBridge("Incoming request", { method: req.method, url: fullRequestUrl, headers: req.headers });
        const prefixIndex = fullRequestUrl.indexOf(prefix);
            
        if (prefixIndex === -1) return res.status(400).json({ error: "No URL prefix found" });

        let targetUrl = fullRequestUrl.substring(prefixIndex + prefix.length);
        
        while (targetUrl.startsWith(prefix)) {
            targetUrl = targetUrl.substring(prefix.length);
        }

        if (targetUrl.indexOf('%') !== -1) {
            try { targetUrl = decodeURI(targetUrl); } catch(e) {}
        }
        logBridge("Resolved target", targetUrl);
            
        if (targetUrl.startsWith('ws/')) return res.status(400).send("WebSocket connections must use a WebSocket endpoint");
        if (!targetUrl.startsWith('http')) targetUrl = 'https://' + targetUrl;

        if (req.method === 'GET') {
            const cached = CACHE.get(targetUrl);
            if (cached) {
                if (NOW - cached.timestamp < CACHE_LIFETIME_MS) { 
                    CACHE.delete(targetUrl);
                    CACHE.set(targetUrl, cached);
                    logBridge("Cache HIT", targetUrl);
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
                    logBridge("Cache EXPIRED and deleted", targetUrl);
                }
            } else {
                logBridge("Cache MISS", targetUrl);
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
            
        if (req.headers['range']) requestHeaders['range'] = req.headers['range'];

        if (req.method !== 'GET' && req.method !== 'HEAD') requestHeaders['origin'] = targetObj.origin;
        requestHeaders['referer'] = targetObj.origin + '/';
        if (req.method === 'POST' && !requestHeaders['content-type']) requestHeaders['content-type'] = 'application/json';

        requestHeaders = sortHeaders(requestHeaders);
        logBridge("Forwarding request", { targetUrl, method: req.method, headers: requestHeaders });

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
        let attempt = 0;
        let lastError;

        while(retries >= 0) {
            attempt++;
            logBridge("Fetch attempt", { targetUrl, attempt });
            try {
                response = await fetch(targetUrl, fetchOptions);
                if (response.status === 429 && retries > 0) {
                    logBridge("Retrying fetch 429", { targetUrl, remainingRetries: retries });
                    await new Promise(r => setTimeout(r, 200 + Math.random() * 500));
                    retries--;
                    continue;
                }
                break;
            } catch(e) {
                lastError = e;
                logBridge("Fetch error", { targetUrl, attempt, error: e.message });
                if (retries > 0) {
                    await new Promise(r => setTimeout(r, 100));
                    retries--;
                } else {
                    break;
                }
            }
        }

        if (!response) {
            if (lastError) {
                console.error(`[Bridge 502 Error] Target: ${targetUrl} | Error: ${lastError.message} | Code: ${lastError.code}`);
                logBridge("Final fetch failure", { targetUrl, error: lastError.message });
            }
            return res.status(502).end();
        }

        res.statusCode = response.status;
        res.statusMessage = response.statusText;
        res.setHeader("Access-Control-Allow-Origin", "*");
        res.setHeader("X-Cache", "MISS");
        res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
        res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
        res.setHeader("Cross-Origin-Resource-Policy", "cross-origin");

        const responseHeaders = Object.create(null);
        const responseSnapshot = {};
        response.headers.forEach((value, key) => {
            responseSnapshot[key] = value;
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
        logBridge("Response headers", { targetUrl, status: response.status, headers: responseSnapshot });

        const pathname = targetObj.pathname;
        const lastDot = pathname.lastIndexOf('.');
        const ext = lastDot !== -1 ? pathname.substring(lastDot).toLowerCase() : '';
        const isBinaryGameFile = ext === '.wasm' || ext === '.pck' || ext === '.data' || ext === '.unityweb' || ext === '.mem' || ext === '.json' || ext === '.js' || ext === '.symbols';
            
        if (isBinaryGameFile && response.status === 200) {
            res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
            responseHeaders['Cache-Control'] = "public, max-age=31536000, immutable";
        }

        let contentType = GAME_MIME_TYPES[ext] || MIME_TYPES[ext] || response.headers.get("content-type") || "application/octet-stream";
        const clientWantsHtml = req.headers['sec-fetch-dest'] === 'document' || (req.headers['accept'] && req.headers['accept'].indexOf('text/html') !== -1);
        if (clientWantsHtml && (ext === '.html' || ext === '.htm' || ext === '.php' || ext === '')) {
            contentType = 'text/html';
        }

        const semiIndex = contentType.indexOf(';');
        if (semiIndex !== -1) contentType = contentType.substring(0, semiIndex);
        res.setHeader("Content-Type", contentType);

        const shouldRewrite = HTML_REWRITING && contentType === 'text/html' && response.status === 200 && !isBinaryGameFile;

        logBridge("Rewrite decision", { targetUrl, shouldRewrite, contentType });
        
        if (shouldRewrite) {
            let resolutionBase = response.url;
            const targetOrigin = new URL(response.url).origin;
                
            let cacheBuffer = [];
            let totalCacheSize = 0;
            let canCache = true;

            const rewriter = new HTMLRewriter((chunk) => {
                if (res.writableEnded) return;
                res.cork();
                res.write(chunk);
                res.uncork();

                if (canCache) {
                    totalCacheSize += chunk.length;
                    if (totalCacheSize > MAX_FILE_SIZE_TO_CACHE) {
                        canCache = false;
                        cacheBuffer = null; 
                        logBridge("Cache CANCELLED", targetUrl, "File too large");
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
                            if (src.includes('Build.loader.js') || src.includes('.loader.js')) {
                                const basePath = src.replace(/\.loader\.js$/, '');
                                const preWasm = `<link rel="preload" href="${processUrl(basePath + '.wasm')}" as="fetch" crossorigin>`;
                                const preData = `<link rel="preload" href="${processUrl(basePath + '.data')}" as="fetch" crossorigin>`;
                                el.before(preWasm + preData, { html: true });
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

            let headFound = false;
            rewriter.on('head', {
                element(el) {
                    headFound = true;
                    el.prepend(H_SUFFIX, { html: true });
                    el.prepend(targetOrigin, { html: true });
                    el.prepend(H_MID, { html: true });
                    el.prepend(prefix, { html: true });
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
                        } catch(e) { logBridge("Error processing <base href>", e.message); }
                    }
                }
            });

            rewriter.on('script[src*="googletagmanager.com"]', { element(el) { el.remove(); } });
            rewriter.on('script[src*="google-analytics.com"]', { element(el) { el.remove(); } });
            rewriter.on('img,script,iframe,link,a,form,*[style]', urlHandler);
            rewriter.on('style', {
                text(text) {
                    if (!text.lastInTextNode) return; 
                    const rewritten = cssRewrite(text.text, resolutionBase, prefix);
                    if (rewritten !== text.text) text.replace(rewritten, { html: true });
                }
            });

            try {
                for await (const chunk of Readable.fromWeb(response.body)) {
                    rewriter.write(chunk);
                }
                rewriter.end();

                if (!headFound) {
                    res.write(H_PREFIX);
                    res.write(prefix);
                    res.write(H_MID);
                    res.write(targetOrigin);
                    res.write(H_SUFFIX);
                }

                res.end();

                if (canCache && cacheBuffer && cacheBuffer.length > 0) {
                    setImmediate(() => {
                        const finalBuffer = Buffer.concat(cacheBuffer);

                        const existing = CACHE.get(targetUrl);
                        if (existing) {
                            currentCacheSize -= existing.buffer?.byteLength || 0;
                            if (currentCacheSize < 0) currentCacheSize = 0;
                            CACHE.delete(targetUrl);
                        }

                        if (!ensureCacheCapacity(finalBuffer.byteLength)) {
                            logBridge("Cache SKIPPED - insufficient room", targetUrl, finalBuffer.byteLength);
                            return;
                        }

                        responseHeaders['content-type'] = contentType;
                        CACHE.set(targetUrl, {
                            buffer: finalBuffer,
                            headers: responseHeaders, 
                            timestamp: NOW
                        });
                        currentCacheSize += finalBuffer.byteLength;
                        logBridge("Cache SAVED", targetUrl, finalBuffer.byteLength, "current cache bytes", currentCacheSize);
                    });
                }

            } catch (e) {
                logBridge("HTML rewrite error", e.message);
                if (!res.writableEnded) res.end();
            } finally {
                rewriter.free();
            }

        } else {
            logBridge("Streaming response body", { targetUrl, binary: !shouldRewrite });
            if (response.body) {
                await pipeline(Readable.fromWeb(response.body), res);
            } else {
                res.end();
            }
        }

    } catch (err) {
        logBridge("Bridge handler unexpected error", err.message, err.stack);
        if (!res.headersSent) res.status(502).end(); 
    }
}
