self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(clients.claim());
});

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
const MOCHI_PREFIX = '/!!/';
const DOWNLOAD_EXTENSIONS = new Set([
    '.zip', '.rar', '.7z', '.tar', '.gz', '.tgz', '.bz2', '.xz',
    '.exe', '.msi', '.apk', '.dmg', '.deb', '.rpm',
    '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
    '.iso', '.img', '.bin', '.msix', '.pkg', '.mp3', '.mp4', '.wav', '.flac', '.mkv', '.mov'
]);

let scramjet;
let uv;
let scramjetConfigLoaded = false;

self.__MOCHI_BASE__ = self.__MOCHI_BASE__ || self.MOCHI_BASE || null;

self.addEventListener('message', (event) => {
    const data = event?.data;
    if (data && data.type === 'mochi-base' && typeof data.base === 'string' && data.base.startsWith('http')) {
        self.__MOCHI_BASE__ = data.base.replace(/\/+$/, '') + '/';
    }
    if (data && data.type === 'open-new-tab' && data.url) {
        const sanitizedUrl = typeof data.url === 'string' ? data.url : null;
        if (!sanitizedUrl) return;

        const payload = {
            type: 'open-new-tab',
            url: sanitizedUrl,
            decodedUrl: typeof data.decodedUrl === 'string' ? data.decodedUrl : sanitizedUrl,
            openerUrl: typeof data.openerUrl === 'string' ? data.openerUrl : null,
            tabId: data.tabId || null,
            isTopFrame: !!data.isTopFrame,
            cause: data.cause || null
        };

        event.waitUntil((async () => {
            const clients = await self.clients.matchAll({ includeUncontrolled: true, type: 'window' });
            for (const client of clients) {
                client.postMessage(payload);
            }
        })());
    }
    if (data && data.type === 'page-meta') {
        const payload = {
            type: 'page-meta',
            url: data.url || data.href || null,
            decodedUrl: data.decodedUrl || data.url || data.href || null,
            title: typeof data.title === 'string' ? data.title : '',
            favicon: data.favicon || data.rawFavicon || null,
            rawFavicon: data.rawFavicon || data.favicon || null,
            tabId: data.tabId || null,
            isTopFrame: !!data.isTopFrame,
            memory: data.memory || null,
            clientId: event.source && 'id' in event.source ? event.source.id : null,
            collectedAt: Date.now(),
            encoded: !!data.encoded
        };

        const sourceId = event.source && 'id' in event.source ? event.source.id : null;
        if (event.source && typeof event.source.postMessage === 'function') {
            event.source.postMessage(payload);
        }

        event.waitUntil((async () => {
            const clients = await self.clients.matchAll({ includeUncontrolled: true, type: 'window' });
            for (const client of clients) {
                if (sourceId && client.id === sourceId) continue;
                client.postMessage(payload);
            }
        })());
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

const getMochiBase = () => {
    if (self.__MOCHI_BASE__ && self.__MOCHI_BASE__.startsWith('http')) return self.__MOCHI_BASE__.replace(/\/+$/, '') + '/!!/';
    if (self.MOCHI_BASE && self.MOCHI_BASE.startsWith('http')) return self.MOCHI_BASE.replace(/\/+$/, '') + '/!!/';
    const loc = self.location;
    const originBase = `${loc.origin}${MOCHI_PREFIX}`;
    const devBase = `${loc.protocol}//${loc.hostname}:4000${MOCHI_PREFIX}`;
    return originBase || devBase;
};

const META_SCRIPT = `
<script>
(function(){
  const MOCHI_PREFIX='$MOCHI_PREFIX}';
  const UV_PREFIX='${UV_PREFIX}';
  const isScramjet=${isScramjet ? 'true' : 'false'};
  const isUltraviolet=${isUltraviolet ? 'true' : 'false'};

  const isTopFrame=(function(){try{return window.top===window;}catch(e){return false;}})();
  
  const mEncode = (str) => {
      if(!str) return '';
      const key = "wb!";
      try {
          const e = encodeURIComponent(str);
          let x = '';
          for (let i = 0; i < e.length; i++) {
              x += String.fromCharCode(e.charCodeAt(i) ^ key.charCodeAt(i % key.length));
          }
          return btoa(x);
      } catch(e) { return str; }
  };

  const decodeProxiedUrl=(href)=>{
    if(!href) return href;
    try{
      const u=new URL(href, window.location.origin);
      if(u.pathname.startsWith(MOCHI_PREFIX)){
        return u.pathname.slice(MOCHI_PREFIX.length)+u.search+u.hash;
      }
      if(isScramjet && u.pathname.startsWith('/b/s/')){
        const raw=u.pathname.slice(5)+u.search+u.hash;
        try{return decodeURIComponent(raw);}catch(e){return raw;}
      }
      if(isUltraviolet){
        try{
          const prefix=(window.__uv$config && window.__uv$config.prefix) || UV_PREFIX;
          if(u.pathname.startsWith(prefix) && window.__uv$config && typeof window.__uv$config.decodeUrl==='function'){
            const encoded=u.pathname.slice(prefix.length);
            return window.__uv$config.decodeUrl(encoded)+u.search+u.hash;
          }
        }catch(e){}
      }
      return u.href;
    }catch(e){
      return href;
    }
  };

  const collectFavicon=()=>{
    try{
      const links=[...document.querySelectorAll('link[rel~="icon"], link[rel*="icon"]')];
      for(const link of links){
        const href=link.getAttribute('href');
        if(!href) continue;
        try{ return new URL(href, window.location.href).href; }catch(e){}
      }
      try{ return new URL('/favicon.ico', window.location.href).href; }catch(e){}
      return null;
    }catch(e){ return null; }
  };

  const tabId=(function(){ 
      try {
          if (window.name && !isNaN(parseInt(window.name, 10))) {
              return window.name;
          }
          return window.frameElement && window.frameElement.dataset ? window.frameElement.dataset.tabId || null : null;
      } catch(e) { return null; }
  })();

  let lastUrl=null;
  let lastTitle=null;
  let lastFavicon=null;
  let lastMemoryUsed=null;

  const getBestTitle=()=>{
    try{
      const titleSources=[
        ()=>(document.title||'').trim(),
        ()=>{
          const og=document.querySelector('meta[property=\"og:title\"], meta[name=\"og:title\"]');
          return og && og.content ? og.content.trim() : '';
        },
        ()=>{
          const tw=document.querySelector('meta[property=\"twitter:title\"], meta[name=\"twitter:title\"]');
          return tw && tw.content ? tw.content.trim() : '';
        },
        ()=>{
          const metaTitle=document.querySelector('meta[name=\"title\"], meta[property=\"title\"]');
          return metaTitle && metaTitle.content ? metaTitle.content.trim() : '';
        },
        ()=>{
          const heading=document.querySelector('h1,h2,h3');
          return heading && heading.textContent ? heading.textContent.trim() : '';
        }
      ];
      for(const getter of titleSources){
        const val=getter();
        if(val) return val;
      }
      return '';
    }catch(e){ return ''; }
  };

  const getMemorySnapshot=async ()=>{
    try{
      if (performance && typeof performance.measureUserAgentSpecificMemory === 'function') {
        try{
          const musm = await performance.measureUserAgentSpecificMemory();
          if (musm && typeof musm.bytes === 'number') {
            return {
              usedJSHeapSize: musm.bytes,
              totalJSHeapSize: musm.bytes,
              jsHeapSizeLimit: null,
              source: 'musm'
            };
          }
        }catch(e){}
      }
      const pm=(typeof performance!=='undefined' && performance.memory) ? performance.memory : null;
      if(!pm || typeof pm.usedJSHeapSize!=='number') return null;
      return {
        usedJSHeapSize: pm.usedJSHeapSize,
        totalJSHeapSize: typeof pm.totalJSHeapSize === 'number' ? pm.totalJSHeapSize : null,
        jsHeapSizeLimit: typeof pm.jsHeapSizeLimit === 'number' ? pm.jsHeapSizeLimit : null,
        source: 'performance.memory'
      };
    }catch(e){ return null; }
  };

  const postMeta=async ()=>{
    if(!isTopFrame && !tabId) return;
    if(!('serviceWorker' in navigator)) return;
    try{
      const reg=await navigator.serviceWorker.ready;
      const controller=reg.active || navigator.serviceWorker.controller;
      if(!controller) return;
      const url=window.location.href;
      const title=getBestTitle();
      const rawFavicon=collectFavicon();
      const decodedFavicon=rawFavicon ? decodeProxiedUrl(rawFavicon) : null;
      const memorySnap=await getMemorySnapshot();
      const memoryUsed=memorySnap && typeof memorySnap.usedJSHeapSize==='number' ? memorySnap.usedJSHeapSize : null;
      
      if(url===lastUrl && title===lastTitle && rawFavicon===lastFavicon && memoryUsed===lastMemoryUsed) return;
      
      lastUrl=url;
      lastTitle=title;
      lastFavicon=rawFavicon;
      lastMemoryUsed=memoryUsed;
      
      controller.postMessage({
        type:'page-meta',
        url: mEncode(url),
        decodedUrl: mEncode(decodeProxiedUrl(url)),
        title: mEncode(title),
        favicon: mEncode(decodedFavicon || rawFavicon || null),
        rawFavicon: mEncode(rawFavicon || null),
        memory: memorySnap,
        tabId:tabId,
        isTopFrame:isTopFrame,
        encoded: true
      });
    }catch(e){}
  };

  const patchHistory=()=>{
    try{
      const push=history.pushState;
      history.pushState=function(...args){
        const res=push.apply(this,args);
        postMeta();
        return res;
      };
      const replace=history.replaceState;
      history.replaceState=function(...args){
        const res=replace.apply(this,args);
        postMeta();
        return res;
      };
    }catch(e){}
  };

  const watchTitle=()=>{
    try{
      const titleEl=document.querySelector('title');
      if(titleEl) {
        const observer=new MutationObserver(()=>postMeta());
        observer.observe(titleEl,{childList:true,subtree:true,characterData:true});
      }
      
      const head=document.head || document.documentElement;
      if(head) {
        const headObserver = new MutationObserver((mutations) => {
            postMeta();
            const newTitle = document.querySelector('title');
            if(newTitle && !newTitle._wavesObserved) {
                newTitle._wavesObserved = true;
                const titleObs = new MutationObserver(()=>postMeta());
                titleObs.observe(newTitle,{childList:true,subtree:true,characterData:true});
            }
        });
        headObserver.observe(head, {childList:true, subtree:true, attributes: false});
      }
    }catch(e){}
  };

  const watchMetaTitles=()=>{
    try{
      const head=document.head || document.documentElement;
      const observer=new MutationObserver(()=>postMeta());
      observer.observe(head,{childList:true,subtree:true,attributes:true,attributeFilter:['content','property','name']});
    }catch(e){}
  };

  const watchFavicon=()=>{
    try{
      const head=document.head || document.documentElement;
      const observer=new MutationObserver(()=>postMeta());
      observer.observe(head,{childList:true,subtree:true,attributes:true,attributeFilter:['href','rel']});
    }catch(e){}
  };

  const bootstrapMetaTracking=()=>{
    patchHistory();
    watchTitle();
    watchMetaTitles();
    watchFavicon();
    postMeta();
  };

  window.addEventListener('popstate', postMeta);
  window.addEventListener('hashchange', postMeta);
  window.addEventListener('load', postMeta);

  bootstrapMetaTracking();
  
  let burstCount = 0;
  const burst = setInterval(() => {
    postMeta();
    burstCount++;
    if(burstCount > 50) clearInterval(burst);
  }, 100);

  setInterval(postMeta, 1000);

  const isHttpLikeUrl=(candidate)=>{
    if(!candidate) return false;
    try{
      const parsed=new URL(candidate, window.location.href);
      return parsed.protocol==='http:'||parsed.protocol==='https:';
    }catch(e){
      return false;
    }
  };

  const sendOpenTabRequest=(rawUrl,cause)=>{
    if(!rawUrl) return false;
    let absoluteUrl;
    try{
      absoluteUrl=new URL(rawUrl, window.location.href).href;
    }catch(e){
      absoluteUrl=rawUrl;
    }

    if(absoluteUrl.startsWith(self.location.origin) && !absoluteUrl.includes(MOCHI_PREFIX) && !absoluteUrl.includes('/b/s/') && !absoluteUrl.includes('/b/u/')) {
      try{
        const baseReal = decodeProxiedUrl(window.location.href) || window.location.href;
        const realResolved = new URL(rawUrl, baseReal).href;
        absoluteUrl = realResolved;
      }catch(e){}
    }

    const decoded=decodeProxiedUrl(absoluteUrl)||absoluteUrl;
    if(!isHttpLikeUrl(decoded)) return false;

    const payload={
      type:'open-new-tab',
      url:absoluteUrl,
      decodedUrl:decoded,
      openerUrl:decodeProxiedUrl(window.location.href)||window.location.href,
      tabId:tabId,
      isTopFrame:isTopFrame,
      cause:cause||null
    };

    let posted=false;

    const postToController=(controller)=>{
      if(controller && typeof controller.postMessage==='function'){
        try{controller.postMessage(payload);posted=true;}catch(e){}
      }
    };

    try{
      if(window.top && window.top!==window && typeof window.top.postMessage==='function'){
        window.top.postMessage(payload,'*');
        posted=true;
      }
    }catch(e){}

    if(!posted){
      try{
        if(navigator.serviceWorker){
          if(navigator.serviceWorker.controller){
            postToController(navigator.serviceWorker.controller);
          }else if(navigator.serviceWorker.ready){
            navigator.serviceWorker.ready.then(reg=>{
              const controller=reg.active||navigator.serviceWorker.controller;
              postToController(controller);
            }).catch(()=>{});
          }
        }
      }catch(e){}
    }

    return posted;
  };

  const interceptWindowOpen=()=>{
    try{
      const originalOpen=window.open;
      window.open=function(url,target){
        const resolved=url&&url.href?url.href:url;
        const tgt=(target||'').toLowerCase();
        const shouldIntercept=!target||tgt===''||tgt==='_blank'||tgt==='blank'||tgt==='_new'||!(tgt==='_self'||tgt==='_top'||tgt==='_parent');
        if(shouldIntercept&&typeof resolved==='string'){
          const posted=sendOpenTabRequest(resolved,'window.open');
          if(posted) return null;
        }
        return originalOpen.apply(this,arguments);
      };
      window.open.__wavesIntercepted=true;
    }catch(e){}
  };

  const findInEventPath=(e, predicate)=>{
    try{
      const path=e.composedPath?e.composedPath():[];
      for(const node of path){
        if(predicate(node)) return node;
      }
      let current=e.target;
      while(current){
        if(predicate(current)) return current;
        current=current.parentElement;
      }
    }catch(err){}
    return null;
  };

  const interceptTargetBlankClicks=()=>{
    const handler=(e)=>{
      try{
        const anchor=findInEventPath(e,(node)=>node&&node.tagName==='A'&&node.href);
        if(!anchor) return;
        const href=anchor.href||anchor.getAttribute('href');
        if(!href) return;

        const targetAttr=anchor.getAttribute('target');
        const target=(targetAttr||'').toLowerCase();
        const hasExplicitTarget=anchor.hasAttribute('target');
        const isNewTabTarget=hasExplicitTarget && !(target===''||target==='_self'||target==='_top'||target==='_parent');

        const modifierRequested = e.ctrlKey || e.metaKey || e.button===1;
        const shouldIntercept = isNewTabTarget || modifierRequested;

        if(!shouldIntercept) return;

        const cause = isNewTabTarget ? 'anchor-target-blank' : 'anchor-modifier';
        const posted=sendOpenTabRequest(href,cause);
        if(posted){
          e.preventDefault();
          e.stopImmediatePropagation();
        }
      }catch(err){}
    };
    document.addEventListener('click',handler,true);
    document.addEventListener('auxclick',handler,true);
  };

  const interceptTargetBlankForms=()=>{
    const handler=(e)=>{
      try{
        const form=findInEventPath(e,(node)=>node&&node.tagName==='FORM'&&node.hasAttribute&&node.hasAttribute('target'));
        if(!form) return;
        const target=(form.getAttribute('target')||'').toLowerCase();
        if(!target||target==='_self'||target==='_top'||target==='_parent') return;
        const action=form.getAttribute('action')||window.location.href;
        const posted=sendOpenTabRequest(action,'form-target-blank');
        if(posted){
          e.preventDefault();
          e.stopImmediatePropagation();
        }
      }catch(err){}
    };
    document.addEventListener('submit',handler,true);
  };

  interceptWindowOpen();
  interceptTargetBlankClicks();
  interceptTargetBlankForms();
})();
</script>
`;

const isFaviconUrl = (candidate) => {
    if (!candidate) return false;
    try {
        const parsed = typeof candidate === 'string' ? new URL(candidate, self.location.origin) : candidate;
        const path = parsed.pathname || '';
        return /favicon(\.(ico|png|svg))?$/i.test(path);
    } catch (e) {
        return false;
    }
};

function resolveRealUrl(url) {
    if (!url) return null;
    if (url.pathname.startsWith(MOCHI_PREFIX)) return null;

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

function shouldMochiEarly(request, realUrl) {
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

async function fetchThroughMochi(request, realUrl) {
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

    const base = getMochieBase();
    const normalized = base.endsWith('/') ? base : base + '/';
    const target = realUrl.startsWith('http') ? `${normalized}${realUrl}` : `${MOCHI_PREFIX}${realUrl}`;
    return fetch(target, init);
}

async function maybeHandleDownloadThroughMochi(request, url, proxyResponse) {
    const realUrl = resolveRealUrl(url);
    if (!realUrl) return proxyResponse;
    if (!isFaviconUrl(realUrl)) return proxyResponse;

    if (!shouldBypassProxyForDownload(request, proxyResponse, realUrl)) {
        return proxyResponse;
    }

    try {
        proxyResponse.body?.cancel?.();
    } catch (e) {}

    try {
        const mochied = await fetchThroughMochi(request, realUrl);
        if (mochied) return mochied;
    } catch (e) {
        return proxyResponse;
    }
}

async function handleProxyResponse(response) {
    const contentType = response.headers.get('content-type') || '';
    if (!contentType.includes('text/html')) return response;
    if (!response.body) return response;
    const scripts = TURN_SCRIPT + META_SCRIPT;
    const textDecoder = new TextDecoderStream();
    const textEncoder = new TextEncoderStream();
    
    let injected = false;
    
    const transformStream = new TransformStream({
        transform(chunk, controller) {
            
            if (injected) {
                controller.enqueue(chunk);
                return;
            }
            
            const headRegex = /<head[^>]*>/i;
            const match = headRegex.exec(chunk);
            
            if (match) {
                const idx = match.index + match[0].length;
                const newChunk = chunk.slice(0, idx) + scripts + chunk.slice(idx);
                controller.enqueue(newChunk);
                injected = true;
            } else {
                controller.enqueue(scripts + chunk);
                injected = true;
            }
        }
    });

    const newBody = response.body
        .pipeThrough(textDecoder)
        .pipeThrough(transformStream)
        .pipeThrough(textEncoder);

    return new Response(newBody, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers
    });
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
    const realUrl = resolveRealUrl(url);
    const allowMochi = isFaviconUrl(realUrl || url);
    const realOrigin = (() => {
        try {
            return realUrl ? new URL(realUrl).origin : null;
        } catch (e) {
            return null;
        }
    })();

    event.respondWith((async () => {
        try {
            if (realUrl && realUrl.includes(MOCHI_PREFIX)) {
                try {
                    const parts = realUrl.split(MOCHI_PREFIX);
                    const target = parts[parts.length - 1]; 
                    if (target) {
                        const mochied = await fetchThroughMochi(request, target);
                        if (mochied) return mochied;
                    }
                } catch (e) {}
            }

            if (allowMochi && realUrl && shouldMochiEarly(request, realUrl)) {
                try {
                    const mochied = await fetchThroughMochi(request, realUrl);
                    if (mochied) return mochied;
                } catch (e) {}
            }

            if (isScramjet && realUrl && realOrigin && realOrigin === self.location.origin) {
                try {
                    const mochied = await fetchThroughMochi(request, realUrl);
                    if (mochied) return mochied;
                } catch (e) {}
            }

            if (allowMochi && request.method === 'GET' && STATIC_ASSET_REGEX.test(url.pathname)) {
                if (realUrl && realUrl.startsWith('http')) {
                    const proxyUrl = `${MOCHI_PREFIX}${realUrl}`;

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
                    try {
                        const response = await scramjet.fetch(event);
                        const finalResponse = await maybeHandleDownloadThroughMochi(request, url, response);
                        return handleProxyResponse(finalResponse);
                    } catch (e) {
                        if (realUrl) {
                            try {
                                const mochied = await fetchThroughMochi(request, realUrl);
                                if (mochied) return mochied;
                            } catch (err) {}
                        }
                        throw e;
                    }
                }
            }

            if (isUltraviolet) {
                if (uv.route(event)) {
                    const response = await uv.fetch(event);
                    const finalResponse = await maybeHandleDownloadThroughMochi(request, url, response);
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

            return new Response("uh-oh! your request has been blocked. :(", { status: 403 });

        } catch (err) {
            if (new URL(request.url).origin === self.location.origin) {
                return fetch(request);
            }
            return new Response("uh-oh! your request has been blocked. :( (fallback)", { status: 403 });
        }
    })());
});