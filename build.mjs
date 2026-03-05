import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { Glob } from "bun";
import { obfuscate } from 'javascript-obfuscator';
import postcss from "postcss";
import autoprefixer from "autoprefixer";
import cssnano from "cssnano";
import zlib from "node:zlib";
import { promisify } from "node:util";

const brotliCompress = promisify(zlib.brotliCompress);
const gzip = promisify(zlib.gzip);

const CONFIG = {
    dirs: {
        src: "src",
        dist: "dist",
        cssSrc: "src/assets/css",
        cssDest: "dist/assets/css",
        jsDest: "dist/assets/js",
        swSrc: "src/b",
        swDest: "dist/b"
    },
    filesToRemove: [
        'assets/js/core/register.js', 'assets/js/core/load.js', 'assets/js/features/settings.js',
        'assets/js/features/games.js', 'assets/js/features/shortcuts.js', 'assets/js/features/toast.js',
        'assets/css/settings.css', 'assets/css/games.css', 'assets/css/toast.css', 'assets/css/notifications.css',
        'assets/css/bookmarks.css', '/assets/css/tabs.css', '/assets/css/newtab.css', '/assets/css/cloudsync.css',
        'assets/css/index.css', 'assets/css/watch.css', 'assets/css/themes.css'
    ],
    cssOrder: ['themes.css', 'index.css', 'settings.css', 'games.css', 'bookmarks.css', 'newtab.css', 'tabs.css', 'notifications.css', 'toast.css', 'watch.css'],
    obfuscation: {
        compact: true,
        controlFlowFlattening: true,
        controlFlowFlatteningThreshold: 0.15,
        deadCodeInjection: false,
        disableConsoleOutput: true,
        identifierNamesGenerator: 'hexadecimal',
        log: false,
        debugProtection: false,
        renameGlobals: true,
        selfDefending: true,
        stringArray: true,
        stringArrayEncoding: ['base64'],
        stringArrayRotate: true,
        stringArrayShuffle: true,
        stringArrayThreshold: 1,
        stringArrayWrappersCount: 1,
        stringArrayWrappersChained: true,
        stringArrayWrappersType: 'function',
        stringArrayCallsTransform: true,
        stringArrayCallsTransformThreshold: 0.5,
        splitStrings: true,
        splitStringsChunkLength: 8,
        transformObjectKeys: true,
        numbersToExpressions: false,
        unicodeEscapeSequence: true
    }
};

const normalizePath = (p) => p.split(path.sep).join('/');

async function getFileHash(filePath) {
    const buf = await Bun.file(filePath).arrayBuffer();
    return new Bun.CryptoHasher("md5").update(buf).digest("hex").slice(0, 10);
}

const tasks = {
    async processHTML() {
        const files = ["index.html", "404.html"];
        await Promise.all(files.map(async file => {
            const src = path.join(CONFIG.dirs.src, file);
            const dest = path.join(CONFIG.dirs.dist, file);
            if (existsSync(src)) await fs.copyFile(src, dest);
        }));
    },

    async processCSS() {
        await fs.mkdir(CONFIG.dirs.cssDest, { recursive: true });
        const glob = new Glob("**/*.css");
        const cssFiles = [];
        for await (const file of glob.scan({ cwd: CONFIG.dirs.cssSrc, absolute: true })) {
            cssFiles.push(file);
        }

        if (cssFiles.length > 0) {
            cssFiles.sort((a, b) => {
                const aIdx = CONFIG.cssOrder.indexOf(path.basename(a));
                const bIdx = CONFIG.cssOrder.indexOf(path.basename(b));
                return (aIdx === -1 ? 999 : aIdx) - (bIdx === -1 ? 999 : bIdx);
            });

            const contents = await Promise.all(cssFiles.map(f => Bun.file(f).text()));
            const result = await postcss([autoprefixer(), cssnano()]).process(contents.join("\n"), { from: undefined });
            await Bun.write(path.join(CONFIG.dirs.cssDest, "style.css"), result.css);
        }

        const copyNonCss = async (src, dest) => {
            if (!existsSync(src)) return;
            const entries = await fs.readdir(src, { withFileTypes: true });
            await Promise.all(entries.map(async (entry) => {
                const s = path.join(src, entry.name);
                const d = path.join(dest, entry.name);
                if (entry.isDirectory()) {
                    await fs.mkdir(d, { recursive: true });
                    await copyNonCss(s, d);
                } else if (!entry.name.endsWith('.css')) {
                    await fs.copyFile(s, d);
                }
            }));
        };
        await copyNonCss(CONFIG.dirs.cssSrc, CONFIG.dirs.cssDest);
    },

    async processJS() {
        await Promise.all([
            fs.mkdir(CONFIG.dirs.jsDest, { recursive: true }),
            fs.mkdir(CONFIG.dirs.swDest, { recursive: true })
        ]);

        const buildId = crypto.randomBytes(4).toString('hex');

        const bunBuild = await Bun.build({
            entrypoints: [path.join(CONFIG.dirs.src, 'assets/js/entry.js')],
            minify: true,
        });
        if (!bunBuild.success) throw new Error("bun build failed");

        const appCode = (await bunBuild.outputs[0].text()).replace("__BUILD_ID__", buildId);
        const serverIp = process.env.IP || "127.0.0.1";
        console.log(`${serverIp}`);
        let swCode = (await Bun.file(path.join(CONFIG.dirs.swSrc, "sw.js")).text())
            .replace("__SERVER_IP__", serverIp)
            .replace("__BUILD_ID__", buildId);

        const serserPath = path.join("public", "b", "u", "serser.js");
        if (existsSync(serserPath)) {
            let serser = await Bun.file(serserPath).text();
            serser = serser.replace(/__SERVER_IP__/g, serverIp);
            await Bun.write(serserPath, serser);
        }

        const [appObf, swObf] = await Promise.all([
            Promise.resolve(obfuscate(appCode, { ...CONFIG.obfuscation, reservedStrings: ['./b/sw.js'] }).getObfuscatedCode()),
            Promise.resolve(obfuscate(swCode, CONFIG.obfuscation).getObfuscatedCode())
        ]);

        await Promise.all([
            Bun.write(path.join(CONFIG.dirs.jsDest, 'app.js'), appObf),
            Bun.write(path.join(CONFIG.dirs.swDest, "sw.js"), swObf)
        ]);
    }
};

async function main() {
    console.log("\nstarting build...\n");
    const startTime = performance.now();

    try {
        await fs.rm(CONFIG.dirs.dist, { recursive: true, force: true });
        await fs.mkdir(CONFIG.dirs.dist, { recursive: true });

        await Promise.all([
            tasks.processHTML(),
            tasks.processCSS(),
            tasks.processJS()
        ]);

        const manifest = {};
        const filesToHash = {
            'assets/js/index.js': 'assets/js/app.js',
            'assets/css/index.css': 'assets/css/style.css',
            'b/sw.js': 'b/sw.js'
        };

        for (const [htmlRef, diskPath] of Object.entries(filesToHash)) {
            const fullPath = path.join(CONFIG.dirs.dist, diskPath);
            if (!existsSync(fullPath)) continue;

            const hash = await getFileHash(fullPath);
            const ext = path.extname(fullPath);
            const newFullPath = path.join(path.dirname(fullPath), `${hash}${ext}`);

            await fs.rename(fullPath, newFullPath);
            manifest[htmlRef] = normalizePath(path.relative(CONFIG.dirs.dist, newFullPath));
        }

        const htmlGlob = new Glob('**/*.html');
        for await (const htmlFile of htmlGlob.scan({ cwd: CONFIG.dirs.dist, absolute: true })) {
            let content = await Bun.file(htmlFile).text();
            if (!content.startsWith("\n")) content = "\n" + content;

            for (const [original, hashed] of Object.entries(manifest)) {
                if (original === 'b/sw.js') continue;
                const escaped = original.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                content = content.replace(new RegExp(`(src)=["']/?${escaped}["']`, 'g'), `$1="/${hashed}" defer`);
                content = content.replace(new RegExp(`(href)=["']/?${escaped}["']`, 'g'), `$1="/${hashed}"`);
            }

            for (const file of CONFIG.filesToRemove) {
                const escaped = file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                content = content.replace(new RegExp(`<script[^>]*src=["']/?${escaped}["'][^>]*>\\s*</script>\\s*\\n?`, 'gi'), '');
                content = content.replace(new RegExp(`<link[^>]*href=["']/?${escaped}["'][^>]*>\\s*\\n?`, 'gi'), '');
            }
            await Bun.write(htmlFile, content);
        }

        const appJsPath = path.join(CONFIG.dirs.dist, manifest['assets/js/index.js']);
        if (existsSync(appJsPath) && manifest['b/sw.js']) {
            let appContent = await Bun.file(appJsPath).text();
            const swHashed = manifest['b/sw.js'];
            appContent = appContent.replace(/(['"`])\.\/b\/sw\.js\1/g, `$1./${swHashed}$1`)
                .replace(/(['"`])\/b\/sw\.js\1/g, `$1/${swHashed}$1`);
            await Bun.write(appJsPath, appContent);
        }

        const compressGlob = new Glob('**/*.{css,js,html,mjs}');
        const compressJobs = [];
        for await (const file of compressGlob.scan({ cwd: CONFIG.dirs.dist, absolute: true })) {
            const content = await Bun.file(file).arrayBuffer();
            const buf = Buffer.from(content);
            compressJobs.push(
                brotliCompress(buf, {
                    params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 }
                }).then(br => Bun.write(file + '.br', br)),
                gzip(buf, { level: 9 }).then(gz => Bun.write(file + '.gz', gz))
            );
        }
        await Promise.all(compressJobs);

        const duration = ((performance.now() - startTime) / 1000).toFixed(2);
        console.log(`\nbuild completed in ${duration}s!!\n`);

    } catch (err) {
        console.error("\nbuild failed");
        console.error(err);
        process.exit(1);
    }
}

main();