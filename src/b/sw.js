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

const HARDCODED_AD_DOMAINS = new Set([
  'pagead2.googlesyndication.com', 'googlesyndication.com', 'googleadservices.com',
  'google-analytics.com', 'analytics.google.com', 'googletagmanager.com',
  'googletagservices.com', 'googlesyndication.com', 'googleads.g.doubleclick.net',
  'tpc.googlesyndication.com', 'adservice.google.com', 'adservice.google.co.uk',
  'adservice.google.ca', 'adservice.google.de', 'adservice.google.fr',
  'adservice.google.com.au', 'adservice.google.co.jp', 'adservice.google.co.in',
  'pagead-googlehosted.l.google.com', 'partnerad.l.google.com',
  'doubleclick.net', 'ad.doubleclick.net', 's0.2mdn.net', '2mdn.net',
  'stats.g.doubleclick.net', 'cm.g.doubleclick.net',
  'pixel.facebook.com', 'an.facebook.com', 'www.facebook.com/tr',
  'connect.facebook.net/en_US/fbevents.js',
  'aax.amazon-adsystem.com', 'amazon-adsystem.com', 'z-na.amazon-adsystem.com',
  'aax-eu.amazon-adsystem.com', 'fls-na.amazon-adsystem.com',
  'bat.bing.com', 'ads.microsoft.com', 'c.bing.com', 'c.msn.com',
  'adnxs.com', 'adsrvr.org', 'rubiconproject.com', 'pubmatic.com',
  'openx.net', 'casalemedia.com', 'contextweb.com', 'indexww.com',
  'criteo.com', 'criteo.net', 'outbrain.com', 'taboola.com', 'mgid.com',
  'revcontent.com', 'content-ad.net', 'adhese.com', 'smartadserver.com',
  'serving-sys.com', 'eyeota.net', 'krxd.net', 'bluekai.com',
  'exelator.com', 'rlcdn.com', 'addthis.com', 'sharethrough.com',
  'bidswitch.net', 'spotxchange.com', 'spotx.tv', 'advertising.com',
  'yieldmo.com', 'yieldmanager.com', 'yieldoptimizer.com',
  'scorecardresearch.com', 'quantserve.com', 'imrworldwide.com',
  'chartbeat.com', 'chartbeat.net', 'segment.com', 'segment.io',
  'hotjar.com', 'mouseflow.com', 'fullstory.com', 'crazyegg.com',
  'luckyorange.com', 'inspectlet.com', 'clicktale.com',
  'newrelic.com', 'nr-data.net', 'mixpanel.com', 'amplitude.com',
  'heap.io', 'heapanalytics.com', 'optimizely.com', 'abtasty.com',
  'demdex.net', 'omtrdc.net', '2o7.net', 'sc.omtrdc.net',
  'everesttech.net', 'mookie1.com', 'mathtag.com',
  'popads.net', 'popcash.net', 'propellerads.com', 'adcash.com',
  'trafficjunky.com', 'trafficfactory.biz', 'juicyads.com',
  'exoclick.com', 'plugrush.com', 'hilltopads.net',
  'moatads.com', 'doubleverify.com', 'adsafeprotected.com',
  'iasds01.com', 'peer39.net', 'grapeshot.co.uk',
  'adskeeper.co.uk', 'adtelligent.com', 'sovrn.com',
  'conversantmedia.com', 'media.net', 'media6degrees.com',
  'adform.net', 'adform.com', 'smaato.net', 'inmobi.com',
  'unity3d.com/ads', 'unityads.unity3d.com', 'mopub.com',
  'appsflyer.com', 'adjust.com', 'branch.io', 'kochava.com',
  'supersonicads.com', 'vungle.com', 'chartboost.com',
  'adcolony.com', 'ironsrc.com', 'fyber.com', 'tapjoy.com',
  'zemanta.com', 'nativeads.com', 'triplelift.com',
  'teads.tv', 'gumgum.com', 'vibrantmedia.com',
  'undertone.com', 'kargo.com', 'yieldlab.net',
  'aniview.com', 'primis.tech', 'seedtag.com',
  'aps.amazon.com', 'amazon-adsystem.com', 'assoc-amazon.com',
  'udc.yahoo.com', 'browser.sentry-cdn.com',
  'consensu.org', 'trustarc.com', 'cookielaw.org', 'onetrust.com',
  'cdn.taboola.com', 'cdn.outbrain.com', 'cdn.mgid.com',
  'static.criteo.net', 'static.adsafeprotected.com',
]);

const AD_PATH_PATTERNS = [
  /\/ads[\/.?]/i,
  /\/adserv/i,
  /\/pagead\//i,
  /\/adsbygoogle/i,
  /\/adsense[\/.]/i,
  /\/googlesyndication[\/.]/i,
  /\/api\/ads/i,
  /\/prebid/i,
  /\/gpt\.js/i,
  /\/gpt\/pubads/i,
  /\/gampad\/ads/i,
  /\/show_ads/i,
  /\/smart_?ad/i,
  /\/openx[\/.]/i,
  /\/header[_-]?bidding/i,
  /\/pixel\.gif/i,
  /\/pixel\.png/i,
  /\/beacon\.js/i,
  /\/collect\?.*tid=/i,
  /\/fbevents?\.js/i,
];

let adBlockDomains = new Set(HARDCODED_AD_DOMAINS);
let adBlockLoaded = HARDCODED_AD_DOMAINS.size > 0;

const AD_LISTS = [
  {
    url: 'https://raw.githubusercontent.com/nextdns/native-tracking-domains/main/domains/alexa',
    parse: 'plain'
  },
  {
    url: 'https://raw.githubusercontent.com/nextdns/native-tracking-domains/main/domains/apple',
    parse: 'plain'
  },
  {
    url: 'https://raw.githubusercontent.com/nextdns/native-tracking-domains/main/domains/windows',
    parse: 'plain'
  },
  {
    url: 'https://raw.githubusercontent.com/StevenBlack/hosts/master/hosts',
    parse: 'hosts'
  },
  {
    url: 'https://pgl.yoyo.org/adservers/serverlist.php?hostformat=nohtml',
    parse: 'plain'
  },
  {
    url: 'https://raw.githubusercontent.com/privacy-protection-tools/anti-AD/master/anti-ad-easylist.txt',
    parse: 'wildcard'
  },
  {
    url: 'https://adguardteam.github.io/AdGuardSDNSFilter/Filters/filter.txt',
    parse: 'adguard'
  },
  {
    url: 'https://cdn.jsdelivr.net/gh/badmojr/1Hosts@latest/Lite/domains.txt',
    parse: 'plain'
  },
  {
    url: 'https://cdn.jsdelivr.net/gh/hagezi/dns-blocklists@latest/domains/pro.txt',
    parse: 'plain'
  }
];

function parsePlainList(text) {
  const domains = [];
  for (const line of text.split('\n')) {
    const d = line.trim().toLowerCase();
    if (d && !d.startsWith('#') && !d.startsWith('!') && d.includes('.')) {
      domains.push(d);
    }
  }
  return domains;
}

function parseHostsFile(text) {
  const domains = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const parts = trimmed.split(/\s+/);
    if (parts.length >= 2 && (parts[0] === '0.0.0.0' || parts[0] === '127.0.0.1')) {
      const d = parts[1].toLowerCase();
      if (d && d !== 'localhost' && d !== 'localhost.localdomain' && d.includes('.')) {
        domains.push(d);
      }
    }
  }
  return domains;
}

function parseWildcardList(text) {
  const domains = [];
  for (const line of text.split('\n')) {
    let d = line.trim().toLowerCase();
    if (!d || d.startsWith('#') || d.startsWith('!')) continue;
    
    if (d.startsWith('||') && d.endsWith('^')) {
      d = d.slice(2, -1);
      if (d && d.includes('.') && !d.includes('/')) domains.push(d);
    } else if (d.startsWith('*.')) {
      d = d.slice(2);
      if (d && d.includes('.') && !d.includes('/')) domains.push(d);
    }
  }
  return domains;
}

function parseAdguardFilter(text) {
  const domains = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('!') || trimmed.startsWith('[')) continue;
    if (trimmed.startsWith('||') && trimmed.endsWith('^')) {
      const d = trimmed.slice(2, -1).toLowerCase();
      if (d && d.includes('.') && !d.includes('/') && !d.includes('*')) {
        domains.push(d);
      }
    }
  }
  return domains;
}

const IDB_NAME = 'waves-adblock';
const IDB_STORE = 'domains';
const IDB_KEY = 'domainlist';

function openAdBlockDB() {
  return new Promise((resolve, reject) => {
    try {
      const req = indexedDB.open(IDB_NAME, 1);
      req.onupgradeneeded = () => { req.result.createObjectStore(IDB_STORE); };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    } catch (e) { reject(e); }
  });
}

async function saveDomainsToIDB(domains) {
  try {
    const db = await openAdBlockDB();
    const tx = db.transaction(IDB_STORE, 'readwrite');
    tx.objectStore(IDB_STORE).put({ domains: [...domains], ts: Date.now() }, IDB_KEY);
    await new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = rej; });
    db.close();
  } catch (e) { }
}

async function loadDomainsFromIDB() {
  try {
    const db = await openAdBlockDB();
    const tx = db.transaction(IDB_STORE, 'readonly');
    const req = tx.objectStore(IDB_STORE).get(IDB_KEY);
    const result = await new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = rej; });
    db.close();
    if (result && result.domains && result.domains.length > 100) {
      return { domains: new Set(result.domains), ts: result.ts };
    }
  } catch (e) { }
  return null;
}

async function loadAdBlockList() {
  try {
    const cached = await loadDomainsFromIDB();
    if (cached && cached.domains.size > 100) {
      adBlockDomains = new Set([...HARDCODED_AD_DOMAINS, ...cached.domains]);
      adBlockLoaded = true;
      console.log(`[cool ad blocker :3] Loaded ${adBlockDomains.size} domains from cache`);
      if (cached.ts && (Date.now() - cached.ts) < 12 * 60 * 60 * 1000) return;
    }
  } catch (e) { }

  const allDomains = new Set(HARDCODED_AD_DOMAINS);
  const results = await Promise.allSettled(
    AD_LISTS.map(async (list) => {
      try {
        const res = await fetch(MOCHI_PREFIX + list.url);
        if (!res.ok) return [];
        const text = await res.text();
        switch (list.parse) {
          case 'plain': return parsePlainList(text);
          case 'hosts': return parseHostsFile(text);
          case 'wildcard': return parseWildcardList(text);
          case 'adguard': return parseAdguardFilter(text);
          default: return parsePlainList(text);
        }
      } catch (e) { return []; }
    })
  );

  for (const r of results) {
    if (r.status === 'fulfilled' && Array.isArray(r.value)) {
      for (const d of r.value) allDomains.add(d);
    }
  }

  if (allDomains.size > HARDCODED_AD_DOMAINS.size + 100) {
    adBlockDomains = allDomains;
    adBlockLoaded = true;
    console.log(`[cool ad blocker :3] loaded ${adBlockDomains.size} domains from ${AD_LISTS.length} lists`);
    saveDomainsToIDB(allDomains);
  }
}

function matchesDomain(hostname) {
  if (adBlockDomains.has(hostname)) return true;
  const parts = hostname.split('.');
  for (let i = 1; i < parts.length - 1; i++) {
    if (adBlockDomains.has(parts.slice(i).join('.'))) return true;
  }
  return false;
}

function isAdUrl(url) {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    const hostname = parsed.hostname.toLowerCase();
    if (matchesDomain(hostname)) return true;
    const fullPath = parsed.pathname + parsed.search;
    for (const pat of AD_PATH_PATTERNS) {
      if (pat.test(fullPath)) return true;
    }
    return false;
  } catch (e) {
    return false;
  }
}

function getBlockResponse(url) {
  const lower = (url || '').toLowerCase();
  if (lower.endsWith('.js')) return new Response('/* no */', { status: 200, headers: { 'Content-Type': 'application/javascript' } });
  if (lower.endsWith('.css')) return new Response('/* no */', { status: 200, headers: { 'Content-Type': 'text/css' } });
  if (lower.endsWith('.html') || lower.endsWith('.htm')) return new Response('', { status: 200, headers: { 'Content-Type': 'text/html' } });
  if (/\.(gif|png|jpg|jpeg|webp|svg|ico)(\?|$)/.test(lower)) return new Response('', { status: 200, headers: { 'Content-Type': 'image/gif' } });
  if (/\.(mp4|webm|m3u8)(\?|$)/.test(lower)) return new Response('', { status: 200, headers: { 'Content-Type': 'video/mp4' } });
  return new Response('', { status: 200, headers: { 'Content-Type': 'text/plain' } });
}

const AD_COSMETIC_CSS = `
<style id="waves-adblock-cosmetic">
  [class*="ad-container"], [class*="ad-slot"], [class*="ad-wrapper"],
  [class*="ad-banner"], [class*="ad-unit"], [class*="ad-frame"],
  [class*="adcontainer"], [class*="adslot"], [class*="adwrapper"],
  [class*="adbanner"], [class*="adunit"], [class*="adframe"],
  [id*="google_ads"], [id*="ad-container"], [id*="ad-slot"],
  [id*="ad-banner"], [id*="ad-wrapper"], [id*="ad_unit"],
  [id*="adcontainer"], [id*="adslot"], [id*="adbanner"],
  iframe[src*="doubleclick"], iframe[src*="googlesyndication"],
  iframe[src*="amazon-adsystem"], iframe[src*="adnxs"],
  iframe[src*="taboola"], iframe[src*="outbrain"],
  ins.adsbygoogle, div[data-ad], div[data-ad-slot],
  div[data-ad-unit], div[data-adunit], div[data-adslot],
  div[data-google-query-id], amp-ad, amp-embed,
  [class*="sponsored-content"], [class*="sponsored_content"],
  [class*="advertisement"], [id*="advertisement"],
  [class*="GoogleActiveViewElement"],
  [class*="taboola"], [id*="taboola"],
  [class*="outbrain"], [id*="outbrain"],
  [class*="mgid"], [id*="mgid"],
  a[href*="doubleclick.net"], a[href*="googleadservices.com"],
  div.ad, div.ads, aside.ad, aside.ads,
  section.ad, section.ads {
    display: none !important;
    visibility: hidden !important;
    height: 0 !important;
    min-height: 0 !important;
    max-height: 0 !important;
    width: 0 !important;
    min-width: 0 !important;
    overflow: hidden !important;
    opacity: 0 !important;
    pointer-events: none !important;
    position: absolute !important;
    z-index: -9999 !important;
  }
</style>
`;

setInterval(() => loadAdBlockList(), 6 * 60 * 60 * 1000);

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
    const scripts = AD_COSMETIC_CSS + TURN_SCRIPT + META_SCRIPT;

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
    Promise.all([
      caches.keys().then(keys => {
        return Promise.all(
          keys.filter(k => k.startsWith('waves-') && k !== SHELL_CACHE && k !== RUNTIME_CACHE)
            .map(k => caches.delete(k))
        );
      }),
      loadAdBlockList()
    ]).then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);
  const realUrl = resolveRealUrl(url);

  if (url.pathname.startsWith(MOCHI_PREFIX)) {
    return;
  }

  if (realUrl && isAdUrl(realUrl)) {
    return event.respondWith(getBlockResponse(realUrl));
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

        if (isCacheableAsset && !realUrl.includes(self.location.host)) {
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
          try {
            const networkResponse = await fetch(request);
            if (networkResponse && networkResponse.ok) {
              const clone = networkResponse.clone();
              caches.open(SHELL_CACHE).then(cache => cache.put(request, clone));
              return networkResponse;
            }
          } catch (e) {
          }
          const cached = await caches.match(request);
          if (cached) return cached;
          return new Response('offline', { status: 503 });
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