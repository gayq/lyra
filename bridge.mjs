import path from "path";
import { Readable } from "stream";
import { pipeline } from "stream/promises";
import { Agent, setGlobalDispatcher } from "undici";
import * as cheerio from 'cheerio';
import { minify } from 'html-minifier-terser';
import postcss from 'postcss';
import cssnano from 'cssnano';
import { minify as terserMinify } from 'terser';

const HTML_REWRITING = true;
const agent = new Agent({
    keepAliveTimeout: 15000,
    connections: 200,
    pipelining: 1,
});
setGlobalDispatcher(agent);

const CACHE = new Map();
const MAX_CACHE_SIZE_BYTES = 250 * 1024 * 1024;
const MAX_FILE_SIZE_TO_CACHE = 5 * 1024 * 1024;
let currentCacheSize = 0;

function pruneCache() {
    while (currentCacheSize > MAX_CACHE_SIZE_BYTES) {
        const keyToDelete = CACHE.keys().next().value;
        const entry = CACHE.get(keyToDelete);
        if (entry) currentCacheSize -= entry.buffer.byteLength;
        CACHE.delete(keyToDelete);
    }
}

const cssRewriteRegex = /url\(\s*(['"]?)(.*?)\1\s*\)/gi;
const rewriteCss = (cssText, resolutionBase, bridgePrefix) => {
    if (!cssText) return cssText;
    
    const processUrl = (url) => {
        if (!url) return null;
        url = url.trim();

        if (url.startsWith('data:') || url.startsWith('#') ||
            url.startsWith('mailto:') || url.startsWith('javascript:') ||
            url.startsWith(bridgePrefix)) {
            return url;
        }

        try {
            const absoluteUrl = new URL(url, resolutionBase).href;
            return `${bridgePrefix}${absoluteUrl}`;
        } catch (e) {
            return url;
        }
    };

    return cssText.replace(cssRewriteRegex, (match, quote, urlPath) => {
        if ((urlPath.startsWith("'") && urlPath.endsWith("'")) ||
            (urlPath.startsWith('"') && urlPath.endsWith('"'))) {
            urlPath = urlPath.slice(1, -1);
        }
        const newUrl = processUrl(urlPath);
        return `url(${quote}${newUrl}${quote})`;
    });
};

function rewriteContent(content, originalUrl, bridgePrefix) {
    if (!HTML_REWRITING) return content;

    const $ = cheerio.load(content, { decodeEntities: false, xmlMode: false });

    let resolutionBase = originalUrl;
    const $base = $('base');

    if ($base.length > 0) {
        const href = $base.attr('href');
        if (href) {
            try {
                resolutionBase = new URL(href, originalUrl).href;
            } catch (e) {
            }
        }
    }

    const bridgedBaseUrl = `${bridgePrefix}${resolutionBase}`;

    if ($base.length > 0) {
        $base.attr('href', bridgedBaseUrl);
    } else {
        $('head').prepend(`<base href="${bridgedBaseUrl}">`);
    }

    const processUrl = (url) => {
        if (!url) return null;
        url = url.trim();

        if (url.startsWith('data:') || url.startsWith('#') ||
            url.startsWith('mailto:') || url.startsWith('javascript:') ||
            url.startsWith(bridgePrefix)) {
            return url;
        }

        try {
            const absoluteUrl = new URL(url, resolutionBase).href;
            return `${bridgePrefix}${absoluteUrl}`;
        } catch (e) {
            return url;
        }
    };

    const urlAttributes = {
        'script': 'src',
        'link': 'href',
        'img': ['src', 'srcset'],
        'source': 'src',
        'video': 'poster',
        'iframe': 'src',
        'form': 'action',
        'a': 'href'
    };

    for (const [tag, attrs] of Object.entries(urlAttributes)) {
        $(tag).each((i, element) => {
            const $el = $(element);

            $el.removeAttr('integrity');
            $el.removeAttr('crossorigin');

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

    $('style').each((i, el) => {
        const $el = $(el);
        const html = $el.html();
        if(html) $el.html(rewriteCss(html, resolutionBase, bridgePrefix));
    });

    $('*[style]').each((i, el) => {
        const $el = $(el);
        const style = $el.attr('style');
        if(style) $el.attr('style', rewriteCss(style, resolutionBase, bridgePrefix));
    });

    $('meta[http-equiv="Content-Security-Policy"]').remove();
    $('meta[http-equiv="X-Frame-Options"]').remove();

    $('script').filter((i, el) => {
        const $el = $(el);
        const src = $el.attr('src');
        const html = $el.html();

        if (src && (src.includes('google-analytics.com') || src.includes('googletagmanager.com') || src.includes('gtag/js'))) {
            return true;
        }

        if (html && (html.includes('google-analytics.com') || html.includes('googletagmanager.com') || html.includes('gtag(') || html.includes('ga('))) {
            return true;
        }

        return false;
    }).remove();

    $('iframe').filter((i, el) => {
        const $el = $(el);
        const src = $el.attr('src');
        return src && (src.includes('google-analytics.com') || src.includes('googletagmanager.com'));
    }).remove();

    $('link[rel="dns-prefetch"]').filter((i, el) => {
        const $el = $(el);
        const href = $el.attr('href');
        return href && (href.includes('google-analytics.com') || href.includes('googletagmanager.com'));
    }).remove();

    return $.html();
}

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
    '.webp': 'image/webp',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
    '.ttf': 'font/ttf',
    '.otf': 'font/otf',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.mp3': 'audio/mpeg',
    '.wav': 'audio/wav',
    '.ogg': 'audio/ogg',
    '.mp4': 'video/mp4',
    '.webm': 'video/webm'
};

const BINARY_EXCLUSIONS = new Set([
    '.dat', '.bin', '.exe',
    '.pck', '.scn', '.tscn',
    '.res', '.tres',
    '.unity', '.asset', '.prefab',
    '.unity3d', '.bundle',
    '.dll',
    '.gz', '.zip', '.rar', '.7z',
    '.glb', '.gltf', '.fbx', '.obj',
    '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.svg',
]);

const BLACKLIST_REQ_HEADERS = new Set([
    'host', 'connection', 'content-length', 'transfer-encoding',
    'accept-encoding', 'upgrade', 'sec-websocket-key', 'sec-websocket-extensions',
    'origin', 'referer'
]);

const BLACKLIST_RES_HEADERS = new Set([
    'connection', 'content-encoding', 'content-length', 'transfer-encoding',
    'content-security-policy', 'content-security-policy-report-only',
    'strict-transport-security', 'x-frame-options'
]);

const HTML_MINIFY_OPTIONS = {
    collapseWhitespace: true,
    removeComments: true,
    removeRedundantAttributes: true,
    removeScriptTypeAttributes: true,
    removeStyleLinkTypeAttributes: true,
    useShortDoctype: true,
    minifyJS: true,
    minifyCSS: true
};

const CSS_MINIFY_OPTIONS = {
    from: undefined, 
    to: undefined,
    map: false
};

async function minifyJsTerser(content) {
    try {
        const result = await terserMinify(content, {
            compress: {
                dead_code: true,
                drop_console: true,
                unsafe: true
            },
            mangle: true
        });
        return result.code || content;
    } catch (e) {
        console.error("JS minification failed:", e.message);
        return content;
    }
}

export async function bridgeHandler(req, res) {
    let abortController = new AbortController();
    let timeoutId;

    if (req.method === 'OPTIONS') {
        res.setHeader("Access-Control-Allow-Origin", "*");
        res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, PATCH, OPTIONS");
        res.setHeader("Access-Control-Allow-Headers", req.headers['access-control-request-headers'] || "Content-Type, Authorization, X-Requested-With");
        res.setHeader("Access-Control-Max-Age", "86400");
        return res.status(204).end();
    }

    try {
        const prefix = "/!!/";
        let targetUrl = "";

        const fullRequestUrl = req.originalUrl || req.url;

        if (fullRequestUrl.includes(prefix)) {
            targetUrl = fullRequestUrl.substring(fullRequestUrl.indexOf(prefix) + prefix.length);
        } else if (req.params && req.params[0]) {
            targetUrl = req.params[0];
        } else {
            targetUrl = req.url.slice(1);
        }

        if (!targetUrl) return res.status(400).json({ error: "No URL" });

        if (targetUrl.startsWith('http')) {
        } else if (targetUrl.match(/^https?:\/\//)) {
        } else {
             targetUrl = 'https://' + targetUrl;
        }

        try {
            new URL(targetUrl);
        } catch(e) {
            try {
                targetUrl = decodeURIComponent(targetUrl);
                if (!targetUrl.startsWith('http')) targetUrl = 'https://' + targetUrl;
                new URL(targetUrl);
            } catch(e2) {
                return res.status(400).send("Invalid URL");
            }
        }

        if (req.method === 'GET' && CACHE.has(targetUrl)) {
            const cached = CACHE.get(targetUrl);
            if (Date.now() - cached.timestamp < 900000) {
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

        timeoutId = setTimeout(() => abortController.abort(), 20000);

        const requestHeaders = new Headers();
        for (const [key, value] of Object.entries(req.headers)) {
            if (!BLACKLIST_REQ_HEADERS.has(key.toLowerCase())) {
                requestHeaders.set(key, value);
            }
        }

        requestHeaders.set('User-Agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36');

        const fetchOptions = {
            method: req.method,
            headers: requestHeaders,
            redirect: 'follow',
            signal: abortController.signal
        };

        if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
            fetchOptions.body = req;
            fetchOptions.duplex = 'half';
        }

        const response = await fetch(targetUrl, fetchOptions);
        clearTimeout(timeoutId);

        res.setHeader("Access-Control-Allow-Origin", "*");
        res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, PATCH, OPTIONS");
        res.setHeader("Access-Control-Allow-Credentials", "true");
        res.setHeader("X-Cache", "MISS");

        const responseHeaders = {};
        response.headers.forEach((value, key) => {
            if (BLACKLIST_RES_HEADERS.has(key.toLowerCase())) return;
            if (key.toLowerCase() === 'content-type') return;

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
        let contentType = MIME_TYPES[ext] || response.headers.get("content-type");

        if (contentType) contentType = contentType.split(';')[0];
        else contentType = "application/octet-stream";
        
        if (ext === '.css') {
            contentType = 'text/css';
        } else if (ext === '.js') {
            contentType = 'application/javascript';
        }

        res.setHeader("Content-Type", contentType);
        responseHeaders['Content-Type'] = contentType;

        res.status(response.status);

        const isHtml = contentType.includes('text/html');
        const isCss = contentType.includes('text/css');
        const isJs = contentType.includes('javascript');
        const isBinaryGameFile = BINARY_EXCLUSIONS.has(ext);
        const shouldRewrite = HTML_REWRITING && (isHtml || isCss) && !isBinaryGameFile;
        const shouldOptimize = (isHtml || isCss || isJs) && !isBinaryGameFile; 

        if (req.method === 'GET' && response.status === 200) {
            const buffer = await response.arrayBuffer();
            let nodeBuffer = Buffer.from(buffer);

            if (shouldRewrite || shouldOptimize) {
                 try {
                    if (isHtml || isCss || isJs) {
                        let processedContent = nodeBuffer.toString('utf8');
                        let resolutionBase = targetUrl;
                    
                        if (isHtml) {
                            processedContent = rewriteContent(processedContent, targetUrl, prefix);
                            processedContent = await minify(processedContent, HTML_MINIFY_OPTIONS);
                        } else if (isCss) {
                            const isLikelyHtml = /<\s*html\s*|<!DOCTYPE/i.test(processedContent);
                            
                            if (!isLikelyHtml) {
                                processedContent = rewriteCss(processedContent, resolutionBase, prefix);
                                const result = await postcss([cssnano()]).process(processedContent, CSS_MINIFY_OPTIONS);
                                processedContent = result.css;
                            } else {
                                console.warn(`Skipping CSS minification for ${targetUrl}`);
                                processedContent = rewriteContent(processedContent, targetUrl, prefix);
                            }
                        } else if (isJs) {
                            processedContent = await minifyJsTerser(processedContent);
                        }

                        nodeBuffer = Buffer.from(processedContent, 'utf8');
                    } 
                 } catch (e) {
                     console.error("Content processing failed:", e.message);
                 }
            }
            
            if (nodeBuffer.byteLength < MAX_FILE_SIZE_TO_CACHE) {
                if (currentCacheSize + nodeBuffer.byteLength > MAX_CACHE_SIZE_BYTES) {
                    pruneCache();
                }

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
            if (response.body) {
                await pipeline(Readable.fromWeb(response.body), res);
            } else {
                res.end();
            }
        }

    } catch (err) {
        if (timeoutId) clearTimeout(timeoutId);
        if (err.name === 'AbortError' || ['ECONNRESET'].includes(err.code)) return;
        if (!res.headersSent) res.status(502).send("Bad Gateway");
    }
}