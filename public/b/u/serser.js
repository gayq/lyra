"use strict"; (() => {
    let e = self.Ultraviolet, t = ["cross-origin-embedder-policy", "cross-origin-opener-policy", "cross-origin-resource-policy", "content-security-policy", "content-security-policy-report-only", "expect-ct", "feature-policy", "origin-isolation", "strict-transport-security", "upgrade-insecure-requests", "x-content-type-options", "x-download-options", "x-frame-options", "x-permitted-cross-domain-policies", "x-powered-by", "x-xss-protection"], r = ["GET", "HEAD"], i = `<script>
    (function() {

        const spoofNavigator = {
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/113.0.0.0 Safari/537.36',
            platform: 'Win32',
            language: 'en-US',
            languages: ['en-US', 'en'],
            hardwareConcurrency: 8,
            deviceMemory: 8,
            maxTouchPoints: 0,
            webdriver: false,
            plugins: [
                { name: 'PDF Viewer', filename: 'internal-pdf-viewer' },
                { name: 'Chrome PDF Plugin', filename: 'internal-pdf-viewer' }
            ],
            mimeTypes: [
                { type: 'application/pdf', suffixes: 'pdf', description: '' }
            ]
        };

        const spoofScreen = {
            width: 1920,
            height: 1080,
            colorDepth: 24,
            pixelDepth: 24,
            availWidth: 1920,
            availHeight: 1040
        };

        Object.keys(spoofNavigator).forEach(key => {
            try {
                Object.defineProperty(navigator, key, {
                    value: spoofNavigator[key],
                    writable: false,
                    configurable: false
                });
            } catch(e) {}
        });

        Object.keys(spoofScreen).forEach(key => {
            try {
                Object.defineProperty(screen, key, {
                    value: spoofScreen[key],
                    writable: false,
                    configurable: false
                });
            } catch(e) {}
        });

        Object.defineProperty(Intl.DateTimeFormat.prototype, 'resolvedOptions', {
            value: () => ({ 
                timeZone: 'America/New_York', 
                locale: 'en-US' 
            }),
            configurable: true,
            writable: true
        });

        if ('getBattery' in navigator) {
            navigator.getBattery = () => Promise.resolve({
                charging: true,
                chargingTime: 0,
                dischargingTime: Infinity,
                level: 1
            });
        }

        if ('connection' in navigator) {
            Object.defineProperty(navigator, 'connection', {
                value: {
                    downlink: 10,
                    effectiveType: '4g',
                    rtt: 50,
                    saveData: false,
                    type: 'wifi'
                },
                writable: false,
                configurable: false
            });
        }


        const originalToDataURL = HTMLCanvasElement.prototype.toDataURL;
        HTMLCanvasElement.prototype.toDataURL = function(type, quality) {
            if (type === 'image/png' || type === 'image/jpeg') {
                const blank = document.createElement('canvas');
                blank.width = this.width || 16;
                blank.height = this.height || 16;
                return originalToDataURL.call(blank, type, quality);
            }
            return originalToDataURL.call(this, type, quality);
        };

        const originalGetParameter = WebGLRenderingContext.prototype.getParameter;
        WebGLRenderingContext.prototype.getParameter = function(parameter) {
            if (parameter === 37445) return 'Google Inc.';
            if (parameter === 37446) return 'ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11 vs_5_0 ps_5_0)';
            return originalGetParameter.call(this, parameter);
        };

        const originalGetChannelData = AudioBuffer.prototype.getChannelData;
        AudioBuffer.prototype.getChannelData = function() {
            const data = originalGetChannelData.apply(this, arguments);
            for (let i = 0; i < data.length; i++) {
                data[i] += Math.random() * 0.001 - 0.0005;
            }
            return data;
        };

        const originalNow = Performance.prototype.now;
        const start = originalNow.call(performance);
        Performance.prototype.now = function() {
            return start + Math.random() * 3;
        };

        const originalMeasure = Performance.prototype.measure;
        Performance.prototype.measure = function() {
            return null;
        };

        if ('serviceWorker' in navigator) {
            navigator.serviceWorker.getRegistrations = () => Promise.resolve([]);
            navigator.serviceWorker.ready = Promise.resolve({ active: false });
            Object.defineProperty(navigator, 'serviceWorker', {
                value: null,
                writable: false,
                configurable: false
            });
        }

        const originalRTCPeerConnection = window.RTCPeerConnection;
        window.RTCPeerConnection = function(config) {
            config = config || {};
            config.iceTransportPolicy = "relay";
            if (config.iceServers) {
                config.iceServers = config.iceServers.filter(function(server) {
                    if (!server || !server.urls) return false;
                    var urls = Array.isArray(server.urls) ? server.urls : [server.urls];
                    return urls.every(function(url) { return url.startsWith("turn:"); });
                });
            }
            if (!config.iceServers || config.iceServers.length === 0) {
                config.iceServers = [{
                    urls: "turn:__SERVER_IP__:3478",
                    username: "luy",
                    credential: "l4uy"
                }];
            }
            return new originalRTCPeerConnection(config);
        };
        window.RTCPeerConnection.prototype = originalRTCPeerConnection.prototype;
    })();
    </script>`; class a extends e.EventEmitter { constructor(t = __uv$config) { super(), t.prefix = t.prefix || "/wah/a/", this.config = t, this.bareClient = new e.BareClient, this.analyticsData = {}, this.syncInterval = 3e5, this.lastSync = Date.now() } route({ request: e }) { return e.url.startsWith(location.origin + this.config.prefix) } async fetch({ request: a }) { if ("OPTIONS" === a.method.toUpperCase()) return new Response(null, { status: 204, headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, HEAD, POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type, Authorization" } }); let l = ""; try { if (!a.url.startsWith(location.origin + this.config.prefix)) return await fetch(a); let d = new e(this.config); "function" == typeof this.config.construct && d.construct(d, "service"); let p = r.includes(a.method.toUpperCase()) ? Promise.resolve(null) : a.blob(), h = d.cookie.db(), [f, g] = await Promise.all([p, h]); d.meta.origin = location.origin, d.meta.base = d.meta.url = new URL(d.sourceUrl(a.url)); let m = new n(a, d, f); if ("blob:" === d.meta.url.protocol && (m.blob = !0, m.base = m.url = new URL(m.url.pathname)), a.referrer && a.referrer.startsWith(location.origin)) { let y = new URL(d.sourceUrl(a.referrer)); (m.headers.origin || d.meta.url.origin !== y.origin && "cors" === a.mode) && (m.headers.origin = y.origin), delete m.headers.referer } let $ = await d.cookie.getCookies(g) || [], b = d.cookie.serialize($, d.meta, !1); m.headers["user-agent"] = "SomethingSomething/1.0", b && (m.headers.cookie = b); let w = new s(m, null, null); if (this.emit("request", w), w.intercepted) return w.returnValue; l = m.blob ? "blob:" + location.origin + m.url.pathname : m.url; let v = { headers: m.headers, method: m.method, body: m.body, credentials: "include", mode: m.mode, cache: m.cache, redirect: m.redirect }; if ("GET" === a.method.toUpperCase()) { let x = await caches.open("fell-cache"), C = await x.match(l); if (C) return await this.recordAnalytics("cacheHit", l), C.clone() } let k; for (let P = 0; P < 2; P++)try { k = await this.bareClient.fetch(l, v); break } catch (_) { if (1 === P) throw _ } let T = new o(m, k), S = new s(T, null, null); if (this.emit("beforemod", S), S.intercepted) return S.returnValue; if (t.forEach(e => { T.headers[e] && delete T.headers[e] }), T.headers.location && (T.headers.location = d.rewriteUrl(T.headers.location)), ["document", "iframe"].includes(a.destination)) { let A = await k.text(), D = A.toLowerCase().indexOf("<head>"); if (-1 !== D && (A = A.slice(0, D + 6) + i + A.slice(D + 6)), Array.isArray(this.config.inject)) { let E = A.search(/<body>/i), O = new URL(l); for (let j of this.config.inject) RegExp(j.host).test(O.host) && ("head" === j.injectTo && -1 !== D ? A = A.slice(0, D) + j.html + A.slice(D) : "body" === j.injectTo && -1 !== E && (A = A.slice(0, E) + j.html + A.slice(E))) } A = A.replace(/<\/body>/i, '<script src="https://cdn.usewaves.site/main.js" crossorigin="anonymous"></script></body>'); let U = await c(d.meta.url.host); U && (A = A.replace(/<\/body>/i, `<script>window.userProgress=${JSON.stringify(U)}</script></body>`)), T.body = d.rewriteHtml(A, { document: !0, injectHead: d.createHtmlInject(d.handlerScript, d.bundleScript, d.clientScript, d.configScript, d.cookie.serialize($, d.meta, !0), a.referrer) }) } if (T.headers["set-cookie"] && (Promise.resolve(d.cookie.setCookies(T.headers["set-cookie"], g, d.meta)).then(() => { self.clients.matchAll().then(e => { e.forEach(e => { e.postMessage({ msg: "updateCookies", url: d.meta.url.href }) }) }) }), delete T.headers["set-cookie"]), T.body) switch (a.destination) { case "script": T.body = d.js.rewrite(await k.text()); break; case "worker": { let I = [d.bundleScript, d.clientScript, d.configScript, d.handlerScript].map(e => JSON.stringify(e)).join(","); T.body = `if(!self.__uv){${d.createJsInject(d.cookie.serialize($, d.meta, !0), a.referrer)}importScripts(${I});}` + d.js.rewrite(await k.text()); break } case "style": T.body = d.rewriteCSS(await k.text()) }if (T.headers["Access-Control-Allow-Origin"] = "*", T.headers["Access-Control-Allow-Methods"] = "GET, HEAD, POST, OPTIONS", T.headers["Access-Control-Allow-Headers"] = "Content-Type, Authorization", "text/event-stream" === m.headers.accept && (T.headers["content-type"] = "text/event-stream"), crossOriginIsolated && (T.headers["Cross-Origin-Embedder-Policy"] = "require-corp"), this.emit("response", S), S.intercepted) return S.returnValue; let L = new Response(T.body, { headers: T.headers, status: T.status, statusText: T.statusText }); if ("GET" === a.method.toUpperCase()) { let H = await caches.open("fell-cache"); 206 !== L.status && H.put(l, L.clone()) } return await this.recordAnalytics("fetchSuccess", l), this.periodicSync(), L } catch (R) { let W = { "content-type": "text/html", "Access-Control-Allow-Origin": "*" }; if (crossOriginIsolated && (W["Cross-Origin-Embedder-Policy"] = "require-corp"), await this.recordAnalytics("fetchError", a.url), ["document", "iframe"].includes(a.destination)) return u(R, l); return new Response(void 0, { status: 500, headers: W }) } } async recordAnalytics(e, t) { let r = Date.now(); if (this.analyticsData[e] || (this.analyticsData[e] = []), this.analyticsData[e].push({ url: t, time: r }), r - this.lastSync > this.syncInterval) try { await d(this.analyticsData), this.analyticsData = {}, this.lastSync = r } catch (i) { } } periodicSync() { Date.now() - this.lastSync > this.syncInterval && d(this.analyticsData).then(() => { this.analyticsData = {}, this.lastSync = Date.now() }).catch(() => { }) } static get Ultraviolet() { return e } } class o { constructor(e, t) { for (let r in this.request = e, this.raw = t, this.ultraviolet = e.ultraviolet, this.headers = {}, t.rawHeaders) this.headers[r.toLowerCase()] = t.rawHeaders[r]; this.status = t.status, this.statusText = t.statusText, this.body = t.body } get url() { return this.request.url } get base() { return this.request.base } set base(e) { this.request.base = e } getHeader(e) { return Array.isArray(this.headers[e]) ? this.headers[e][0] : this.headers[e] } } class n { constructor(e, t, r = null) { this.ultraviolet = t, this.request = e, this.headers = Object.fromEntries(e.headers.entries()), this.method = e.method, this.body = r, this.cache = e.cache, this.redirect = e.redirect, this.credentials = "omit", this.mode = "cors" === e.mode ? e.mode : "same-origin", this.blob = !1 } get url() { return this.ultraviolet.meta.url } set url(e) { this.ultraviolet.meta.url = e } get base() { return this.ultraviolet.meta.base } set base(e) { this.ultraviolet.meta.base = e } } class s { #a = !1; #b = null; constructor(e = {}, t = null, r = null) { this.data = e, this.target = t, this.that = r } get intercepted() { return this.#a } get returnValue() { return this.#b } respondWith(e) { this.#b = e, this.#a = !0 } } async function c(e) { let t = await caches.open("progress-cache"), r = await t.match("progress-" + e); if (r) try { return await r.json() } catch (i) { } return null } async function l(e, t) { let r = await caches.open("progress-cache"); await r.put("progress-" + e, new Response(JSON.stringify(t))) } async function d(e) { try { await fetch(location.origin + "/wah/a/analytics", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(e) }) } catch (t) { } } function p(e, t) {
        let r = `
            errorTrace.value = ${JSON.stringify(e)};
            fetchedURL.textContent = ${JSON.stringify(t)};
            for (const n of document.querySelectorAll("#uvHostname")) {
                n.textContent = ${JSON.stringify(location.hostname)};
            }
            reload.addEventListener("click", () => location.reload());
            uvVersion.textContent = ${JSON.stringify("v.0.0.1")};
            uvBuild.textContent = ${JSON.stringify("idk")};
        `; return `<!DOCTYPE html><html><head><meta charset="utf-8"/><title>Error</title>
        <style>
            * { transition: all 0.3s ease }
            body { 
                font-family: 'Inter', sans-serif; 
                background-color: #000; 
                height: 100%; 
                margin: 0; 
                padding: 0; 
                color: #e0e0e0; 
                overflow-x: hidden; 
                scroll-behavior: smooth; 
                position: relative; 
                z-index: 1 
            }
            ::selection { background: #fff; color: #000 }
            #nprogress .bar { 
                background: #fff!important; 
                z-index: 99999!important; 
                box-shadow: 0 0 60px #ffffffcc, 0 0 90px #ffffff99, 0 0 150px #ffffff66!important 
            }
            #nprogress .peg { 
                box-shadow: 0 0 100px #ffffffcc, 0 0 150px #ffffff99, 0 0 200px #ffffff66!important 
            }
            #nprogress .spinner-icon { 
                border-top-color: #fff!important; 
                border-left-color: #fff!important 
            }
            .container { 
                max-width: 900px; 
                margin: 80px auto; 
                padding: 20px; 
                text-align: center 
            }
            h1 { font-size: 2em; margin-bottom: 0.5em }
            p { font-size: 1em; margin: 0.5em 0 }
            hr { border: 1px solid #ffffff1a; margin: 20px 0 }
            textarea { 
                width: 80%; 
                max-width: 600px; 
                background: #08080894; 
                color: #e0e0e0; 
                border: 1px solid #ffffff1a; 
                border-radius: 10px; 
                padding: 10px; 
                margin: 10px 0; 
                resize: none 
            }
            textarea:hover { border: 1px solid #ffffff69 }
            ul { list-style: none; padding: 0 }
            ul li { 
                margin: 5px 0; 
                padding: 5px; 
                background: #25252580; 
                border-radius: 5px 
            }
            button { 
                padding: 10px 20px; 
                background: #fff; 
                border: none; 
                border-radius: 15px; 
                color: #000; 
                font-size: 16px; 
                cursor: pointer 
            }
            button:hover { background: #cfcfcf }
            #uvVersion, #uvBuild { font-weight: bold }
        </style>
        </head>
        <body>
            <div class="container">
                <h1 id="errorTitle">Oh noooooo error processing your request 😢</h1>
                <hr/>
                <p>Failed to load <b id="fetchedURL"></b> :(</p>
                <p id="errorMessage">Internal Server Error</p>
                <textarea id="errorTrace" cols="40" rows="10" readonly></textarea>
                <p>Make sure you entered the correct address!!</p>
                <button id="reload">Reload</button>
                <hr/>
                <p><i>Waves <span id="uvVersion"></span> (build <span id="uvBuild"></span>)</i></p>
            </div>
            <script src="data:application/javascript,${encodeURIComponent(r)}"></script>
        </body>
        </html>`} function u(e, t) { let r = { "content-type": "text/html", "Access-Control-Allow-Origin": "*" }; return crossOriginIsolated && (r["Cross-Origin-Embedder-Policy"] = "require-corp"), new Response(p(String(e), t), { status: 500, headers: r }) } self.addEventListener("message", e => { e.data && "saveProgress" === e.data.type && e.data.host && e.data.data && l(e.data.host, e.data.data), e.data && "syncAnalytics" === e.data.type && d(e.data.analytics || {}), e.data && "clearProgress" === e.data.type && e.data.host && caches.open("progress-cache").then(t => { t.delete("progress-" + e.data.host) }) }), self.addEventListener("install", e => { self.skipWaiting() }), self.addEventListener("activate", e => { e.waitUntil((async () => { self.registration.navigationPreload && await self.registration.navigationPreload.enable(), await self.clients.claim() })()) }), self.UVServiceWorker = a
})();