pub const MOCHI_PREFIX: &str = "/!!/";

pub const SCRIPT_PART_1: &str = r##"<script>
(function() {
    var hud;
    function initHud() {
        if (hud) return;
        try {
            hud = document.createElement('div');
            hud.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:300px;background:#000000d9;color:#0f0;font-family:monospace;font-size:11px;overflow-y:scroll;z-index:2147483647;pointer-events:none;padding:5px;word-break:break-all;pointer-events:auto;display:none;';
            (document.body || document.documentElement).appendChild(hud);
        } catch(e) {}
    }
    window.addEventListener('load', initHud);
    window.addEventListener('DOMContentLoaded', initHud);

    window.addEventListener('keydown', function(e) {
        if (e.code === 'Semicolon' && e.ctrlKey) {
            e.preventDefault();
            e.stopImmediatePropagation();
            if (hud) {
                hud.style.display = (hud.style.display === 'none') ? 'block' : 'none';
            } else {
                initHud();
                if(hud) hud.style.display = 'block';
            }
        }
    }, true);

    function log(type, args) {
        if (!hud) initHud();
        if (hud) {
            var el = document.createElement('div');
            el.textContent = '[' + type + '] ' + Array.from(args).map(String).join(' ');
            el.style.borderBottom = '1px solid #333';
            if (type === 'ERR') el.style.color = '#ff5555';
            if (type === 'WARN') el.style.color = '#ffff55';
            hud.insertBefore(el, hud.firstChild);
        }
    }
    var _log=console.log, _err=console.error, _warn=console.warn;
    console.log = function() { log('LOG', arguments); _log.apply(console, arguments); };
    console.error = function() { log('ERR', arguments); _err.apply(console, arguments); };
    console.warn = function() { log('WARN', arguments); _warn.apply(console, arguments); };

    window.addEventListener('error', function(e) { log('ERR', [e.message, e.filename, e.lineno]); });
    window.addEventListener('unhandledrejection', function(e) { log('ERR', ['Promise:', e.reason]); });

    try {
        const _U = window.URL;
        window.URL = function(u, b) {
            if ((!u || u === "") && !b) return new _U(window.location.href);
            return new _U(u, b);
        };
        window.URL.prototype = _U.prototype;
        window.URL.createObjectURL = function(o) { return _U.createObjectURL(o); };
        window.URL.revokeObjectURL = function(u) { return _U.revokeObjectURL(u); };
        for (let k in _U) { if (!(k in window.URL)) window.URL[k] = _U[k]; }
        
        const _p = history.pushState;
        const _r = history.replaceState;
        history.pushState = function(s, t, u) { try { _p.call(this, s, t, u); } catch(e) {} };
        history.replaceState = function(s, t, u) { try { _r.call(this, s, t, u); } catch(e) {} };
    } catch(e) {}

    window.__MOCHI_PREFIX__="/!!/";
    window.__MOCHI_TARGET__=""##;

pub const SCRIPT_PART_2: &str = r##"";
    window.__MOCHI_BASE__ = window.__MOCHI_BASE__ || ((window.location.origin || "") + window.__MOCHI_PREFIX__);
    
    try {
        const baseEl = document.querySelector('base[href]');
        if (baseEl && baseEl.href) {
             window.__MOCHI_TARGET__ = baseEl.href;
        }
    } catch(e) {}
a
    const rewrite = (url) => {
        if (!url || typeof url !== "string") return url;

        const path = window.location.pathname;
        if (path.startsWith("/b/s/") || path.startsWith("/b/u/")) {
            return url;
        }

        if (url.startsWith("data:") || url.startsWith("blob:") || url.startsWith(window.__MOCHI_PREFIX__)) return url;
        if (url.startsWith(window.location.origin + window.__MOCHI_PREFIX__)) return url;
        if (url.startsWith("http")) return window.__MOCHI_PREFIX__ + url;
        
        let base = window.__MOCHI_TARGET__;
        try {
            const baseEl = document.querySelector('base[href]');
            if (baseEl && baseEl.href) base = baseEl.href;
        } catch(e) {}

        try {
            const resolved = new URL(url, base).href;
            return window.__MOCHI_PREFIX__ + resolved;
        } catch (e) {
            return url;
        }
    };

    const originalFetch = window.fetch;
    window.fetch = function(input, init) {
        if (typeof input === "string") input = rewrite(input);
        else if (input instanceof Request) input = new Request(rewrite(input.url), input);
        return originalFetch(input, init)
    };
    
    const originalOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function(method, url, ...args) {
        return originalOpen.call(this, method, rewrite(url), ...args)
    };
    
    const originalWS = window.WebSocket;
    window.WebSocket = function(url, protocols) {
        if (!url) return new originalWS(url, protocols);
        let target = url;
        if (!target.startsWith("ws")) {
            try {
                target = new URL(url, window.__MOCHI_TARGET__).href
            } catch (e) {}
            target = target.replace("http", "ws")
        }
        const proxyUrl = (window.location.protocol === "https:" ? "wss://" : "ws://") + window.location.host + window.__MOCHI_PREFIX__ + "ws/" + encodeURIComponent(target);
        const ws = new originalWS(proxyUrl, protocols);
        ws.binaryType = "arraybuffer";
        return ws
    };
    
    const originalWorker = window.Worker;
    window.Worker = function(scriptURL, options) {
        return new originalWorker(rewrite(scriptURL), options)
    };
    
    const downloadExts = [".zip", ".rar", ".7z", ".tar", ".gz", ".tgz", ".bz2", ".xz", ".exe", ".msi", ".apk", ".dmg", ".deb", ".rpm", ".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx", ".iso", ".img", ".bin", ".msix", ".pkg", ".mp3", ".mp4", ".wav", ".flac", ".mkv", ".mov"];
    document.addEventListener("click", function(e) {
        if (e.defaultPrevented) return;
        const a = e.target.closest("a");
        if (!a) return;
        const href = a.getAttribute("data-mochi-orig-href") || a.getAttribute("href");
        if (!href) return;
        if (href.startsWith("javascript:") || href.startsWith("#")) return;
        const lower = href.toLowerCase();
        const hasDownload = a.hasAttribute("download") || downloadExts.some(ext => lower.endsWith(ext));
        const mochied = rewrite(href);
        if (!hasDownload) return;
        e.preventDefault();
        if (a.target === "_blank" || e.ctrlKey || e.metaKey || a.hasAttribute("download")) {
            window.open(mochied, "_blank");
        } else {
            window.location.assign(mochied);
        }
    });

    if (navigator.serviceWorker && navigator.serviceWorker.controller) {
        try {
            navigator.serviceWorker.controller.postMessage({
                type: "mochi-base",
                base: window.__MOCHI_BASE__
            });
        } catch (e) {}
    }

    window.dataLayer = [];
    window.gtag = function() {};
    window.ga = function() {};
    window.google = window.google || {};
    window.google.ima = window.google.ima || {
        AdsLoader: function() { return { addEventListener: function(){}, contentComplete: function(){}, requestAds: function(){} }; },
        AdDisplayContainer: function() { return { initialize: function(){} }; },
        AdsManagerLoadedEvent: { Type: { ADS_MANAGER_LOADED: 'adsManagerLoaded' } },
        AdErrorEvent: { Type: { AD_ERROR: 'adError' } },
        ViewMode: { NORMAL: 'normal' }
    };
})()
</script>"##;