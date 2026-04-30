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
  '/assets/images/icons/favicon.ico',
  ...'__PRECACHE_ASSETS__'
];

const CACHEABLE_STATIC_EXT = /\.(css|js|mjs|woff2|woff|ttf|otf|eot|png|jpg|jpeg|gif|ico|webp|svg|wasm)$/i;
const DOWNLOAD_EXTENSIONS = new Set([
  '.zip', '.rar', '.7z', '.tar', '.gz', '.tgz', '.bz2', '.xz',
  '.exe', '.msi', '.apk', '.dmg', '.deb', '.rpm',
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
  '.iso', '.img', '.bin', '.msix', '.pkg', '.mp3', '.mp4', '.wav', '.flac', '.mkv', '.mov'
]);

const MAX_RUNTIME_ENTRIES = 300;
const _inflight = new Map();

async function coalescedFetch(key, fetchFn) {
  if (_inflight.has(key)) return _inflight.get(key);
  const p = fetchFn().finally(() => _inflight.delete(key));
  _inflight.set(key, p);
  return p;
}

let isTrimming = false;

async function capCache(cacheName, maxEntries) {
  if (isTrimming) return;
  isTrimming = true;
  try {
    const cache = await caches.open(cacheName);
    const keys = await cache.keys();
    if (keys.length > maxEntries) {
      await Promise.all(keys.slice(0, keys.length - maxEntries).map(k => cache.delete(k)));
    }
  } catch (e) { } finally {
    isTrimming = false;
  }
}

let scramjet;
let uv;
let scramjetConfigLoaded = false;
let scramjetConfigPromise = null;

let metaPending = null;
let metaFlush = null;

async function broadcastMeta() {
  await new Promise((r) => setTimeout(r, 0));
  while (metaPending) {
    const job = metaPending;
    metaPending = null;
    const clients = await self.clients.matchAll({ includeUncontrolled: true, type: 'window' });
    for (let i = 0; i < clients.length; i++) {
      const client = clients[i];
      if (job.sourceId && client.id === job.sourceId) continue;
      try {
        client.postMessage(job.payload);
      } catch (e) { }
    }
  }
  metaFlush = null;
}

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
      clientId: event.source && 'id' in event.source ? event.source.id : null,
      collectedAt: Date.now(),
      encoded: !!data.encoded
    };

    const sourceId = event.source && 'id' in event.source ? event.source.id : null;
    if (event.source && typeof event.source.postMessage === 'function') {
      event.source.postMessage(payload);
    }

    metaPending = { payload, sourceId };
    if (!metaFlush) {
      metaFlush = broadcastMeta();
      event.waitUntil(metaFlush);
    }
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

const SPA_PATCH = `
<script>
(function(){
  function roErr(e){
    try{
      var m=e&&e.message!=null?String(e.message):'';
      if(m.indexOf('ResizeObserver')!==-1)return true;
    }catch(x){}
    return false;
  }
  function roRej(e){
    try{
      var r=e&&e.reason;
      var m=r&&(typeof r.message==='string'?r.message:(r&&r.toString&&r.toString())||'')||'';
      if(String(m).indexOf('ResizeObserver')!==-1)return true;
    }catch(x){}
    return false;
  }
  window.addEventListener('error',function(e){
    if(roErr(e)){
      e.preventDefault();
      e.stopImmediatePropagation();
    }
  },true);
  window.addEventListener('unhandledrejection',function(e){
    if(roRej(e))e.preventDefault();
  });
  var h=location.hostname||'';
  if(h.indexOf('discord.com')!==-1||h.indexOf('discordapp.com')!==-1){
    try{
      window.__SENTRY__={hub:{getClient:function(){return{getOptions:function(){return{};}};}}};
    }catch(x){}
    try{localStorage.setItem('hideMessageRequests','true');}catch(e){}
  }
})();
</script>
`;

const SOUNDCLOUD_PATCH = `
<script>
(function(){
  const MOCHI_PREFIX='${MOCHI_PREFIX}';
  const UV_PREFIX='${UV_PREFIX}';
  const isScramjet=${isScramjet ? 'true' : 'false'};
  const isUltraviolet=${isUltraviolet ? 'true' : 'false'};

  const _MK2='q7Zx!9pL';
  const _xorDec=(s)=>{let o='';for(let i=0;i<s.length;i++){o+=String.fromCharCode(s.charCodeAt(i)^_MK2.charCodeAt(i%_MK2.length));}return o;};

  const decUrl=(href)=>{
    if(!href) return href;
    try{
      const u=new URL(href, window.location.origin);
      if(u.pathname.startsWith(MOCHI_PREFIX)){
        let encodedPart = u.pathname.slice(MOCHI_PREFIX.length);
        if (encodedPart.endsWith('/')) encodedPart = encodedPart.slice(0, -1);

        try {
            let p = encodedPart.replace(/-/g, '+').replace(/_/g, '/');
            while (p.length % 4) { p += '='; }
            let raw = atob(p);
            let dec = _xorDec(raw);
            let result = decodeURIComponent(dec);
            if (result.startsWith('http://') || result.startsWith('https://')) {
                return result + u.search + u.hash;
            }
        } catch(e) {}

        if (encodedPart.startsWith('http://') || encodedPart.startsWith('https://')) {
            return encodedPart + u.search + u.hash;
        }
        return encodedPart + u.search + u.hash;
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

  const initSoundcloudPatch=()=>{
    try{
      const onSoundcloud=()=>{
        try{
          const host=(location.hostname||'').toLowerCase();
          if(host.includes('soundcloud.com')) return true;
          const decoded=decUrl(window.location.href)||'';
          if(!decoded) return false;
          return (new URL(decoded)).hostname.toLowerCase().includes('soundcloud.com');
        }catch(e){ return false; }
      };

      if(!onSoundcloud()) return;

      const closeSelector='button.modal__closeButton, .modal.auth-modal button[title="Close"]';
      const authOverlaySelector='#app .sign-in-up-form, #app .connect-form-title-ui-evo, main.vertically-centered-ui-evo';
      const floatingShellSelector='.modalWhiteout, .g-z-index-modal-background, .g-z-index-overlay, .g-backdrop-filter-grayscale';
      const authIframeSelector='iframe[src*="secure.soundcloud.com/web-auth"], iframe[scramjet-attr-src*="secure.soundcloud.com/web-auth"], iframe[src*="embedded_in_iframe=true"], iframe[scramjet-attr-src*="embedded_in_iframe=true"]';
      const promotionBannerSelector='div.banner.m-promotion, .banner.m-promotion.primary, .banner.l-inner-fullwidth.primary';

      const hideOrRemoveModal=(fromButton)=>{
        try{
          const modal=fromButton ? fromButton.closest('.modal.auth-modal, .modal') : null;
          if(!modal) return;
          modal.style.setProperty('display','none','important');
          modal.style.setProperty('visibility','hidden','important');
          modal.style.setProperty('opacity','0','important');
          if(modal.parentNode) modal.parentNode.removeChild(modal);
        }catch(err){}
      };

      const resetPageLock=()=>{
        try{
          const pageNodes=[document.documentElement, document.body];
          for(const node of pageNodes){
            if(!node || !node.style) continue;
            node.style.removeProperty('overflow');
            node.style.removeProperty('overflow-y');
            node.style.removeProperty('padding-right');
            node.style.removeProperty('position');
          }
        }catch(err){}
      };

      const removeFloatingShells=()=>{
        try{
          const shells=document.querySelectorAll(floatingShellSelector);
          for(const shell of shells){
            if(!shell) continue;
            const hasAuthContent=shell.querySelector('.sign-in-up-form, .connect-form-title-ui-evo, button.modal__closeButton');
            const isDetachedOverlay=!hasAuthContent;
            if(isDetachedOverlay){
              shell.style.setProperty('display','none','important');
              shell.style.setProperty('visibility','hidden','important');
              shell.style.setProperty('opacity','0','important');
              if(shell.parentNode) shell.parentNode.removeChild(shell);
            }
          }
        }catch(err){}
      };

      const removeEmptyAppShell=()=>{
        try{
          const app=document.getElementById('app');
          if(!app) return;
          const first=app.firstElementChild;
          if(first && app.childElementCount===1 && first.childElementCount===0){
            first.style.setProperty('display','none','important');
            first.style.setProperty('visibility','hidden','important');
            first.style.setProperty('opacity','0','important');
            if(first.parentNode) first.parentNode.removeChild(first);
          }
          const text=(app.textContent||'').trim();
          if(app.childElementCount===0 && !text){
            app.style.setProperty('display','none','important');
            app.style.setProperty('visibility','hidden','important');
            app.style.setProperty('opacity','0','important');
            if(app.parentNode) app.parentNode.removeChild(app);
          }
        }catch(err){}
      };

      const removeAuthOverlay=()=>{
        try{
          const hit=document.querySelector(authOverlaySelector);
          if(!hit) return;
          const root=hit.closest('main.vertically-centered-ui-evo') || hit.closest('.vertically-centered-ui-evo') || hit.closest('#app > div') || hit;
          if(!root) return;
          root.style.setProperty('display','none','important');
          root.style.setProperty('visibility','hidden','important');
          root.style.setProperty('opacity','0','important');
          root.style.setProperty('pointer-events','none','important');
          if(root.parentNode) root.parentNode.removeChild(root);
        }catch(err){}
      };

      const removeAuthIframes=()=>{
        try{
          const frames=document.querySelectorAll(authIframeSelector);
          for(const frame of frames){
            if(!frame) continue;
            frame.style.setProperty('display','none','important');
            frame.style.setProperty('visibility','hidden','important');
            frame.style.setProperty('opacity','0','important');
            if(frame.parentNode) frame.parentNode.removeChild(frame);
          }
        }catch(err){}
      };

      const removePromotionBanners=()=>{
        try{
          const banners=document.querySelectorAll(promotionBannerSelector);
          for(const banner of banners){
            if(!banner) continue;
            banner.style.setProperty('display','none','important');
            banner.style.setProperty('visibility','hidden','important');
            banner.style.setProperty('opacity','0','important');
            if(banner.parentNode) banner.parentNode.removeChild(banner);
          }
          document.querySelectorAll('a.targetedGoUpsellBanner__link').forEach((a)=>{
            const b=a && a.closest && a.closest('.banner');
            if(b && b.parentNode) b.parentNode.removeChild(b);
          });
        }catch(err){}
      };

      const closeNow=()=>{
        try{
          const buttons=document.querySelectorAll(closeSelector);
          for(const button of buttons){
            if(!button || button.__wavesAutoClosed) continue;
            button.__wavesAutoClosed=true;
            try{ button.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true,view:window})); }catch(e){}
            try{ button.click(); }catch(e){}
            setTimeout(()=>hideOrRemoveModal(button), 40);
          }
          const orphanModal=document.querySelector('.modal.auth-modal.showBackground, .modal.auth-modal');
          if(orphanModal) hideOrRemoveModal(orphanModal.querySelector('button.modal__closeButton'));
          removeAuthOverlay();
          removeAuthIframes();
          removeFloatingShells();
          removeEmptyAppShell();
          removePromotionBanners();
          resetPageLock();
        }catch(err){}
      };

      closeNow();
      const observer=new MutationObserver(()=>closeNow());
      observer.observe(document.documentElement || document, { childList:true, subtree:true });
      setInterval(closeNow, 150);
    }catch(e){}
  };

  initSoundcloudPatch();
})();
</script>
`;

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

const mochiBase = () => {
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

  const _MK2='q7Zx!9pL';
  const _xorDec=(s)=>{let o='';for(let i=0;i<s.length;i++){o+=String.fromCharCode(s.charCodeAt(i)^_MK2.charCodeAt(i%_MK2.length));}return o;};

  const decUrl=(href)=>{
    if(!href) return href;
    try{
      const u=new URL(href, window.location.origin);
      if(u.pathname.startsWith(MOCHI_PREFIX)){
        let encodedPart = u.pathname.slice(MOCHI_PREFIX.length);
        if (encodedPart.endsWith('/')) encodedPart = encodedPart.slice(0, -1);

        try {
            let p = encodedPart.replace(/-/g, '+').replace(/_/g, '/');
            while (p.length % 4) { p += '='; }
            let raw = atob(p);
            let dec = _xorDec(raw);
            let result = decodeURIComponent(dec);
            if (result.startsWith('http://') || result.startsWith('https://')) {
                return result + u.search + u.hash;
            }
        } catch(e) {}

        if (encodedPart.startsWith('http://') || encodedPart.startsWith('https://')) {
            return encodedPart + u.search + u.hash;
        }
        return encodedPart + u.search + u.hash;
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

  const pickIcon=()=>{
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

  let swControllerRef=null;

  let lastUrl=null;
  let lastTitle=null;
  let lastFavicon=null;

  const pageTitle=()=>{
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

  const sendMeta=async ()=>{
    if(!isTopFrame && !tabId) return;
    if(!('serviceWorker' in navigator)) return;
    try{
      let controller=navigator.serviceWorker.controller;
      if(!controller){
        controller=swControllerRef;
      }
      if(!controller){
        const reg=await navigator.serviceWorker.ready;
        controller=reg.active||reg.waiting||reg.installing||navigator.serviceWorker.controller;
        if(controller) swControllerRef=controller;
      } else {
        swControllerRef=controller;
      }
      if(!controller) return;
      const url=window.location.href;
      const title=pageTitle();
      const rawFavicon=pickIcon();
      const decodedFavicon=rawFavicon ? decUrl(rawFavicon) : null;
      
      if (lastUrl === url && lastTitle === title && lastFavicon === rawFavicon) return;
      lastUrl=url;
      lastTitle=title;
      lastFavicon=rawFavicon;
      
      controller.postMessage({
        type:'page-meta',
        url: mEncode(url),
        decodedUrl: mEncode(decUrl(url)),
        title: mEncode(title),
        favicon: mEncode(decodedFavicon || rawFavicon || null),
        rawFavicon: mEncode(rawFavicon || null),
        tabId:tabId,
        isTopFrame:isTopFrame,
        encoded: true
      });
    }catch(e){}
  };

  const runMeta=()=>{ void sendMeta(); };

  let domRafScheduled=false;
  const rAF=typeof requestAnimationFrame==='function'
    ? requestAnimationFrame
    : function(cb){ return setTimeout(cb,16); };

  const metaDom=()=>{
    if(domRafScheduled) return;
    domRafScheduled=true;
    rAF(()=>{
      domRafScheduled=false;
      runMeta();
    });
  };

  const micro=typeof queueMicrotask==='function'
    ? function(fn){ queueMicrotask(fn); }
    : function(fn){ Promise.resolve().then(fn); };

  const metaNav=()=>{
    micro(()=>{ runMeta(); });
    rAF(()=>{
      runMeta();
      rAF(()=>{ runMeta(); });
    });
  };

  const hookHistory=()=>{
    try{
      const push=history.pushState;
      history.pushState=function(...args){
        const res=push.apply(this,args);
        metaNav();
        return res;
      };
      const replace=history.replaceState;
      history.replaceState=function(...args){
        const res=replace.apply(this,args);
        metaNav();
        return res;
      };
    }catch(e){}
  };

  const bindTitle=(el)=>{
    try{
      if(!el||el._wavesObserved) return;
      el._wavesObserved=true;
      const o=new MutationObserver(()=>metaDom());
      o.observe(el,{childList:true,subtree:true,characterData:true});
    }catch(e){}
  };

  const headHit=(mutations)=>{
    try{
      for(let i=0;i<mutations.length;i++){
        const m=mutations[i];
        const t=m.target;
        if(!t) continue;
        if(m.type==='characterData'){
          const p=t.parentElement;
          if(p&&p.nodeName&&p.nodeName.toUpperCase()==='TITLE') return true;
          continue;
        }
        if(m.type==='attributes'){
          const n=t.nodeName&&t.nodeName.toUpperCase();
          if(n==='META'||n==='LINK'||n==='TITLE') return true;
          continue;
        }
        if(m.type==='childList'){
          const tn=t.nodeName&&t.nodeName.toUpperCase();
          if(tn==='TITLE'||tn==='META'||tn==='LINK') return true;
          if(tn==='HEAD'){
            const nodes=m.addedNodes;
            for(let j=0;j<nodes.length;j++){
              const nn=nodes[j]&&nodes[j].nodeName&&nodes[j].nodeName.toUpperCase();
              if(nn==='TITLE'||nn==='META'||nn==='LINK') return true;
            }
            const removed=m.removedNodes;
            for(let k=0;k<removed.length;k++){
              const rn=removed[k]&&removed[k].nodeName&&removed[k].nodeName.toUpperCase();
              if(rn==='TITLE'||rn==='META'||rn==='LINK') return true;
            }
          }
        }
      }
    }catch(e){}
    return false;
  };

  const watchHead=()=>{
    try{
      bindTitle(document.querySelector('title'));
      const head=document.head || document.documentElement;
      if(!head||head._wavesHeadObserved) return;
      head._wavesHeadObserved=true;
      const headObs=new MutationObserver((mutations)=>{
        if(!headHit(mutations)) return;
        metaDom();
        bindTitle(document.querySelector('title'));
      });
      headObs.observe(head,{childList:true,subtree:true,attributes:true,attributeFilter:['content','property','name','href','rel']});
    }catch(e){}
  };

  const start=()=>{
    if (!isScramjet && !isUltraviolet) {
        hookHistory();
    }
    try{
      if('serviceWorker' in navigator){
        navigator.serviceWorker.addEventListener('controllerchange',()=>{
          swControllerRef=navigator.serviceWorker.controller;
        });
      }
    }catch(e){}
    watchHead();
    metaNav();
  };

  window.addEventListener('popstate', metaNav);
  window.addEventListener('hashchange', metaNav);
  window.addEventListener('load', metaNav);

  start();
  
  let burstCount = 0;
  const burst = setInterval(() => {
    metaNav();
    burstCount++;
    if(burstCount > 16) clearInterval(burst);
  }, 72);

  setInterval(()=>{
    if(document.visibilityState!=='visible') return;
    metaDom();
  }, 450);

  const httpOk=(candidate)=>{
    if(!candidate) return false;
    try{
      const parsed=new URL(candidate, window.location.href);
      return parsed.protocol==='http:'||parsed.protocol==='https:';
    }catch(e){
      return false;
    }
  };

  const openTab=(rawUrl,cause)=>{
    if(!rawUrl) return false;
    let absoluteUrl;
    try{
      absoluteUrl=new URL(rawUrl, window.location.href).href;
    }catch(e){
      absoluteUrl=rawUrl;
    }

    if(absoluteUrl.startsWith(self.location.origin) && !absoluteUrl.includes(MOCHI_PREFIX) && !absoluteUrl.includes('/b/s/') && !absoluteUrl.includes('/b/u/')) {
      try{
        const baseReal = decUrl(window.location.href) || window.location.href;
        const realResolved = new URL(rawUrl, baseReal).href;
        absoluteUrl = realResolved;
      }catch(e){}
    }

    const decoded=decUrl(absoluteUrl)||absoluteUrl;
    if(!httpOk(decoded)) return false;

    const payload={
      type:'open-new-tab',
      url:absoluteUrl,
      decodedUrl:decoded,
      openerUrl:decUrl(window.location.href)||window.location.href,
      tabId:tabId,
      isTopFrame:isTopFrame,
      cause:cause||null
    };

    let posted=false;

    const swPost=(controller)=>{
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
            swPost(navigator.serviceWorker.controller);
          }else if(navigator.serviceWorker.ready){
            navigator.serviceWorker.ready.then(reg=>{
              const controller=reg.active||navigator.serviceWorker.controller;
              swPost(controller);
            }).catch(()=>{});
          }
        }
      }catch(e){}
    }

    return posted;
  };

  const hookOpen=()=>{
    try{
      const originalOpen=window.open;
      window.open=function(url,target){
        const resolved=url&&url.href?url.href:url;
        const tgt=(target||'').toLowerCase();
        const shouldIntercept=!target||tgt===''||tgt==='_blank'||tgt==='blank'||tgt==='_new'||!(tgt==='_self'||tgt==='_top'||tgt==='_parent');
        if(shouldIntercept&&typeof resolved==='string'){
          const posted=openTab(resolved,'window.open');
          if(posted) return null;
        }
        return originalOpen.apply(this,arguments);
      };
      window.open.__wavesIntercepted=true;
    }catch(e){}
  };

  const pathFind=(e, predicate)=>{
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

  const hookClicks=()=>{
    const handler=(e)=>{
      try{
        const anchor=pathFind(e,(node)=>node&&node.tagName==='A'&&node.href);
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
        const posted=openTab(href,cause);
        if(posted){
          e.preventDefault();
          e.stopImmediatePropagation();
        }
      }catch(err){}
    };
    document.addEventListener('click',handler,true);
    document.addEventListener('auxclick',handler,true);
  };

  const hookForms=()=>{
    const handler=(e)=>{
      try{
        const form=pathFind(e,(node)=>node&&node.tagName==='FORM'&&node.hasAttribute&&node.hasAttribute('target'));
        if(!form) return;
        const target=(form.getAttribute('target')||'').toLowerCase();
        if(!target||target==='_self'||target==='_top'||target==='_parent') return;
        const action=form.getAttribute('action')||window.location.href;
        const posted=openTab(action,'form-target-blank');
        if(posted){
          e.preventDefault();
          e.stopImmediatePropagation();
        }
      }catch(err){}
    };
    document.addEventListener('submit',handler,true);
  };

  hookOpen();
  hookClicks();
  hookForms();
})();
</script>
`;

const faviconLike = (candidate) => {
  if (!candidate) return false;
  try {
    const parsed = typeof candidate === 'string' ? new URL(candidate, self.location.origin) : candidate;
    const path = parsed.pathname || '';
    return /favicon(\.(ico|png|svg))?$/i.test(path);
  } catch (e) {
    return false;
  }
};

function unwrapUrl(url) {
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

function urlExt(targetUrl) {
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

async function mochiFetch(request, realUrl) {
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

  const base = mochiBase();
  const normalized = base.endsWith('/') ? base : base + '/';
  const target = realUrl.startsWith('http') ? `${normalized}${realUrl}` : `${MOCHI_PREFIX}${realUrl}`;

  if (init.method === 'GET' || init.method === 'HEAD') {
    return coalescedFetch(target, () => fetch(target, init));
  }
  return fetch(target, init);
}

const MOCHI_TIMEOUT_MS = 15000;
const PROXY_TIMEOUT_MS = 10000;
const PROXY_NAV_TIMEOUT_MS = 12000;
const PROXY_SUBRESOURCE_TIMEOUT_MS = 8000;
const MOCHI_SECONDARY_MS = 12000;

let _lastTransportError = 0;
let _consecutiveProxyFailures = 0;
function notifyTransportError() {
  _consecutiveProxyFailures++;
  const now = Date.now();
  if (now - _lastTransportError < 3000) return;
  _lastTransportError = now;
  self.clients.matchAll({ includeUncontrolled: true, type: 'window' }).then(clients => {
    for (const client of clients) {
      client.postMessage({ type: 'transport-error', failures: _consecutiveProxyFailures });
    }
  });
}

function resetProxyHealth() {
  _consecutiveProxyFailures = 0;
}

async function tryWithTimeout(promise, ms) {
  let timer;
  const timeoutP = new Promise((_, rej) => {
    timer = setTimeout(() => rej(new Error('waves-timeout')), ms);
  });
  try {
    const out = await Promise.race([promise, timeoutP]);
    clearTimeout(timer);
    return out;
  } catch (e) {
    clearTimeout(timer);
    return null;
  }
}

function timeoutFallbackResponse(request, url) {
  const dest = request.destination;
  const isScript = dest === 'script' || (url.pathname || '').toLowerCase().endsWith('.js') || (url.pathname || '').toLowerCase().endsWith('.mjs');
  if (isScript) {
    return new Response('/* upstream timeout! */', {
      status: 200,
      headers: { 'Content-Type': 'application/javascript; charset=utf-8' }
    });
  }
  return new Response('gateway timeout', { status: 504, statusText: 'gateway timeout' });
}

const MAX_HTML_INJECT_BYTES = 4_500_000;

function fixHtmlHeaders(source) {
  const headers = new Headers(source);
  headers.delete('content-encoding');
  headers.delete('content-length');
  headers.delete('transfer-encoding');
  const ct = (source.get('content-type') || '').trim();
  if (/text\/html/i.test(ct)) {
    if (!/charset=/i.test(ct)) {
      headers.set('content-type', ct + '; charset=utf-8');
    }
  } else {
    headers.set('content-type', 'text/html; charset=utf-8');
  }
  return headers;
}

async function patchHtml(response) {
  const contentType = response.headers.get('content-type') || '';
  if (!contentType.includes('text/html') || !response.body) return response;

  try {
    const lenHdr = response.headers.get('content-length');
    if (lenHdr && parseInt(lenHdr, 10) > MAX_HTML_INJECT_BYTES) return response;

    const clonedResponse = response.clone();
    const originalBody = await clonedResponse.text();
    if (originalBody.length > MAX_HTML_INJECT_BYTES) return response;

    const scripts = TURN_SCRIPT + SPA_PATCH + SOUNDCLOUD_PATCH + META_SCRIPT;
    let newBodyStr;
    const lowerBody = originalBody.toLowerCase();
    const headStartIdx = lowerBody.indexOf('<head');

    if (headStartIdx !== -1) {
      const headEndIdx = originalBody.indexOf('>', headStartIdx) + 1;
      newBodyStr = originalBody.substring(0, headEndIdx) + scripts + originalBody.substring(headEndIdx);
    } else {
      newBodyStr = scripts + originalBody;
    }

    return new Response(newBodyStr, {
      status: response.status,
      statusText: response.statusText,
      headers: fixHtmlHeaders(response.headers)
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
    Promise.all([
      caches.keys().then(keys => {
        return Promise.all(
          keys.filter(k => k.startsWith('waves-') && k !== SHELL_CACHE && k !== RUNTIME_CACHE)
            .map(k => caches.delete(k))
        );
      }),
      self.registration.navigationPreload ? self.registration.navigationPreload.enable() : Promise.resolve()
    ]).then(() => self.clients.claim())
  );
});

const ADBLOCK_LISTS = [
  '/!!/https://raw.githubusercontent.com/hagezi/dns-blocklists/main/domains/pro.txt',
  '/!!/https://pgl.yoyo.org/adservers/serverlist.php?hostformat=nohtml&showintro=0&mimetype=plaintext',
  '/!!/https://s3.amazonaws.com/lists.disconnect.me/simple_ad.txt',
  '/!!/https://s3.amazonaws.com/lists.disconnect.me/simple_tracking.txt'
];

let adblockDomains = new Set();
let isAdblockReady = false;
let adblockInitPromise = null;

async function loadAdLists() {
  try {
    const listCache = await caches.open('waves-adblock-v1');
    const newDomains = new Set(['doubleclick.net', 'google-analytics.com']);

    await Promise.all(ADBLOCK_LISTS.map(async (url) => {
      try {
        let text = '';
        let cached = await listCache.match(url);
        let shouldFetch = !cached;

        if (cached && !shouldFetch) {
          const dateStr = cached.headers.get('date');
          const age = dateStr ? (Date.now() - new Date(dateStr).getTime()) : Infinity;
          if (age > 86400000) shouldFetch = true;
        }

        if (shouldFetch) {
          const ctrl = new AbortController();
          const timeoutId = setTimeout(() => ctrl.abort(), 3000);
          try {
            const res = await fetch(url, { signal: ctrl.signal });
            clearTimeout(timeoutId);
            if (res.ok) {
              text = await res.text();
              listCache.put(url, new Response(text, {
                 headers: { 'date': new Date().toUTCString(), 'content-type': 'text/plain' }
              })).catch(() => {});
            } else if (cached) {
              text = await cached.text();
            }
          } catch(e) {
            if (cached) text = await cached.text();
          }
        } else {
          text = await cached.text();
        }

        if (!text) return;

        let start = 0;
        let end = text.indexOf('\n');
        
        while (end !== -1) {
          let line = text.substring(start, end).trim();
          start = end + 1;
          end = text.indexOf('\n', start);
          
          if (!line || line[0] === '#') continue;
          
          const hashIdx = line.indexOf('#');
          if (hashIdx !== -1) line = line.substring(0, hashIdx).trim();
          
          if (line.startsWith('0.0.0.0 ')) {
             const domain = line.substring(8).trim();
             if (domain && domain !== '0.0.0.0') newDomains.add(domain);
          } else if (line.startsWith('127.0.0.1 ')) {
             const domain = line.substring(10).trim();
             if (domain && domain !== 'localhost') newDomains.add(domain);
          } else if (line.indexOf(' ') === -1 && line.indexOf('.') !== -1) {
             newDomains.add(line.toLowerCase());
          }
        }
      } catch (err) {}
    }));
    
    adblockDomains = newDomains;
    isAdblockReady = true;
  } catch (globalErr) {}
}

function readyAds() {
  if (isAdblockReady) return Promise.resolve();
  if (!adblockInitPromise) {
    adblockInitPromise = loadAdLists();
  }
  return adblockInitPromise;
}

readyAds();

const _AD_MK2 = 'q7Zx!9pL';
const _adXorDec = (s) => {
    let o = '';
    for (let i = 0; i < s.length; i++) {
        o += String.fromCharCode(s.charCodeAt(i) ^ _AD_MK2.charCodeAt(i % _AD_MK2.length));
    }
    return o;
};

const ADBLOCK_KEYWORDS = [
  '/ads/', '/adserver/', '/adtracking/', '-ad-track.', '/analytics.js', '/tracking.js', '/pixel.js',
  '/gpt.js', '/prebid.js', '/ads.min.js', '/ad-script.js', '/tracker.js', '/beacon.js', '/events.js',
  '/gtm.js', '/fbevents.js', '/insight.min.js', '/beacon.min.js', 'banner_ad', 'google_ads',
  '/pagead/', '/ad/g/cors', 'pagead2.googlesyndication.com', 'doubleclick.net', 'adsystem.com',
  'yandex.ru/metrika', 'vk.com/rtrg', 'clarity.ms', 'tracking/pixel', '/track/event'
];

const ADBLOCK_SKIP = [
  'archiveofourown.org'
];

function adblockSkip(hostname) {
  const h = (hostname || '').toLowerCase();
  for (let i = 0; i < ADBLOCK_SKIP.length; i++) {
    const s = ADBLOCK_SKIP[i];
    if (h === s || (s && h.endsWith('.' + s))) return true;
  }
  return false;
}

function adTarget(requestUrl) {
    try {
        const u = new URL(requestUrl);
        if (u.origin !== self.location.origin) return u.href;

        if (u.pathname.startsWith(MOCHI_PREFIX)) {
            let encodedPart = u.pathname.slice(MOCHI_PREFIX.length);
            if (encodedPart.endsWith('/')) encodedPart = encodedPart.slice(0, -1);
            try {
                let p = encodedPart.replace(/-/g, '+').replace(/_/g, '/');
                while (p.length % 4) { p += '='; }
                let raw = atob(p);
                let dec = _adXorDec(raw);
                let result = decodeURIComponent(dec);
                if (result.startsWith('http')) return result;
            } catch(e) {}
            if (encodedPart.startsWith('http')) return encodedPart;
        }

        if (typeof isScramjet !== 'undefined' && isScramjet && u.pathname.startsWith('/b/s/')) {
            const raw = u.pathname.slice(5) + u.search;
            const httpIndex = raw.indexOf('http');
            if (httpIndex !== -1) {
                const candidate = raw.substring(httpIndex);
                try { return decodeURIComponent(candidate); } catch(e) { return candidate; }
            }
        }

        if (typeof isUltraviolet !== 'undefined' && isUltraviolet && self.__uv$config && typeof self.__uv$config.decodeUrl === 'function') {
            const prefix = self.__uv$config.prefix || '/b/u/hi/';
            if (u.pathname.startsWith(prefix)) {
                try { return self.__uv$config.decodeUrl(u.pathname.slice(prefix.length)); } catch(e) {}
            }
        }
    } catch(e) {}
    return requestUrl;
}

function adBlocked(candidate, isNavigate) {
  if (!isAdblockReady) return false;
  if (!candidate) return false;
  try {
    const candidateUrl = new URL(candidate);
    const host = candidateUrl.hostname.toLowerCase();
    
    let parts = host.split('.');
    for (let i = 0; i < parts.length - 1; i++) {
        if (adblockDomains.has(parts.slice(i).join('.'))) return true;
    }
    
    if (host === self.location.hostname) return false;

    if (!isNavigate && !adblockSkip(host)) {
        const pathInfo = (candidateUrl.pathname + candidateUrl.search).toLowerCase();
        for (const kw of ADBLOCK_KEYWORDS) {
            if (pathInfo.includes(kw)) return true;
        }
    }
    
    return false;
  } catch(e) {
    return false;
  }
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  const isNavigate = request.mode === 'navigate' || request.destination === 'document';
  
  const url = new URL(request.url);

  if (adBlocked(adTarget(request.url), isNavigate)) {
    const dest = request.destination;
    const accept = request.headers.get('Accept') || '';
    
    let body = ':3';
    let contentType = 'text/plain';

    if (dest === 'script' || url.pathname.endsWith('.js')) {
      body = 'window.ga=function(){return":3"};window.ga.q=[":3"];window.dataLayer=[":3"];window.dataLayer.push=function(){return":3"};window.fbq=function(){return":3"};window.googletag={cmd:{push:function(){return":3"}}};window._paq=[":3"];window._paq.push=function(){return":3"};';
      contentType = 'application/javascript';
    } else if (dest === 'image' || accept.includes('image/')) {
      body = new Uint8Array([71, 73, 70, 56, 57, 97, 1, 0, 1, 0, 128, 0, 0, 0, 0, 0, 255, 255, 255, 33, 249, 4, 1, 0, 0, 0, 0, 44, 0, 0, 0, 0, 1, 0, 1, 0, 0, 2, 2, 68, 1, 0, 59]);
      contentType = 'image/gif';
    } else if (isNavigate || dest === 'document') {
      body = '<html><head><title>:3</title></head><body style="display:flex;justify-content:center;align-items:center;height:100vh;margin:0;font-family:monospace;font-size:2rem;">:3</body></html>';
      contentType = 'text/html';
    } else if (accept.includes('application/json')) {
      body = '{"status": ":3", "message": ":3"}';
      contentType = 'application/json';
    }

    return event.respondWith(new Response(body, { 
      status: 200, 
      statusText: ':3',
      headers: { 
        'Content-Type': contentType,
        'Access-Control-Allow-Origin': '*'
      } 
    }));
  }

  const realUrl = unwrapUrl(url);

  if (url.pathname.startsWith(MOCHI_PREFIX)) {
    return;
  }

  if (realUrl && realUrl.includes('/!!/')) {
    const parts = realUrl.split('/!!/');
    const target = parts.pop();
    if (target && target.startsWith('http')) {
      return event.respondWith((async () => {
        const r = await tryWithTimeout(mochiFetch(request, target), MOCHI_TIMEOUT_MS);
        return r || new Response('gateway timeout', { status: 504 });
      })());
    }
  }

  event.respondWith((async () => {
    try {
      const preloadPromise =
        event.preloadResponse && typeof event.preloadResponse.then === 'function'
          ? event.preloadResponse.catch(() => null)
          : Promise.resolve(null);

      if (realUrl && realUrl.startsWith('http')) {
        const ext = urlExt(realUrl);
        const dest = request.destination;
        const accept = request.headers.get('Accept') || '';

        const isCacheableAsset =
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
          ['.css', '.wasm', '.mp4', '.m3u8', '.webm', '.mp3', '.wav', '.ogg', '.aac', '.flac', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.ico', '.woff', '.woff2', '.ttf', '.otf', '.eot'].includes(ext);

        const preferProxyOverMochi =
          (isScramjet || isUltraviolet) &&
          (dest === 'script' || ext === '.js' || ext === '.mjs');

        if (isCacheableAsset && !realUrl.includes(self.location.host) && !preferProxyOverMochi) {
          const cacheMatch = caches.match(request);
          const networkFetch = tryWithTimeout(mochiFetch(request, realUrl), MOCHI_TIMEOUT_MS);

          try {
            const cached = await cacheMatch;
            if (cached) {
              networkFetch.then(fresh => {
                if (fresh && fresh.ok) {
                  caches.open(RUNTIME_CACHE).then(c => {
                    c.put(request, fresh);
                    capCache(RUNTIME_CACHE, MAX_RUNTIME_ENTRIES);
                  });
                }
              }).catch(() => {});
              return cached;
            }

            const mochiResponse = await networkFetch;
            if (mochiResponse && mochiResponse.ok) {
              const clone = mochiResponse.clone();
              caches.open(RUNTIME_CACHE).then(c => {
                c.put(request, clone);
                capCache(RUNTIME_CACHE, MAX_RUNTIME_ENTRIES);
              });
              return mochiResponse;
            }
          } catch (e) {}
        }
      }

      if (isScramjet) {
        if (!scramjetConfigLoaded) {
          if (!scramjetConfigPromise) {
            scramjetConfigPromise = scramjet.loadConfig().then(() => {
              scramjetConfigLoaded = true;
            });
          }
          await scramjetConfigPromise;
        }

        if (url.pathname.startsWith('/b/s/jetty.') && !url.pathname.endsWith('.wasm')) {
          return fetch(request);
        }

        if (scramjet.route(event)) {
          const timeoutMs = isNavigate ? PROXY_NAV_TIMEOUT_MS : PROXY_SUBRESOURCE_TIMEOUT_MS;
          try {
            let response = null;
            const proxyP = scramjet.fetch(event).catch(e => { throw e; });
            const timedProxyP = tryWithTimeout(proxyP, timeoutMs);

            if (isNavigate && realUrl && realUrl.startsWith('http')) {
              const mochiP = tryWithTimeout(mochiFetch(request, realUrl), MOCHI_SECONDARY_MS);
              response = await timedProxyP;
              if (response && response.ok) resetProxyHealth();
              if (!response || (response.status >= 502 && response.status <= 504)) {
                if (!response) notifyTransportError();
                response = await mochiP;
              }
            } else {
              response = await timedProxyP;
              if (response && response.ok) resetProxyHealth();
              if (!response && realUrl && realUrl.startsWith('http')) {
                notifyTransportError();
                response = await tryWithTimeout(mochiFetch(request, realUrl), MOCHI_SECONDARY_MS);
              }
            }

            if (response) return patchHtml(response);
            return timeoutFallbackResponse(request, url);
          } catch (e) {
            notifyTransportError();
            if (realUrl && realUrl.startsWith('http')) {
              const m = await tryWithTimeout(mochiFetch(request, realUrl), MOCHI_SECONDARY_MS);
              if (m) return patchHtml(m);
            }
            return timeoutFallbackResponse(request, url);
          }
        }
      }

      if (isUltraviolet) {
        if (uv.route(event)) {
          const timeoutMs = isNavigate ? PROXY_NAV_TIMEOUT_MS : PROXY_SUBRESOURCE_TIMEOUT_MS;
          try {
            let response = null;
            const proxyP = uv.fetch(event).catch(e => { throw e; });
            const timedProxyP = tryWithTimeout(proxyP, timeoutMs);

            if (isNavigate && realUrl && realUrl.startsWith('http')) {
              const mochiP = tryWithTimeout(mochiFetch(request, realUrl), MOCHI_SECONDARY_MS);
              response = await timedProxyP;
              if (response && response.ok) resetProxyHealth();
              if (!response || (response.status >= 502 && response.status <= 504)) {
                if (!response) notifyTransportError();
                response = await mochiP;
              }
            } else {
              response = await timedProxyP;
              if (response && response.ok) resetProxyHealth();
              if (!response && realUrl && realUrl.startsWith('http')) {
                notifyTransportError();
                response = await tryWithTimeout(mochiFetch(request, realUrl), MOCHI_SECONDARY_MS);
              }
            }

            if (response) return patchHtml(response);
            return timeoutFallbackResponse(request, url);
          } catch (e) {
            notifyTransportError();
            if (realUrl && realUrl.startsWith('http')) {
              const m = await tryWithTimeout(mochiFetch(request, realUrl), MOCHI_SECONDARY_MS);
              if (m) return patchHtml(m);
            }
            return timeoutFallbackResponse(request, url);
          }
        }
      }

      if (url.origin === self.location.origin && request.method === 'GET') {
        const path = url.pathname;

        if (request.destination === 'document' || path === '/' || path.endsWith('.html')) {
          let networkRes = null;
          try {
            const preloaded = await preloadPromise;
            if (preloaded && (preloaded.ok || preloaded.status === 304)) {
              networkRes = preloaded;
            } else {
              networkRes = await fetch(request).catch(() => null);
            }
          } catch (e) {
            networkRes = await fetch(request).catch(() => null);
          }

          if (networkRes && networkRes.ok) {
            const clone = networkRes.clone();
            caches.open(SHELL_CACHE).then((c) => c.put(request, clone).catch(() => {}));
            return networkRes;
          }
          if (networkRes && networkRes.status === 304) {
            return networkRes;
          }

          const cached = await caches.match(request);
          if (cached) return cached;

          if (networkRes) return networkRes;

          return new Response('offline', { status: 503 });
        }

        if (CACHEABLE_STATIC_EXT.test(path) || path.startsWith('/assets/') || path.startsWith('/bmux/') || path.startsWith('/epoxy/') || path.startsWith('/libcurl/') || path.startsWith('/s/')) {
          const isHashed = /[-_.][a-f0-9]{6,16}\.\w+$/i.test(path);

          const cached = await caches.match(request);
          if (cached) {
            if (!isHashed) {
              fetch(request).then(res => {
                if (res && res.ok) {
                  caches.open(RUNTIME_CACHE).then(c => {
                    c.put(request, res);
                    capCache(RUNTIME_CACHE, MAX_RUNTIME_ENTRIES);
                  });
                }
              }).catch(() => {});
            }
            return cached;
          }

          const res = await fetch(request).catch(() => null);
          if (res && res.ok) {
            const clone = res.clone();
            caches.open(RUNTIME_CACHE).then(c => {
              c.put(request, clone);
              capCache(RUNTIME_CACHE, MAX_RUNTIME_ENTRIES);
            });
            return res;
          }
          if (res) return res;
        }

        return await fetch(request);
      }

      return new Response(":3", { status: 403 });

    } catch (err) {
      if (realUrl && !realUrl.includes(self.location.host)) {
        const mf = await tryWithTimeout(mochiFetch(request, realUrl), MOCHI_TIMEOUT_MS);
        if (mf) return mf;
      }
      const fallback = await caches.match(request);
      if (fallback) return fallback;
      return new Response("error", { status: 500 });
    }
  })());
});