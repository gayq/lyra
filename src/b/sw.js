

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

const CACHE_VERSION = '__BUILD_ID__';
const SHELL_CACHE = 'waves-shell-' + CACHE_VERSION;
const RUNTIME_CACHE = 'waves-runtime-' + CACHE_VERSION;
const PRECACHE_URLS = [
  '/',
  '/assets/images/icons/favicon.ico'
];

const CACHEABLE_STATIC_EXT = /\.(css|js|mjs|woff2|woff|ttf|otf|eot|png|jpg|jpeg|gif|ico|webp|svg|wasm)$/i;
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
  const MOCHI_PREFIX='${MOCHI_PREFIX}';
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
    if (!isScramjet && !isUltraviolet) {
        patchHistory();
    }
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
    if(burstCount > 10) clearInterval(burst);
  }, 200);

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

        if (decoded.includes(self.location.host)) {
          const decodedObj = new URL(decoded);
          if (decodedObj.origin === self.location.origin) {
            return null;
          }
        }

        return new URL(decoded + url.search, 'http://somthing').href.replace('http://somthing', '');
      } catch (e) { }
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
    } catch (e) { }
  }

  const base = getMochiBase();
  const normalized = base.endsWith('/') ? base : base + '/';
  const target = realUrl.startsWith('http') ? `${normalized}${realUrl}` : `${MOCHI_PREFIX}${realUrl}`;
  return fetch(target, init);
}

async function handleProxyResponse(response) {
  const contentType = response.headers.get('content-type') || '';
  if (!contentType.includes('text/html')) return response;
  if (!response.body) return response;

  try {
    const clonedResponse = response.clone();
    const originalBody = await clonedResponse.text();
    const scripts = TURN_SCRIPT + META_SCRIPT;

    let newBodyStr;
    const headMatch = originalBody.match(/<head[^>]*>/i);

    if (headMatch) {
      const idx = headMatch.index + headMatch[0].length;
      newBodyStr = originalBody.slice(0, idx) + scripts + originalBody.slice(idx);
    } else {
      newBodyStr = scripts + originalBody;
    }

    return new Response(newBodyStr, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers
    });
  } catch (e) {
    return response;
  }
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL_CACHE).then(cache => {
      return cache.addAll(PRECACHE_URLS).catch(() => { });
    }).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys().then(keys => {
      return Promise.all(
        keys.filter(k => k.startsWith('waves-') && k !== SHELL_CACHE && k !== RUNTIME_CACHE)
          .map(k => caches.delete(k))
      );
    }).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);
  const realUrl = resolveRealUrl(url);

  if (url.pathname.startsWith(MOCHI_PREFIX)) {
    return;
  }

  if (realUrl && realUrl.includes('/!!/')) {
    const parts = realUrl.split('/!!/');
    const target = parts.pop();
    if (target && target.startsWith('http')) {
      return event.respondWith(fetchThroughMochi(request, target));
    }
  }

  event.respondWith((async () => {
    try {
      if (realUrl && realUrl.startsWith('http')) {
        const ext = getUrlExtension(realUrl);
        const dest = request.destination;
        const accept = request.headers.get('Accept') || '';

        const isHeavyAsset =
          dest === 'video' ||
          dest === 'audio' ||
          dest === 'image' ||
          dest === 'font' ||
          dest === 'track' ||
          accept.startsWith('image/') ||
          accept.startsWith('video/') ||
          accept.startsWith('audio/') ||
          accept.startsWith('font/') ||
          STATIC_ASSET_REGEX.test(url.pathname) ||
          ['.wasm', '.mp4', '.m3u8', '.webm', '.mp3', '.wav', '.ogg', '.aac', '.flac', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.ico', '.woff', '.woff2', '.ttf', '.otf', '.eot'].includes(ext);

        if (isHeavyAsset) {
          try {
            const mochiResponse = await fetchThroughMochi(request, realUrl);
            if (mochiResponse && mochiResponse.ok) {
              return handleProxyResponse(mochiResponse);
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

        if (url.pathname.startsWith('/b/s/jetty.') && !url.pathname.endsWith('.wasm')) {
          return fetch(request);
        }

        if (scramjet.route(event)) {
          try {
            const response = await scramjet.fetch(event);
            return handleProxyResponse(response);
          } catch (e) {
            if (realUrl) return await fetchThroughMochi(request, realUrl);
          }
        }
      }

      if (isUltraviolet) {
        if (uv.route(event)) {
          try {
            const response = await uv.fetch(event);
            return handleProxyResponse(response);
          } catch (e) {
            if (realUrl) return await fetchThroughMochi(request, realUrl);
          }
        }
      }

      if (url.origin === self.location.origin && request.method === 'GET') {
        const path = url.pathname;

        if (request.destination === 'document' || path === '/' || path.endsWith('.html')) {
          const cached = await caches.match(request);
          const networkPromise = fetch(request).then(res => {
            if (res && res.ok) {
              const clone = res.clone();
              caches.open(SHELL_CACHE).then(c => c.put(request, clone));
            }
            return res;
          }).catch(() => null);

          return cached || await networkPromise || new Response('offline', { status: 503 });
        }

        if (CACHEABLE_STATIC_EXT.test(path) || path.startsWith('/assets/') || path.startsWith('/bmux/') || path.startsWith('/epoxy/') || path.startsWith('/libcurl/') || path.startsWith('/s/')) {
          const cached = await caches.match(request);
          if (cached) return cached;

          const res = await fetch(request);
          if (res && res.ok) {
            const clone = res.clone();
            caches.open(RUNTIME_CACHE).then(c => c.put(request, clone));
          }
          return res;
        }

        return await fetch(request);
      }

      return new Response("Blocked", { status: 403 });

    } catch (err) {
      if (realUrl && !realUrl.includes(self.location.host)) {
        return await fetchThroughMochi(request, realUrl);
      }
      const fallback = await caches.match(request);
      if (fallback) return fallback;
      return new Response("Error", { status: 500 });
    }
  })());
});