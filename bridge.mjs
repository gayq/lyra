import path from "path";
import { Readable } from "stream";
import { pipeline } from "stream/promises";
import { Agent, setGlobalDispatcher } from "undici";
import * as cheerio from 'cheerio';

const HTML_REWRITING = true;

const agent = new Agent({
    keepAliveTimeout: 20000,
    connections: 2048,
    pipelining: 4,
    connect: { timeout: 10000 },
    bodyTimeout: 30000
});
setGlobalDispatcher(agent);

const CACHE = new Map();
const MAX_CACHE_SIZE_BYTES = 256 * 1024 * 1024;
const MAX_FILE_SIZE_TO_CACHE = 3 * 1024 * 1024;
let currentCacheSize = 0;
const CACHE_LIFETIME_MS = 45 * 60 * 1000; 

let eventLoopLag = 0;
setInterval(() => {
    const start = Date.now();
    setImmediate(() => {
        eventLoopLag = Date.now() - start;
    });
}, 500);

function pruneCache() {
    const keysToDelete = Math.floor(CACHE.size * 0.2);
    const iterator = CACHE.keys();
    for (let i = 0; i < keysToDelete; i++) {
        const key = iterator.next().value;
        if (!key) break;
        const entry = CACHE.get(key);
        if (entry) currentCacheSize -= entry.buffer.byteLength;
        CACHE.delete(key);
    }
}

const cssRewriteRegex = /url\(\s*(['"]?)(.*?)\1\s*\)/gi;
const rewriteCss = (cssText, resolutionBase, bridgePrefix) => {
    if (!cssText) return cssText;
    const processUrl = (url) => {
        if (!url) return null;
        url = url.trim();
        if (url.startsWith('data:') || url.startsWith('#') || url.startsWith('mailto:') || url.startsWith('javascript:') || url.startsWith(bridgePrefix)) return url;
        try { return `${bridgePrefix}${new URL(url, resolutionBase).href}`; } catch (e) { return url; }
    };
    return cssText.replace(cssRewriteRegex, (match, quote, urlPath) => {
        if ((urlPath.startsWith("'") && urlPath.endsWith("'")) || (urlPath.startsWith('"') && urlPath.endsWith('"'))) urlPath = urlPath.slice(1, -1);
        const newUrl = processUrl(urlPath);
        return `url(${quote}${newUrl}${quote})`;
    });
};

function rewriteContent(content, originalUrl, bridgePrefix) {
    if (!HTML_REWRITING) return content;
    try {
        const $ = cheerio.load(content, { decodeEntities: false, xmlMode: false });
        let resolutionBase = originalUrl;
        const $base = $('base');
        if ($base.length > 0) {
            const href = $base.attr('href');
            if (href) { try { resolutionBase = new URL(href, originalUrl).href; } catch (e) {} }
        }
        const bridgedBaseUrl = `${bridgePrefix}${resolutionBase}`;
        if ($base.length > 0) $base.attr('href', bridgedBaseUrl);
        else $('head').prepend(`<base href="${bridgedBaseUrl}">`);
        
        const processUrl = (url) => {
            if (!url) return null;
            url = url.trim();
            if (url.startsWith('data:') || url.startsWith('#') || url.startsWith('mailto:') || url.startsWith('javascript:') || url.startsWith(bridgePrefix)) return url;
            try { return `${bridgePrefix}${new URL(url, resolutionBase).href}`; } catch (e) { return url; }
        };

        const urlAttributes = { 'script': 'src', 'link': 'href', 'img': ['src', 'srcset'], 'source': 'src', 'video': 'poster', 'iframe': 'src', 'form': 'action', 'a': 'href' };
        for (const [tag, attrs] of Object.entries(urlAttributes)) {
            $(tag).each((i, element) => {
                const $el = $(element);
                $el.removeAttr('integrity'); $el.removeAttr('crossorigin');
                const attrList = Array.isArray(attrs) ? attrs : [attrs];
                attrList.forEach(attr => {
                    const val = $el.attr(attr);
                    if (!val) return;
                    if (attr === 'srcset') {
                        const newSrcset = val.split(',').map(srcPart => {
                            const parts = srcPart.trim().split(/\s+/);
                            if(parts[0]) parts[0] = processUrl(parts[0]);
                            return parts.join(' ');
                        }).join(', ');
                        $el.attr(attr, newSrcset);
                    } else {
                        const newUrl = processUrl(val);
                        if (newUrl) $el.attr(attr, newUrl);
                    }
                });
            });
        }
        $('style').each((i, el) => { const $el = $(el); const html = $el.html(); if(html) $el.html(rewriteCss(html, resolutionBase, bridgePrefix)); });
        $('*[style]').each((i, el) => { const $el = $(el); const style = $el.attr('style'); if(style) $el.attr('style', rewriteCss(style, resolutionBase, bridgePrefix)); });
        $('meta[http-equiv="Content-Security-Policy"]').remove();
        $('meta[http-equiv="X-Frame-Options"]').remove();
        
        return $.html();
    } catch (e) {
        return content;
    }
}

const MIME_TYPES = {
    '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript',
    '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg',
    '.webp': 'image/webp', '.svg': 'image/svg+xml', '.woff2': 'font/woff2'
};

const BLACKLIST_REQ_HEADERS = new Set(['host', 'connection', 'content-length', 'transfer-encoding', 'accept-encoding', 'upgrade']);
const BLACKLIST_RES_HEADERS = new Set(['connection', 'content-encoding', 'content-length', 'transfer-encoding', 'content-security-policy', 'strict-transport-security']);

export async function bridgeHandler(req, res) {
    let abortController = new AbortController();
    let timeoutId;

    if (req.method === 'OPTIONS') {
         res.setHeader("Access-Control-Allow-Origin", "*");
         res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, PATCH, OPTIONS");
         return res.status(204).end();
    }

    try {
        const prefix = "/!!/";
        let targetUrl = "";
        const fullRequestUrl = req.originalUrl || req.url;

        if (fullRequestUrl.includes(prefix)) {
            targetUrl = fullRequestUrl.substring(fullRequestUrl.indexOf(prefix) + prefix.length);
        } else {
            return res.status(400).json({ error: "No URL" });
        }

        if (!targetUrl.startsWith('http')) targetUrl = 'https://' + targetUrl;

        const isCpuOverloaded = eventLoopLag > 80;
        const isMemTight = (process.memoryUsage().heapUsed / 1024 / 1024) > 3500;

        if (req.method === 'GET' && CACHE.has(targetUrl)) {
            const cached = CACHE.get(targetUrl);
            if (Date.now() - cached.timestamp < CACHE_LIFETIME_MS) { 
                res.setHeader("X-Cache", "HIT");
                res.setHeader("Access-Control-Allow-Origin", "*");
                Object.entries(cached.headers).forEach(([k, v]) => res.setHeader(k, v));
                res.status(200).send(cached.buffer);
                return;
            } else {
                currentCacheSize -= cached.buffer.byteLength;
                CACHE.delete(targetUrl);
            }
        }

        timeoutId = setTimeout(() => abortController.abort(), 15000);

        const requestHeaders = new Headers();
        for (const [key, value] of Object.entries(req.headers)) {
            if (!BLACKLIST_REQ_HEADERS.has(key.toLowerCase())) requestHeaders.set(key, value);
        }
        requestHeaders.set('User-Agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');

        const fetchOptions = {
            method: req.method,
            headers: requestHeaders,
            redirect: 'follow',
            signal: abortController.signal
        };

        if (['POST', 'PUT', 'PATCH'].includes(req.method)) {
            fetchOptions.body = req;
            fetchOptions.duplex = 'half';
        }

        const response = await fetch(targetUrl, fetchOptions);
        clearTimeout(timeoutId);

        res.setHeader("Access-Control-Allow-Origin", "*");
        res.setHeader("X-Cache", "MISS");

        const responseHeaders = {};
        response.headers.forEach((value, key) => {
            if (BLACKLIST_RES_HEADERS.has(key.toLowerCase())) return;
            if (key.toLowerCase() === 'set-cookie') {
                const safeCookie = value.replace(/Domain=[^;]+;?/gi, '').replace(/Secure;?/gi, '').replace(/SameSite=[^;]+;?/gi, 'SameSite=Lax');
                res.appendHeader('Set-Cookie', safeCookie);
                responseHeaders['Set-Cookie'] = safeCookie;
            } else {
                res.setHeader(key, value);
                responseHeaders[key] = value;
            }
        });

        const urlObj = new URL(targetUrl);
        const ext = path.extname(urlObj.pathname).toLowerCase();
        let contentType = MIME_TYPES[ext] || response.headers.get("content-type") || "application/octet-stream";
        contentType = contentType.split(';')[0];
        res.setHeader("Content-Type", contentType);

        const isHtml = contentType.includes('text/html');
        const isCss = contentType.includes('text/css');
        
        const safeToBuffer = !isCpuOverloaded && !isMemTight;
        const shouldRewrite = safeToBuffer && HTML_REWRITING && (isHtml || isCss);

        if (req.method === 'GET' && response.status === 200) {
            const contentLength = response.headers.get("content-length");
            const length = contentLength ? parseInt(contentLength, 10) : Infinity;

            if (!safeToBuffer || length > MAX_FILE_SIZE_TO_CACHE) {
                if (response.body) await pipeline(Readable.fromWeb(response.body), res);
                else res.end();
                return;
            }
            
            const buffer = await response.arrayBuffer();
            let nodeBuffer = Buffer.from(buffer);

            try {
                if (shouldRewrite) {
                    let processedContent = nodeBuffer.toString('utf8');
                    if (isHtml) processedContent = rewriteContent(processedContent, targetUrl, prefix);
                    else if (isCss) processedContent = rewriteCss(processedContent, targetUrl, prefix);
                    nodeBuffer = Buffer.from(processedContent, 'utf8');
                }
            } catch (e) { }
            
            if (nodeBuffer.byteLength < MAX_FILE_SIZE_TO_CACHE) {
                if (currentCacheSize + nodeBuffer.byteLength > MAX_CACHE_SIZE_BYTES) pruneCache();
                if (currentCacheSize + nodeBuffer.byteLength <= MAX_CACHE_SIZE_BYTES) {
                    CACHE.set(targetUrl, {
                        buffer: nodeBuffer,
                        headers: responseHeaders,
                        timestamp: Date.now()
                    });
                    currentCacheSize += nodeBuffer.byteLength;
                }
            }
            res.end(nodeBuffer);
        } else {
            if (response.body) await pipeline(Readable.fromWeb(response.body), res);
            else res.end();
        }

    } catch (err) {
        if (timeoutId) clearTimeout(timeoutId);
        if (err.name === 'AbortError' || ['ECONNRESET'].includes(err.code)) return; 
        if (!res.headersSent) res.status(502).send("Bad Gateway");
    }
}