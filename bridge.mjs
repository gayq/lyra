import { Readable } from "stream";
import { pipeline } from "stream/promises";
import { Agent, ProxyAgent, setGlobalDispatcher } from "undici";
import { HTMLRewriter } from 'html-rewriter-wasm';
import dns from 'dns';

const HTML_REWRITING = true;

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
        return callback(null, cached.address, cached.family);
    }
    originalLookup(hostname, options, (err, address, family) => {
        if (!err) DNS_CACHE.set(hostname, { address, family, timestamp: Date.now() });
        callback(err, address, family);
    });
};

const CHROME_ORDER = [
    'host', 'connection', 'sec-ch-ua', 'sec-ch-ua-mobile', 'sec-ch-ua-platform',
    'upgrade-insecure-requests', 'user-agent', 'accept', 'sec-fetch-site',
    'sec-fetch-mode', 'sec-fetch-user', 'sec-fetch-dest', 'accept-encoding',
    'accept-language', 'range', 'cookie', 'if-none-match'
];

const sortHeaders = (headers) => {
    const sorted = {};
    for (const key of CHROME_ORDER) {
        if (headers[key]) {
            sorted[key] = headers[key];
            delete headers[key];
        }
    }
    for (const key in headers) sorted[key] = headers[key];
    return sorted;
};

const USER_AGENTS = [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0"
];
const getRandomUA = () => USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
const getRandomIP = () => `${Math.floor(Math.random()*255)}.${Math.floor(Math.random()*255)}.${Math.floor(Math.random()*255)}.${Math.floor(Math.random()*255)}`;

let NOW = Date.now();
setInterval(() => { NOW = Date.now(); }, 500).unref();

const CACHE = new Map();
const MAX_CACHE_SIZE_BYTES = 6 * 1024 * 1024 * 1024;
const MAX_FILE_SIZE_TO_CACHE = 150 * 1024 * 1024;
let currentCacheSize = 0;
const CACHE_LIFETIME_MS = 60 * 60 * 1000;

const URL_MEMO = new Map();
const MAX_MEMO_SIZE = 50000;

const H_PREFIX = '<script>(function(){window.__BRIDGE_PREFIX__="';
const H_MID = '";window.__BRIDGE_TARGET__="';
const H_SUFFIX = '";const rewrite=(url)=>{if(!url||typeof url!=="string")return url;if(url.startsWith("data:")||url.startsWith("blob:")||url.startsWith(window.__BRIDGE_PREFIX__))return url;if(url.startsWith("http"))return window.__BRIDGE_PREFIX__+url;if(url.startsWith("/"))try{return window.__BRIDGE_PREFIX__+new URL(url,window.__BRIDGE_TARGET__).href}catch(e){return url}return url};const originalFetch=window.fetch;window.fetch=function(input,init){if(typeof input==="string")input=rewrite(input);else if(input instanceof Request)input=new Request(rewrite(input.url),input);return originalFetch(input,init)};const originalOpen=XMLHttpRequest.prototype.open;XMLHttpRequest.prototype.open=function(method,url,...args){return originalOpen.call(this,method,rewrite(url),...args)};const originalWS=window.WebSocket;window.WebSocket=function(url,protocols){if(!url)return new originalWS(url,protocols);let target=url;if(!target.startsWith("ws")){try{target=new URL(url,window.__BRIDGE_TARGET__).href}catch(e){}target=target.replace("http","ws")}const proxyUrl=(window.location.protocol==="https:"?"wss://":"ws://")+window.location.host+window.__BRIDGE_PREFIX__+"ws/"+encodeURIComponent(target);const ws=new originalWS(proxyUrl,protocols);ws.binaryType="arraybuffer";return ws};const originalWorker=window.Worker;window.Worker=function(scriptURL,options){return new originalWorker(rewrite(scriptURL),options)};window.dataLayer=[];window.gtag=function(){};window.ga=function(){}})()</script>';

const CSS_URL_REGEX = /url\(\s*(['"]?)(.*?)\1\s*\)/gi;

const cssRewrite = (cssText, resolutionBase, bridgePrefix) => {
    if (cssText.indexOf('url(') === -1) return cssText;
    return cssText.replace(CSS_URL_REGEX, (match, quote, urlPath) => {
        if (urlPath.length > 1 && ((urlPath.startsWith("'") && urlPath.endsWith("'")) || (urlPath.startsWith('"') && urlPath.endsWith('"')))) {
            urlPath = urlPath.slice(1, -1);
        }
        urlPath = urlPath.trim();
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

export async function bridgeHandler(req, res) {
    if (req.method === 'OPTIONS') {
         res.setHeader("Access-Control-Allow-Origin", "*");
         res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, PATCH, OPTIONS");
         res.setHeader("Access-Control-Allow-Headers", "*");
         return res.status(204).end();
    }

    try {
        const prefix = "/!!/";
        const fullRequestUrl = req.originalUrl || req.url;
        const prefixIndex = fullRequestUrl.indexOf(prefix);
        
        if (prefixIndex === -1) return res.status(400).json({ error: "No URL" });

        let targetUrl = fullRequestUrl.substring(prefixIndex + prefix.length);
        if (targetUrl.indexOf('%') !== -1) {
             try { targetUrl = decodeURI(targetUrl); } catch(e) {}
        }
        
        if (targetUrl.startsWith('ws/')) return res.status(400).end(); 
        if (!targetUrl.startsWith('http')) targetUrl = 'https://' + targetUrl;

        if (req.method === 'GET') {
            const cached = CACHE.get(targetUrl);
            if (cached) {
                if (NOW - cached.timestamp < CACHE_LIFETIME_MS) { 
                    res.setHeader("X-Cache", "HIT");
                    res.setHeader("Access-Control-Allow-Origin", "*");
                    res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
                    res.setHeader("Cross-Origin-Embedder-Policy", "require-corp");
                    const keys = Object.keys(cached.headers);
                    for (let i = 0; i < keys.length; i++) res.setHeader(keys[i], cached.headers[keys[i]]);
                    res.status(200).send(cached.buffer);
                    return;
                } else {
                    currentCacheSize -= cached.buffer.byteLength;
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
        
        requestHeaders['user-agent'] = getRandomUA();
        requestHeaders['accept'] = 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7';
        requestHeaders['x-forwarded-for'] = getRandomIP();
        requestHeaders['upgrade-insecure-requests'] = '1';
        
        if (req.headers['range']) requestHeaders['range'] = req.headers['range'];

        if (req.method !== 'GET' && req.method !== 'HEAD') requestHeaders['origin'] = targetObj.origin;
        requestHeaders['referer'] = targetObj.origin + '/';
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
        let lastError;

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
                lastError = e;
                if (retries > 0) {
                    await new Promise(r => setTimeout(r, 100));
                    retries--;
                } else {
                    break;
                }
            }
        }

        if (!response) {
             if (lastError) console.error(`[Bridge] Fetch Failed: ${lastError.message}`);
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
        
        const isBinaryGameFile = ext === '.wasm' || ext === '.pck' || ext === '.data' || ext === '.unityweb' || ext === '.mem';
        
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

        if (shouldRewrite) {
            let resolutionBase = response.url;
            const targetOrigin = new URL(response.url).origin;
            
            let cacheBuffer = [];
            let totalCacheSize = 0;
            let canCache = true;

            const rewriter = new HTMLRewriter((chunk) => {
                res.cork();
                res.write(chunk);
                res.uncork();

                if (canCache) {
                    totalCacheSize += chunk.length;
                    if (totalCacheSize > MAX_FILE_SIZE_TO_CACHE) {
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
                if (url.startsWith('data:') || url.startsWith('#') || url.startsWith(prefix)) {
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
                         if (href) { const n = processUrl(href); if(n) el.setAttribute('href', n); }
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
                        } catch(e) {}
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
                        if (currentCacheSize + finalBuffer.byteLength > MAX_CACHE_SIZE_BYTES) {
                            const keys = CACHE.keys();
                            for (let i = 0; i < 50; i++) {
                                const k = keys.next().value;
                                if(!k) break;
                                const item = CACHE.get(k);
                                currentCacheSize -= item.buffer.byteLength;
                                CACHE.delete(k);
                            }
                        }
                        if (currentCacheSize + finalBuffer.byteLength <= MAX_CACHE_SIZE_BYTES) {
                            responseHeaders['content-type'] = contentType;
                            CACHE.set(targetUrl, {
                                buffer: finalBuffer,
                                headers: responseHeaders, 
                                timestamp: NOW
                            });
                            currentCacheSize += finalBuffer.byteLength;
                        }
                    });
                }

            } catch (e) {
                res.end();
            } finally {
                rewriter.free();
            }

        } else {
            if (response.body) {
                await pipeline(Readable.fromWeb(response.body), res);
            } else {
                res.end();
            }
        }

    } catch (err) {
        if (!res.headersSent) res.status(502).end();
    }
}