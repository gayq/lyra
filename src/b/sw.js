// dumb hack to allow firefox to work (please dont do this in prod)
// do this in prod
if (typeof crossOriginIsolated === 'undefined' && navigator.userAgent.includes('Firefox')) {
    Object.defineProperty(self, "crossOriginIsolated", {
        value: true,
        writable: false,
    });
}

const scope = self.registration.scope;
const isScramjet = scope.endsWith('/b/s/');
const isUltraviolet = scope.endsWith('/b/u/hi/');
const UV_PREFIX = '/b/u/hi/';
const STATIC_ASSET_REGEX = /\.(png|jpg|jpeg|gif|ico|webp|bmp|tiff|svg|mp3|wav|ogg|mp4|webm|woff|woff2|ttf|otf|eot)(\?.*)?$/i;
const BRIDGE_PREFIX = '/!!/';
const DOWNLOAD_EXTENSIONS = new Set([
    '.zip', '.rar', '.7z', '.tar', '.gz', '.tgz', '.bz2', '.xz',
    '.exe', '.msi', '.apk', '.dmg', '.deb', '.rpm',
    '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
    '.iso', '.img', '.bin', '.msix', '.pkg', '.mp3', '.mp4', '.wav', '.flac', '.mkv', '.mov'
]);

let scramjet;
let uv;
let scramjetConfigLoaded = false;

self.__BRIDGE_BASE__ = self.__BRIDGE_BASE__ || self.BRIDGE_BASE || null;

self.addEventListener('message', (event) => {
    const data = event?.data;
    if (data && data.type === 'bridge-base' && typeof data.base === 'string' && data.base.startsWith('http')) {
        self.__BRIDGE_BASE__ = data.base.replace(/\/+$/, '') + '/';
    }
});

if (isScramjet) {
    importScripts('/b/s/jetty.all.js');
    const { ScramjetServiceWorker } = $scramjetLoadWorker();
    scramjet = new ScramjetServiceWorker();
} else if (isUltraviolet) {
    importScripts(
        '/b/u/bunbun.js',
        '/b/u/concon.js',
        '/b/u/serser.js'
    );
    uv = new UVServiceWorker();
}

const CACHE_NAME = 'xin-assets-cache-v1';

const TURN_SCRIPT = `
<script>
(function() {
    const OriginalRTCPeerConnection = window.RTCPeerConnection;

    window.RTCPeerConnection = function(config) {
        config = config || {};

        config.iceTransportPolicy = "relay";

        if (config.iceServers) {
            config.iceServers = config.iceServers.filter(server => {
                if (!server || !server.urls) return false;
                const urls = Array.isArray(server.urls) ? server.urls : [server.urls];
                return urls.every(url => url.startsWith("turn:"));
            });
        }

        if (!config.iceServers || config.iceServers.length === 0) {
            config.iceServers = [{
                urls: "turn:__SERVER_IP__:3478",
                username: "luy",
                credential: "l4uy"
            }];
        }

        return new OriginalRTCPeerConnection(config);
    };
})();
</script>
`;

const getBridgeBase = () => {
    if (self.__BRIDGE_BASE__ && self.__BRIDGE_BASE__.startsWith('http')) return self.__BRIDGE_BASE__.replace(/\/+$/, '') + '/!!/';
    if (self.BRIDGE_BASE && self.BRIDGE_BASE.startsWith('http')) return self.BRIDGE_BASE.replace(/\/+$/, '') + '/!!/';
    const loc = self.location;
    const originBase = `${loc.origin}${BRIDGE_PREFIX}`;
    const devBase = `${loc.protocol}//${loc.hostname}:4000${BRIDGE_PREFIX}`;
    return originBase || devBase;
};

const DOWNLOAD_SCRIPT = (() => {
    const exts = [
        '.zip','.rar','.7z','.tar','.gz','.tgz','.bz2','.xz',
        '.exe','.msi','.apk','.dmg','.deb','.rpm',
        '.pdf','.doc','.docx','.xls','.xlsx','.ppt','.pptx',
        '.iso','.img','.bin','.msix','.pkg','.mp3','.mp4','.wav','.flac','.mkv','.mov'
    ];
    const extArray = JSON.stringify(exts);
return `
<script>
(function(){
  const DOWNLOAD_EXTS=${extArray};

  const decodeRealUrl = (href) => {
    if (!href) return null;
    if (href.startsWith('/!!/')) return href.slice(4);
    if (href.startsWith('http://') || href.startsWith('https://')) return href;
    try {
      if (window.__uv$config && typeof window.__uv$config.decodeUrl === 'function') {
        const prefix = window.__uv$config.prefix || '/b/u/hi/';
        if (href.startsWith(prefix)) return window.__uv$config.decodeUrl(href.slice(prefix.length));
        const u = new URL(href, window.location.origin);
        if (u.pathname.startsWith(prefix)) {
          return window.__uv$config.decodeUrl(u.pathname.slice(prefix.length)) + u.search + u.hash;
        }
      }
    } catch(e){}
    try {
      if (window.sj && typeof window.sj.decode === 'function') {
        return window.sj.decode(href);
      }
    } catch(e){}
    try {
      const u = new URL(href, window.location.href);
      return u.href;
    } catch(e){}
    return null;
  };

  const ensureBridgeBase = () => {
    if (window.__BRIDGE_BASE__ && window.__BRIDGE_BASE__.startsWith('http')) return window.__BRIDGE_BASE__;
    if (typeof window.BRIDGE_BASE === 'string' && window.BRIDGE_BASE.startsWith('http')) return window.BRIDGE_BASE;
    const originBase = window.location.origin + '${BRIDGE_PREFIX}';
    const devBase = window.location.protocol + '//' + window.location.hostname + ':4000${BRIDGE_PREFIX}';
    return originBase || devBase;
  };

  const toBridge = (u) => {
    if (!u) return null;
    const base = ensureBridgeBase();
    if (!base) return null;
    const normalized = base.endsWith('/') ? base : base + '/';
    return normalized + u.replace(/^\/+/, '');
  };

  const shouldDownload = (href, anchor) => {
    if (!href) return false;
    if (anchor?.hasAttribute('download')) return true;
    const lower = href.toLowerCase();
    return DOWNLOAD_EXTS.some(ext => lower.endsWith(ext));
  };

  document.addEventListener('click', (e) => {
    if (e.defaultPrevented) return;
    const a = e.target.closest && e.target.closest('a');
    if (!a) return;
    const href = a.getAttribute('data-bridge-orig-href') || a.getAttribute('href');
    if (!shouldDownload(href, a)) return;
    const real = decodeRealUrl(href);
    if (!real || real.startsWith('javascript:')) return;
    const bridged = toBridge(real);
    if (!bridged) return;
    e.preventDefault();
    if (a.target === '_blank' || e.ctrlKey || e.metaKey) {
      window.open(bridged, '_blank');
    } else {
      window.location.assign(bridged);
    }
  }, true);

  try {
    const base = ensureBridgeBase();
    window.__BRIDGE_BASE__ = base;
    if (navigator.serviceWorker && navigator.serviceWorker.controller && base) {
      navigator.serviceWorker.controller.postMessage({ type: 'bridge-base', base });
    }
  } catch(e){}
})();
</script>
`;
})();

function resolveRealUrlFromProxy(url) {
    if (!url) return null;
    if (url.pathname.startsWith(BRIDGE_PREFIX)) return null;

    if (url.origin !== self.location.origin) {
        try {
            return new URL(url.href).href;
        } catch (e) {
            return null;
        }
    }

    if (isScramjet && url.pathname.startsWith('/b/s/')) {
        const raw = url.pathname.slice(5) + url.search;
        const httpIndex = raw.indexOf('http');
        if (httpIndex !== -1) {
            const candidate = raw.substring(httpIndex);
            try {
                const decoded = decodeURIComponent(candidate);
                return new URL(decoded).href;
            } catch (e) {
                try {
                    return new URL(candidate).href;
                } catch (err) {
                    return null;
                }
            }
        }
    }

    if (isUltraviolet && self.__uv$config && typeof self.__uv$config.decodeUrl === 'function') {
        const prefix = self.__uv$config.prefix || '/b/u/hi/';
        if (url.pathname.startsWith(prefix)) {
            const encoded = url.pathname.slice(prefix.length);
            try {
                const decoded = self.__uv$config.decodeUrl(encoded);
                if (!decoded) return null;
                return new URL(decoded + url.search, 'http://placeholder').href.replace('http://placeholder','');
            } catch (e) {}
        }
    }

    return null;
}

function getUrlExtension(targetUrl) {
    try {
        const parsed = new URL(targetUrl);
        const lastDot = parsed.pathname.lastIndexOf('.');
        if (lastDot === -1) return '';
        return parsed.pathname.substring(lastDot).toLowerCase();
    } catch (e) {
        const path = targetUrl.split('?')[0];
        const lastDot = path.lastIndexOf('.');
        return lastDot !== -1 ? path.substring(lastDot).toLowerCase() : '';
    }
}

function shouldBypassProxyForDownload(request, response, realUrl) {
    if (!response || !realUrl) return false;
    if (request.method !== 'GET' && request.method !== 'HEAD') return false;

    const disposition = response.headers.get('content-disposition') || '';
    if (/attachment/i.test(disposition) || /filename=/i.test(disposition)) {
        return true;
    }

    const contentType = (response.headers.get('content-type') || '').toLowerCase();
    const isHtml = contentType.includes('text/html');
    const wantsDocument = request.mode === 'navigate' ||
        request.destination === 'document' ||
        request.headers.get('sec-fetch-dest') === 'document';

    if (wantsDocument && (!contentType || !isHtml)) {
        return true;
    }

    const ext = getUrlExtension(realUrl);
    if (ext && DOWNLOAD_EXTENSIONS.has(ext)) {
        const dest = request.destination || '';
        if (dest === 'document' || dest === '' || dest === 'object' || dest === 'embed' || dest === 'video' || dest === 'audio') {
            if (!isHtml) return true;
        }
    }

    return false;
}

function shouldBridgeEarly(request, realUrl) {
    if (!realUrl || !realUrl.startsWith('http')) return false;
    if (request.method !== 'GET' && request.method !== 'HEAD') return false;

    const ext = getUrlExtension(realUrl);
    if (ext && DOWNLOAD_EXTENSIONS.has(ext)) return true;

    const dest = request.destination || '';
    const secDest = request.headers.get('sec-fetch-dest') || '';
    const looksLikeDoc = dest === 'document' || secDest === 'document' || request.mode === 'navigate';

    if (looksLikeDoc && ext && ext !== '.html' && ext !== '.htm') {
        return true;
    }

    return false;
}

async function fetchThroughBridge(request, realUrl) {
    const headers = new Headers(request.headers);
    headers.delete('host');
    headers.delete('origin');
    headers.delete('referer');

    const init = {
        method: request.method,
        headers,
        redirect: 'follow',
        cache: 'no-store',
        credentials: 'include'
    };

    if (request.method !== 'GET' && request.method !== 'HEAD') {
        try {
            init.body = request.clone().body;
        } catch (e) {}
    }

    const base = getBridgeBase();
    const normalized = base.endsWith('/') ? base : base + '/';
    const target = realUrl.startsWith('http') ? `${normalized}${realUrl}` : `${BRIDGE_PREFIX}${realUrl}`;
    return fetch(target, init);
}

async function maybeHandleDownloadThroughBridge(request, url, proxyResponse) {
    const realUrl = resolveRealUrlFromProxy(url);
    if (!realUrl) return proxyResponse;

    if (!shouldBypassProxyForDownload(request, proxyResponse, realUrl)) {
        return proxyResponse;
    }

    try {
        proxyResponse.body?.cancel?.();
    } catch (e) {}

    try {
        const bridged = await fetchThroughBridge(request, realUrl);
        if (bridged) return bridged;
    } catch (e) {
        return proxyResponse;
    }
}

async function handleProxyResponse(response) {
    const contentType = response.headers.get('content-type');
    if (contentType && contentType.includes('text/html')) {
        let text = await response.text();
        text = text.replace('<head>', '<head>' + TURN_SCRIPT + DOWNLOAD_SCRIPT);
        return new Response(text, {
            status: response.status,
            statusText: response.statusText,
            headers: response.headers
        });
    }
    return response;
}

self.addEventListener('install', (event) => {
    self.skipWaiting();
});

self.addEventListener('activate', event => {
    event.waitUntil(self.clients.claim());
});

self.addEventListener("fetch", (event) => {
    const { request } = event;
    const url = new URL(request.url);
    const realUrl = resolveRealUrlFromProxy(url);

    event.respondWith((async () => {
        try {
            if (realUrl && shouldBridgeEarly(request, realUrl)) {
                try {
                    const bridged = await fetchThroughBridge(request, realUrl);
                    if (bridged) return bridged;
                } catch (e) {}
            }

            if (request.method === 'GET' && STATIC_ASSET_REGEX.test(url.pathname)) {
                if (realUrl && realUrl.startsWith('http')) {
                    const proxyUrl = `${BRIDGE_PREFIX}${realUrl}`;

                    const cache = await caches.open(CACHE_NAME);
                    const cachedRes = await cache.match(proxyUrl);
                    if (cachedRes) return cachedRes;

                    try {
                        const response = await fetch(proxyUrl);
                        
                        if (response.ok) {
                            const resClone = response.clone();
                            cache.put(proxyUrl, resClone);
                            return response;
                        }
                    } catch (e) {
                    }
                }
            }


            if (isScramjet) {
                if (!scramjetConfigLoaded) {
                    await scramjet.loadConfig();
                    scramjetConfigLoaded = true;
                }

                if (url.pathname.startsWith('/b/s/jetty.') && !url.pathname.endsWith('jetty.wasm.wasm')) {
                    return fetch(request);
                }

                if (scramjet.route(event)) {
                    const response = await scramjet.fetch(event);
                    const finalResponse = await maybeHandleDownloadThroughBridge(request, url, response);
                    return handleProxyResponse(finalResponse);
                }
            }

            if (isUltraviolet) {
                if (uv.route(event)) {
                    const response = await uv.fetch(event);
                    const finalResponse = await maybeHandleDownloadThroughBridge(request, url, response);
                    return handleProxyResponse(finalResponse);
                }
            }

            if (url.origin === self.location.origin) {
                const cache = await caches.open(CACHE_NAME);
                const cachedResponse = await cache.match(request);
                if (cachedResponse) {
                    return cachedResponse;
                }
                return await fetch(request);
            }

            return new Response("Uh-oh! Your request has been blocked. :(", { status: 403 });

        } catch (err) {
            if (new URL(request.url).origin === self.location.origin) {
                return fetch(request);
            }
            return new Response("Uh-oh! Your request has been blocked. :( (fallback)", { status: 403 });
        }
    })());
});
