import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const NEGATIVE = '... /ᐠ - ˕ -マ';
const POSITIVE = '!! (˵◝ ⩊  ◜˵マ';
const EPOXY_MJS = join(ROOT, 'node_modules', '@mercuryworkshop', 'epoxy-transport', 'dist', 'index.mjs');
const EPOXY_JS = join(ROOT, 'node_modules', '@mercuryworkshop', 'epoxy-transport', 'dist', 'index.js');
const LIBCURL_MJS = join(ROOT, 'node_modules', '@mercuryworkshop', 'libcurl-transport', 'dist', 'index.mjs');
const LIBCURL_JS = join(ROOT, 'node_modules', '@mercuryworkshop', 'libcurl-transport', 'dist', 'index.js');
const LABELS = {
    [EPOXY_MJS]: 'epoxy-transport (mjs)',
    [EPOXY_JS]: 'epoxy-transport (js)',
    [LIBCURL_MJS]: 'libcurl-transport (mjs)',
    [LIBCURL_JS]: 'libcurl-transport (js)',
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
    console.log("running libcurl.js v" + libcurl.version.lib + "!! (˵◝ ⩊  ◜˵マ");
    this.session = new libcurl.HTTPSession({
      proxy: this.proxy
    });
    if (this.connections)
      this.session.set_connections(...this.connections);
    this.ready = true;
  }`;

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
        console.warn(`  ${label} — file not found${NEGATIVE}`);
        warningFiles++;
        continue;
    }

    let content = readFileSync(filePath, 'utf-8');
    let modified = false;
    let already = 0;

    for (const p of patches) {
        if (content.includes(p.oldStr)) {
            content = content.replaceAll(p.oldStr, p.newStr);
            modified = true;
        } else if (content.includes(p.newStr)) {
            already++;
        } else {
            console.warn(`  ${label} — could not apply '${p.desc}'${NEGATIVE}`);
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
        console.log(`  ✓  ${label}${POSITIVE}`);
    }
}

const total = [patchedFiles, upToDateFiles, warningFiles].reduce((a, b) => a + b, 0);
const summary = `${total} file(s) checked, ${patchedFiles} patched, ${upToDateFiles} up to date${warningFiles > 0 ? `, ${warningFiles} warning(s)` : ''}`;
console.log(`${summary}${warningFiles > 0 ? NEGATIVE : POSITIVE}`);