import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { Glob } from "bun";
import { obfuscate } from 'javascript-obfuscator';
import postcss from "postcss";
import autoprefixer from "autoprefixer";
import cssnano from "cssnano";

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
    devFilesToRemove: [
        'assets/js/core/register.js', 'assets/js/core/load.js', 'assets/js/features/settings.js',
        'assets/js/features/games.js', 'assets/js/features/shortcuts.js', 'assets/js/features/toast.js',
        'assets/css/settings.css', 'assets/css/games.css', 'assets/css/toast.css', 'assets/css/notifications.css'
    ],
    cssOrder: ['index.css', 'settings.css', 'games.css', 'bookmarks.css', 'newtab.css', 'tabs.css', 'notifications.css', 'toast.css'],
    obfuscation: {
        compact: true,
        controlFlowFlattening: true,
        controlFlowFlatteningThreshold: 1, 
        deadCodeInjection: true,
        deadCodeInjectionThreshold: 1, 
        disableConsoleOutput: true, 
        identifierNamesGenerator: 'hexadecimal', 
        log: false,
        debugProtection: true,
        debugProtectionInterval: 10,
        renameGlobals: true, 
        selfDefending: true, 
        stringArray: true, 
        stringArrayEncoding: ['rc4'], 
        stringArrayRotate: true, 
        stringArrayShuffle: true, 
        stringArrayThreshold: 1, 
        stringArrayWrappersCount: 5,
        stringArrayWrappersChained: true,
        stringArrayWrappersType: 'function',
        splitStrings: true,
        splitStringsChunkLength: 1,
        unicodeEscapeSequence: true
    },
    htmlMinifierArgs: ["--use-short-doctype", "--collapse-boolean-attributes", "--remove-comments", "--collapse-whitespace", "--minify-css", "--minify-js"]
};

const colors = { reset: "\x1b[0m", bold: "\x1b[1m", red: "\x1b[31m", green: "\x1b[32m", cyan: "\x1b[36m" };
const normalizePath = (p) => p.split(path.sep).join('/');

async function runSilently(command, args = []) {
    const process = Bun.spawn({ cmd: [command, ...args], stdout: "pipe", stderr: "pipe" });
    const exitCode = await process.exited;
    if (exitCode !== 0) throw new Error(`Command failed: ${command}`);
}

async function getFileHash(filePath) {
    const fileBuffer = await fs.readFile(filePath);
    return crypto.createHash('md5').update(fileBuffer).digest('hex').slice(0, 10);
}

const tasks = {
    async processHTML() {
        const files = ["index.html", "404.html"];
        await Promise.all(files.map(file => 
            runSilently("html-minifier", ["--output", path.join(CONFIG.dirs.dist, file), path.join(CONFIG.dirs.src, file), ...CONFIG.htmlMinifierArgs])
        ));
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
                const getIdx = (p) => {
                    const name = path.basename(p);
                    const idx = CONFIG.cssOrder.indexOf(name);
                    return idx === -1 ? 999 : idx;
                };
                return getIdx(a) - getIdx(b);
            });

            const contents = await Promise.all(cssFiles.map(f => Bun.file(f).text()));
            const result = await postcss([autoprefixer(), cssnano()]).process(contents.join("\n"), { from: undefined });
            await Bun.write(path.join(CONFIG.dirs.cssDest, "style.css"), result.css);
        }

        const copyAssets = async (src, dest) => {
            if (!existsSync(src)) return;
            const entries = await fs.readdir(src, { withFileTypes: true });
            await Promise.all(entries.map(async (entry) => {
                const srcPath = path.join(src, entry.name);
                const destPath = path.join(dest, entry.name);
                if (entry.isDirectory()) {
                    await fs.mkdir(destPath, { recursive: true });
                    await copyAssets(srcPath, destPath);
                } else if (!entry.name.endsWith('.css')) {
                    await fs.copyFile(srcPath, destPath);
                }
            }));
        };
        await copyAssets(CONFIG.dirs.cssSrc, CONFIG.dirs.cssDest);
    },

    async processJS() {
        await Promise.all([fs.mkdir(CONFIG.dirs.jsDest, { recursive: true }), fs.mkdir(CONFIG.dirs.swDest, { recursive: true })]);
        const buildId = crypto.randomBytes(4).toString('hex');

        const bunBuild = await Bun.build({
            entrypoints: [path.join(CONFIG.dirs.src, 'assets/js/entry.js')],
            minify: true,
        });
        if (!bunBuild.success) throw new Error("Bun build failed");

        const appCode = (await bunBuild.outputs[0].text()).replace("__BUILD_ID__", buildId);
        const swCode = (await Bun.file(path.join(CONFIG.dirs.swSrc, "sw.js")).text()).replace("__SERVER_IP__", process.env.IP || "127.0.0.1");

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
    console.log(`\n${colors.bold}Starting build...${colors.reset}\n`);
    const startTime = performance.now();

    try {
        await fs.rm(CONFIG.dirs.dist, { recursive: true, force: true });
        await fs.mkdir(CONFIG.dirs.dist, { recursive: true });

        console.log(`${colors.cyan}Processing assets...${colors.reset}`);
        await Promise.all([
            tasks.processHTML(),
            tasks.processCSS(),
            tasks.processJS()
        ]);

        console.log(`${colors.cyan}Finishing and hashing...${colors.reset}`);
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
            const newName = `${hash}${ext}`;
            const newFullPath = path.join(path.dirname(fullPath), newName);
            
            await fs.rename(fullPath, newFullPath);
            manifest[htmlRef] = normalizePath(path.relative(CONFIG.dirs.dist, newFullPath));
        }

        const htmlGlob = new Glob('**/*.html');
        for await (const htmlFile of htmlGlob.scan({ cwd: CONFIG.dirs.dist, absolute: true })) {
            let content = await Bun.file(htmlFile).text();
            if (!content.startsWith("\n")) content = "\n" + content;

            for (const [original, hashed] of Object.entries(manifest)) {
                if (original !== 'b/sw.js') {
                    const escaped = original.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                    content = content.replace(new RegExp(`(src|href)=["']/?${escaped}["']`, 'g'), `$1="/${hashed}" defer`);
                }
            }

            for (const file of CONFIG.devFilesToRemove) {
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

        const duration = ((performance.now() - startTime) / 1000).toFixed(2);
        console.log(`\n${colors.bold}${colors.green}Build completed in ${duration}s!${colors.reset}\n`);

    } catch (err) {
        console.error(`\n${colors.red}Build Failed${colors.reset}`);
        console.error(err);
        process.exit(1);
    }
}

main();