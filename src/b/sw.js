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
const STATIC_ASSET_REGEX = /\.(png|jpg|jpeg|gif|ico|webp|bmp|tiff|svg|mp3|wav|ogg|mp4|webm|woff|woff2|ttf|otf|eot)(\?.*)?$/i;

let scramjet;
let uv;
let scramjetConfigLoaded = false;

if (isScramjet) {
    importScripts('/b/s/scramjet.all.js');
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

const INJECTION_SCRIPT = `
<script>
    (function(){
        const O=window.RTCPeerConnection;
        window.RTCPeerConnection=function(c){
            c=c||{};
            c.iceTransportPolicy='relay';
            c.iceServers=[{urls:'turn:__SERVER_IP__:3478',username:'luy',credential:'l4uy'}];
            return new O(c);
        };
    })();
</script>
`;

async function handleProxyResponse(response) {
    const contentType = response.headers.get('content-type');
    if (contentType && contentType.includes('text/html')) {
        let text = await response.text();
        text = text.replace('<head>', '<head>' + INJECTION_SCRIPT);
        return new Response(text, {
            status: response.status,
            statusText: response.statusText,
            headers: response.headers
        });
    }
    return response;
}

self.addEventListener('activate', event => {
    event.waitUntil(self.clients.claim());
});

self.addEventListener("fetch", (event) => {
    const { request } = event;
    const url = new URL(request.url);

    event.respondWith((async () => {
        try {
            if (request.method === 'GET' && STATIC_ASSET_REGEX.test(url.pathname)) {
                let realUrl = null;

                if (isScramjet && url.pathname.startsWith('/b/s/')) {
                    const raw = url.pathname.slice(5) + url.search;
                    const httpIndex = raw.indexOf('http');
                    if (httpIndex !== -1) {
                        realUrl = raw.substring(httpIndex);
                    }
                } 
                else if (isUltraviolet && self.__uv$config && self.__uv$config.decodeUrl) {
                    const prefix = self.__uv$config.prefix || '/b/u/hi/';
                    if (url.pathname.startsWith(prefix)) {
                        const encoded = url.pathname.slice(prefix.length);
                        try {
                            realUrl = self.__uv$config.decodeUrl(encoded) + url.search;
                        } catch(e) {}
                    }
                }

                if (realUrl && realUrl.startsWith('http')) {
                    const proxyUrl = `/!!/${realUrl}`;

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

                if (url.pathname.startsWith('/b/s/scramjet.') && !url.pathname.endsWith('scramjet.wasm.wasm')) {
                    return fetch(request);
                }

                if (scramjet.route(event)) {
                    const response = await scramjet.fetch(event);
                    return handleProxyResponse(response);
                }
            }

            if (isUltraviolet) {
                if (uv.route(event)) {
                    const response = await uv.fetch(event);
                    return handleProxyResponse(response);
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