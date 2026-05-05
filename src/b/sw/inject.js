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
  const isScramjet=${isScramjet ? "true" : "false"};
  const isUltraviolet=${isUltraviolet ? "true" : "false"};
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
          const href=window.location.href||'';
          if(!href) return false;
          try{
            const decoded=decUrl(href)||'';
            if(decoded && decoded.includes('soundcloud.com')) return true;
          }catch(e){}
          try{
            const url=new URL(href);
            const pathname=url.pathname||'';
            if(pathname.includes('soundcloud.com')) return true;
          }catch(e){}
          return false;
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
                urls: "turn:${self.location.hostname}:3478",
                username: "enniuu",
                credential: "enni"
            }];
        }
        return new OriginalRTCPeerConnection(config);
    };
})();
</script>
`;

const TURN_SCRIPT_RELAY = `
<script>
(function() {
    const OriginalRTCPeerConnection = window.RTCPeerConnection;
    if (!OriginalRTCPeerConnection) return;
    const customTurn = {
        urls: "turn:${self.location.hostname}:3478",
        username: "enniuu",
        credential: "enni"
    };
    function WrappedRtc(config, constraints) {
        const c = config ? Object.assign({}, config) : {};
        c.iceTransportPolicy = "relay";
        if (!c.iceServers) c.iceServers = [];
        c.iceServers = c.iceServers.filter(function(server) {
            if (!server || !server.urls) return false;
            var urls = Array.isArray(server.urls) ? server.urls : [server.urls];
            return urls.some(function(url) { return url.startsWith("turn:") || url.startsWith("turns:"); });
        });
        c.iceServers.push(customTurn);
        return constraints !== undefined
            ? new OriginalRTCPeerConnection(c, constraints)
            : new OriginalRTCPeerConnection(c);
    }
    WrappedRtc.prototype = OriginalRTCPeerConnection.prototype;
    try { Object.defineProperty(WrappedRtc, "name", { value: "RTCPeerConnection" }); } catch (e) {}
    window.RTCPeerConnection = WrappedRtc;
})();
</script>
`;

const HOVER_PREFETCH_SCRIPT = `
<script>
(function(){
  if (!("serviceWorker" in navigator)) return;
  var isScramjet = ${isScramjet ? "true" : "false"};
  var isUltraviolet = ${isUltraviolet ? "true" : "false"};
  var DEBOUNCE_MS = 25;
  var maxUrls = 40;
  var sent = Object.create(null);
  var count = 0;
  var t = null;
  var swControllerRef = null;
  function keyHref(h) {
    try { return String(h || "").split("#")[0]; } catch (e) { return ""; }
  }
  function onProxiedSite() {
    try {
      var p = location.pathname || "";
      return p.indexOf("/b/s/") === 0 || p.indexOf("/b/u/") === 0;
    } catch (e) { return false; }
  }
  function proxiedResultUrl(abs) {
    try {
      var u = new URL(abs, location.href);
      if (u.origin === location.origin) {
        var p = u.pathname || "";
        if (p.indexOf("/b/s/r/") === 0) return keyHref(u.href);
        if (p.indexOf("/b/u/") === 0 && p.length > 10) return keyHref(u.href);
        return null;
      }
      if (!onProxiedSite()) return null;
      if (u.protocol !== "http:" && u.protocol !== "https:") return null;
      var raw = keyHref(u.href);
      if (isScramjet) {
        return keyHref(location.origin + "/b/s/r/" + raw);
      }
      if (isUltraviolet && window.__uv$config && typeof window.__uv$config.encodeUrl === "function") {
        var pref = window.__uv$config.prefix || "/b/u/r/";
        return keyHref(location.origin + pref + window.__uv$config.encodeUrl(raw));
      }
      return null;
    } catch (e) { return null; }
  }
  function anchorFromEvent(ev) {
    var t = ev.target;
    if (t && t.closest) {
      var a = t.closest("a[href]");
      if (a) return a;
    }
    var path = ev.composedPath && ev.composedPath();
    if (path) {
      for (var i = 0; i < path.length; i++) {
        var n = path[i];
        if (!n || n.nodeType !== 1) continue;
        if (n.tagName === "A" && n.getAttribute("href")) return n;
      }
    }
    return null;
  }
  function postToSw(worker, url) {
    if (!worker || typeof worker.postMessage !== "function") return false;
    try {
      worker.postMessage({ type: "waves-prefetch", url: url });
      return true;
    } catch (e) {
      return false;
    }
  }
  async function postPrefetch(url) {
    if (!url || sent[url]) return;
    if (count >= maxUrls) return;
    var c = null;
    try { c = navigator.serviceWorker.controller; } catch (e) {}
    if (!c) c = swControllerRef;
    if (!c) {
      try {
        var reg = await navigator.serviceWorker.ready;
        c =
          reg.active ||
          reg.waiting ||
          reg.installing ||
          navigator.serviceWorker.controller;
        if (c) swControllerRef = c;
      } catch (e) {}
    } else {
      swControllerRef = c;
    }
    if (c && postToSw(c, url)) {
      sent[url] = 1;
      count++;
      console.log("requesting prefetch:", url);
      return;
    }
    try {
      if (window.top && window.top !== window) {
        window.top.postMessage(
          { type: "waves-prefetch-bridge", url: url },
          location.origin
        );
        sent[url] = 1;
        count++;
        console.log("bridge prefetch to top window:", url);
        return;
      }
    } catch (e) {}
    console.warn(
      "cannot reach sw (no controller, no top bridge):",
      url
    );
  }
  try {
    console.log("hover listener installed:", location.href);
  } catch (e) {}
  function queuePrefetchFromPointer(ev) {
    var el = anchorFromEvent(ev);
    if (!el) return null;
    var raw = el.getAttribute("href");
    if (!raw || raw.indexOf("javascript:") === 0 || raw === "#") return null;
    var abs;
    try { abs = new URL(raw, location.href).href; } catch (e) { return null; }
    return proxiedResultUrl(abs);
  }
  document.addEventListener("pointerover", function (ev) {
    var prefetchUrl = queuePrefetchFromPointer(ev);
    if (!prefetchUrl) return;
    clearTimeout(t);
    t = setTimeout(function () { void postPrefetch(prefetchUrl); }, DEBOUNCE_MS);
  }, true);
  document.addEventListener("pointerdown", function (ev) {
    var prefetchUrl = queuePrefetchFromPointer(ev);
    if (!prefetchUrl) return;
    void postPrefetch(prefetchUrl);
  }, true);
})();
</script>
`;

const META_SCRIPT = `
<script>
(function(){
  const MOCHI_PREFIX='${MOCHI_PREFIX}';
  const UV_PREFIX='${UV_PREFIX}';
  const isScramjet=${isScramjet ? "true" : "false"};
  const isUltraviolet=${isUltraviolet ? "true" : "false"};
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

const INJECT_PATCHES_STANDARD =
  TURN_SCRIPT + SPA_PATCH + SOUNDCLOUD_PATCH + HOVER_PREFETCH_SCRIPT + META_SCRIPT;
const INJECT_PATCHES_RELAY =
  TURN_SCRIPT_RELAY + SPA_PATCH + SOUNDCLOUD_PATCH + HOVER_PREFETCH_SCRIPT + META_SCRIPT;

function buildHtmlInjectPatches(upstreamUrlStr) {
  const host = upstreamHostname(upstreamUrlStr || "");
  if (!host) return INJECT_PATCHES_STANDARD;
  const cached = _injectPatchCache.get(host);
  if (cached) return cached;
  const result = isDiscordRelayOnlyHost(host)
    ? INJECT_PATCHES_RELAY
    : INJECT_PATCHES_STANDARD;
  if (_injectPatchCache.size > 64) {
    const oldest = _injectPatchCache.keys().next().value;
    _injectPatchCache.delete(oldest);
  }
  _injectPatchCache.set(host, result);
  return result;
}

const HEAD_START_RE = /<head\b[^>]*>/i;

async function patchHtml(response, upstreamUrlStr) {
  const contentType = response.headers.get("content-type") || "";
  if (!contentType.includes("text/html") || !response.body) return response;
  try {
    const lenHdr = response.headers.get("content-length");
    if (lenHdr && parseInt(lenHdr, 10) > MAX_HTML_INJECT_BYTES) return response;
    const clonedResponse = response.clone();
    const originalBody = await clonedResponse.text();
    if (originalBody.length > MAX_HTML_INJECT_BYTES) return response;
    const scripts = buildHtmlInjectPatches(upstreamUrlStr);
    let newBodyStr;
    const headMatch = HEAD_START_RE.exec(originalBody);
    if (headMatch) {
      const headEndIdx = headMatch.index + headMatch[0].length;
      newBodyStr =
        originalBody.substring(0, headEndIdx) +
        scripts +
        originalBody.substring(headEndIdx);
    } else {
      newBodyStr = scripts + originalBody;
    }
    return new Response(newBodyStr, {
      status: response.status,
      statusText: response.statusText,
      headers: fixHtmlHeaders(response.headers),
    });
  } catch (e) {
    return response;
  }
}