import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const EPOXY_MJS = join(ROOT, 'node_modules', '@mercuryworkshop', 'epoxy-transport', 'dist', 'index.mjs');
const EPOXY_JS = join(ROOT, 'node_modules', '@mercuryworkshop', 'epoxy-transport', 'dist', 'index.js');
const LIBCURL_MJS = join(ROOT, 'node_modules', '@mercuryworkshop', 'libcurl-transport', 'dist', 'index.mjs');
const LIBCURL_JS = join(ROOT, 'node_modules', '@mercuryworkshop', 'libcurl-transport', 'dist', 'index.js');
const SCRAMJET = join(ROOT, 'public', 'b', 's', 'jetty.all.js');
const UV = join(ROOT, 'public', 'b', 'u', 'serser.js');
const UV_HANHAN = join(ROOT, 'public', 'b', 'u', 'hanhan.js');
const LABELS = {
    [EPOXY_MJS]: 'epoxy-transport (mjs)',
    [EPOXY_JS]: 'epoxy-transport (js)',
    [LIBCURL_MJS]: 'libcurl-transport (mjs)',
    [LIBCURL_JS]: 'libcurl-transport (js)',
    [SCRAMJET]: 'jetty.all.js (scramjet)',
    [UV]: 'serser.js (ultraviolet)',
    [UV_HANHAN]: 'hanhan.js (ultraviolet)',
};

const epoxyReqOld = `    try {
      let headersObj = {};
      for (let [key, value] of headers) {`;
const epoxyReqNew = `    try {
      if (typeof headers?.[Symbol.iterator] !== 'function') headers = Object.entries(headers ?? {});
      let headersObj = {};
      for (let [key, value] of headers) {`;

const epoxyConnOld = `    );
    let headersObj = {};
    for (let [key, value] of requestHeaders) {
      if (headersObj[key]) {`;
const epoxyConnNew = `    );
    if (typeof requestHeaders?.[Symbol.iterator] !== 'function') requestHeaders = Object.entries(requestHeaders ?? {});
    let headersObj = {};
    for (let [key, value] of requestHeaders) {
      if (headersObj[key]) {`;

const libcurlReqOld = `  async request(remote, method, body, headers, signal) {
    let headersObj = {};
    for (let [key, value] of headers) {
      headersObj[key] = value;
    }`;
const libcurlReqNew = `  async request(remote, method, body, headers, signal) {
    if (typeof headers?.[Symbol.iterator] !== 'function') headers = Object.entries(headers ?? {});
    let headersObj = {};
    for (let [key, value] of headers) {
      headersObj[key] = value;
    }`;

const libcurlConnOld = `  connect(url, protocols, requestHeaders, onopen, onmessage, onclose, onerror) {
    let headersObj = {};
    for (let [key, value] of requestHeaders) {
      headersObj[key] = value;
    }`;

const libcurlConnNew = `  connect(url, protocols, requestHeaders, onopen, onmessage, onclose, onerror) {
    if (typeof requestHeaders?.[Symbol.iterator] !== 'function') requestHeaders = Object.entries(requestHeaders ?? {});
    let headersObj = {};
    for (let [key, value] of requestHeaders) {
      headersObj[key] = value;
    }`;

const libcurlInitOld = `  async init() {
    if (this.transport) libcurl.transport = this.transport;
    if (!libcurl.ready) {
      await new Promise((resolve, reject) => {
        libcurl.onload = () => {
          console.log("loaded libcurl.js v" + libcurl.version.lib);
          this.ready = true;
          resolve(null);
        };
      });
    }
    libcurl.set_websocket(this.wisp);
    this.session = new libcurl.HTTPSession({
      proxy: this.proxy
    });
    if (this.connections) this.session.set_connections(...this.connections);
    this.ready = libcurl.ready;
    if (this.ready) {
      console.log("running libcurl.js v" + libcurl.version.lib);
      return;
    }
  }`;

const libcurlInitNew = `  async init() {
    if (this.transport)
      libcurl.transport = this.transport;
    libcurl.set_websocket(this.wisp);
    if (!libcurl.ready) {
      await new Promise((resolve, reject) => {
        libcurl.onload = () => {
          resolve(null);
        };
      });
    }
    console.log("running libcurl.js v" + libcurl.version.lib);
    this.session = new libcurl.HTTPSession({
      proxy: this.proxy
    });
    if (this.connections)
      this.session.set_connections(...this.connections);
    this.ready = true;
  }`;

const scramjetUnwrapperOld = `function c(e){e instanceof URL&&(e=e.toString());let t=location.origin+n.$W.prefix;if(e.startsWith("javascript:"))return e;`;
const scramjetUnwrapperNew = `function c(e){if(e==null)return"";e instanceof URL&&(e=e.toString());let t=location.origin+n.$W.prefix;if(e.startsWith("javascript:"))return e;`;
const scramjetRawHeadersOld = `i.rawHeaders=n.headers,i.rawResponse=n,i.finalURL=o.toString()`;
const scramjetRawHeadersNew = `i.rawHeaders=Array.isArray(n.headers)?Object.fromEntries(n.headers):n.headers,i.rawResponse=n,i.finalURL=o.toString()`;
const uvRawHeadersOld = `constructor(e, t) { for (let r in`;
const uvRawHeadersNew = `constructor(e, t) { t.rawHeaders = Array.isArray(t.rawHeaders) ? Object.fromEntries(t.rawHeaders) : t.rawHeaders; for (let r in`;
const uvOpenOld = `a.override(o,"open",(t,r,l)=>{if(!l.length)return t.apply(r,l);let[s]=l;return s=e.rewriteUrl(s),t.call(r,s)})`;
const uvOpenNew = `a.override(o,"open",(t,r,l)=>{if(!l.length)return t.apply(r,l);l=[...l];if(typeof l[0]=="string")l[0]=e.rewriteUrl(l[0]);return t.apply(r,l)})`;

const PATCHES = [
    { file: EPOXY_MJS, oldStr: epoxyReqOld, newStr: epoxyReqNew, desc: 'epoxy request header guard' },
    { file: EPOXY_MJS, oldStr: epoxyConnOld, newStr: epoxyConnNew, desc: 'epoxy connect header guard' },
    { file: EPOXY_JS, oldStr: epoxyReqOld, newStr: epoxyReqNew, desc: 'epoxy request header guard' },
    { file: EPOXY_JS, oldStr: epoxyConnOld, newStr: epoxyConnNew, desc: 'epoxy connect header guard' },
    { file: LIBCURL_MJS, oldStr: libcurlReqOld, newStr: libcurlReqNew, desc: 'libcurl request header guard' },
    { file: LIBCURL_MJS, oldStr: libcurlConnOld, newStr: libcurlConnNew, desc: 'libcurl connect header guard' },
    { file: LIBCURL_JS, oldStr: libcurlReqOld, newStr: libcurlReqNew, desc: 'libcurl request header guard' },
    { file: LIBCURL_JS, oldStr: libcurlConnOld, newStr: libcurlConnNew, desc: 'libcurl connect header guard' },
    { file: LIBCURL_MJS, oldStr: libcurlInitOld, newStr: libcurlInitNew, desc: 'libcurl init method' },
    { file: LIBCURL_JS, oldStr: libcurlInitOld, newStr: libcurlInitNew, desc: 'libcurl init method' },
    { file: SCRAMJET, oldStr: scramjetUnwrapperOld, newStr: scramjetUnwrapperNew, desc: 'scramjet unwrapper null guard' },
    { file: SCRAMJET, oldStr: scramjetRawHeadersOld, newStr: scramjetRawHeadersNew, desc: 'scramjet rawHeaders fix' },
    { file: UV, oldStr: uvRawHeadersOld, newStr: uvRawHeadersNew, desc: 'uv rawheaders fix' },
    { file: UV_HANHAN, oldStr: uvOpenOld, newStr: uvOpenNew, desc: 'uv window.open argument passthrough' },
];

const byFile = new Map();
for (const p of PATCHES) {
    if (!byFile.has(p.file)) byFile.set(p.file, []);
    byFile.get(p.file).push(p);
}

let patchedFiles = 0;
let upToDateFiles = 0;
let warningFiles = 0;

for (const [filePath, patches] of byFile) {
    const label = LABELS[filePath] || filePath;

    if (!existsSync(filePath)) {
        console.log(`  ${label} — file not found`);
        warningFiles++;
        continue;
    }

    let content = readFileSync(filePath, 'utf-8');
    let modified = false;
    let applied = 0;
    let already = 0;
    let failed = 0;

    for (const p of patches) {
        if (content.includes(p.oldStr)) {
            content = content.replaceAll(p.oldStr, p.newStr);
            modified = true;
            applied++;
        } else if (content.includes(p.newStr)) {
            already++;
        } else {
            console.warn(`  ${label} — could not apply '${p.desc}'`);
            failed++;
        }
    }

    if (modified) {
        writeFileSync(filePath, content, 'utf-8');
        patchedFiles++;
    } else if (already === patches.length) {
        upToDateFiles++;
    } else {
        warningFiles++;
    }

    if (modified || already === patches.length) {
        console.log(`  ✓  ${label}`);
    }
}

const total = [patchedFiles, upToDateFiles, warningFiles].reduce((a, b) => a + b, 0);
console.log(`\n${total} file(s) checked, ${patchedFiles} patched, ${upToDateFiles} up to date${warningFiles > 0 ? `, ${warningFiles} warning(s)` : ''}`);