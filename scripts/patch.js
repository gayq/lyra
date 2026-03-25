import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const BUGGY_INIT = `  async init() {
    if (this.transport)
      libcurl.transport = this.transport;
    libcurl.set_websocket(this.wisp);
    this.session = new libcurl.HTTPSession({
      proxy: this.proxy
    });
    if (this.connections)
      this.session.set_connections(...this.connections);
    this.ready = libcurl.ready;
    if (this.ready) {
      console.log("running libcurl.js v" + libcurl.version.lib);
      return;
    }
    ;
    await new Promise((resolve, reject) => {
      libcurl.onload = () => {
        console.log("loaded libcurl.js v" + libcurl.version.lib);
        this.ready = true;
        resolve(null);
      };
    });
  }`;

const FIXED_INIT = `  async init() {
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

const filesToPatch = [
    join(ROOT, 'node_modules', '@mercuryworkshop', 'libcurl-transport', 'dist', 'index.mjs'),
    join(ROOT, 'node_modules', '@mercuryworkshop', 'libcurl-transport', 'dist', 'index.js'),
];

let patchedCount = 0;

for (const filePath of filesToPatch) {
    if (!existsSync(filePath)) {
        console.log(`[patch] skipping ${filePath} (not found)`);
        continue;
    }

    let content = readFileSync(filePath, 'utf-8');

    if (content.includes(FIXED_INIT)) {
        console.log(`[patch] ${filePath} already patched`);
        patchedCount++;
        continue;
    }

    if (!content.includes(BUGGY_INIT)) {
        console.warn(`[patch] could not find expected code in ${filePath}`);
        continue;
    }

    content = content.replace(BUGGY_INIT, FIXED_INIT);
    writeFileSync(filePath, content, 'utf-8');
    console.log(`[patch] patched ${filePath}`);
    patchedCount++;
}

if (patchedCount > 0) {
    console.log(`[patch] successfully patched ${patchedCount} file(s)`);
} else {
    console.warn('[patch] no files were patched');
}
