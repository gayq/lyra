import fs from "node:fs";
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
        'assets/js/core/register.js',
        'assets/js/core/load.js',
        'assets/js/features/settings.js',
        'assets/js/features/games.js',
        'assets/js/features/shortcuts.js',
        'assets/js/features/toast.js',
        'assets/css/settings.css',
        'assets/css/games.css',
        'assets/css/toast.css',
        'assets/css/notifications.css'
    ],
    cssOrder: [
        'index.css',
        'settings.css',
        'games.css',
        'bookmarks.css',
        'newtab.css',
        'tabs.css',
        'notifications.css',
        'toast.css'
    ],
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
    htmlMinifierArgs: [
        "--use-short-doctype",
        "--collapse-boolean-attributes",
        "--remove-comments",
        "--collapse-whitespace",
        "--minify-css",
        "--minify-js"
    ]
};

const colors = {
    reset: "\x1b[0m",
    bold: "\x1b[1m",
    red: "\x1b[31m",
    green: "\x1b[32m",
    cyan: "\x1b[36m"
};

const normalizePath = (p) => p.split(path.sep).join('/');

async function runSilently(command, args = []) {
    const process = Bun.spawn({
        cmd: [command, ...args],
        stdout: "pipe",
        stderr: "pipe",
    });

    const exitCode = await process.exited;

    if (exitCode !== 0) {
        const stderr = await Bun.readableStreamToText(process.stderr);
        const stdout = await Bun.readableStreamToText(process.stdout);
        throw new Error(`Command failed [${exitCode}]: ${command} ${args.join(' ')}\nStderr: ${stderr}\nStdout: ${stdout}`);
    }
}

function getFileHash(filePath) {
    if (!fs.existsSync(filePath)) return null;
    const fileBuffer = fs.readFileSync(filePath);
    return crypto.createHash('md5').update(fileBuffer).digest('hex').slice(0, 10);
}

const steps = [
    {
        name: "Cleaning...",
        task: () => {
            fs.rmSync(CONFIG.dirs.dist, { recursive: true, force: true });
            fs.mkdirSync(CONFIG.dirs.dist, { recursive: true });
        }
    },
    {
        name: "Processing HTML...",
        task: async () => {
            await Promise.all([
                runSilently("html-minifier", ["--output", `${CONFIG.dirs.dist}/index.html`, `${CONFIG.dirs.src}/index.html`, ...CONFIG.htmlMinifierArgs]),
                runSilently("html-minifier", ["--output", `${CONFIG.dirs.dist}/404.html`, `${CONFIG.dirs.src}/404.html`, ...CONFIG.htmlMinifierArgs])
            ]);
        }
    },
    {
        name: "Processing CSS...",
        task: async () => {
            fs.mkdirSync(CONFIG.dirs.cssDest, { recursive: true });
            
            const glob = new Glob("**/*.css");
            const cssFiles = [];
            for await (const file of glob.scan({ cwd: CONFIG.dirs.cssSrc, absolute: true })) {
                cssFiles.push(file);
            }
            
            if (cssFiles.length > 0) {
                const getCssOrderIndex = (filePath) => {
                    const name = path.basename(filePath);
                    const relative = normalizePath(path.relative(CONFIG.dirs.cssSrc, filePath));

                    const order = CONFIG.cssOrder || [];
                    const relativeIndex = order.indexOf(relative);
                    if (relativeIndex !== -1) return relativeIndex;

                    const nameIndex = order.indexOf(name);
                    if (nameIndex !== -1) return nameIndex;

                    return Number.MAX_SAFE_INTEGER;
                };

                cssFiles.sort((a, b) => {
                    const aIndex = getCssOrderIndex(a);
                    const bIndex = getCssOrderIndex(b);
                    if (aIndex !== bIndex) return aIndex - bIndex;
                    return a.localeCompare(b);
                }); 

                const cssContents = await Promise.all(
                    cssFiles.map(file => Bun.file(file).text())
                );
                const combinedCss = cssContents.join("\n");

                const result = await postcss([
                    autoprefixer(), 
                    cssnano({ preset: 'default' }) 
                ]).process(combinedCss, {
                    from: undefined, 
                    to: path.join(CONFIG.dirs.cssDest, "style.css"),
                    map: false 
                });

                await Bun.write(path.join(CONFIG.dirs.cssDest, "style.css"), result.css);
            }

            const copyAssets = async (src, dest) => {
                if (!fs.existsSync(src)) return;
                const entries = await fs.promises.readdir(src, { withFileTypes: true });
                await Promise.all(entries.map(async (entry) => {
                    const srcPath = path.join(src, entry.name);
                    const destPath = path.join(dest, entry.name);
                    if (entry.isDirectory()) {
                        await fs.promises.mkdir(destPath, { recursive: true });
                        await copyAssets(srcPath, destPath);
                    } else if (!entry.name.endsWith('.css')) {
                        const file = Bun.file(srcPath);
                        await Bun.write(destPath, file);
                    }
                }));
            };

            await copyAssets(CONFIG.dirs.cssSrc, CONFIG.dirs.cssDest);
        }
    },
    {
        name: "Processing JS...",
        task: async () => {
            fs.mkdirSync(CONFIG.dirs.jsDest, { recursive: true });
            fs.mkdirSync(CONFIG.dirs.swDest, { recursive: true });

            const bunBuildOutput = await Bun.build({
                entrypoints: [path.join(CONFIG.dirs.src, 'assets/js/entry.js')],
                minify: true,
                sourcemap: 'none',
            });

            if (!bunBuildOutput.success) {
                console.error(bunBuildOutput.logs);
                throw new Error("Bun.build failed");
            }

            const appCode = await bunBuildOutput.outputs[0].text();

            const appObfuscated = obfuscate(appCode, {
                ...CONFIG.obfuscation,
                reservedStrings: ['./b/sw.js']
            }).getObfuscatedCode();

            await Bun.write(path.join(CONFIG.dirs.jsDest, 'app.js'), appObfuscated);

            let swCode = await Bun.file(path.join(CONFIG.dirs.swSrc, "sw.js")).text();
            swCode = swCode.replace("__SERVER_IP__", process.env.IP || "127.0.0.1");

            const swObfuscated = obfuscate(swCode, CONFIG.obfuscation).getObfuscatedCode();
            
            await Bun.write(path.join(CONFIG.dirs.swDest, "sw.js"), swObfuscated);
        }
    },
    {
        name: "Finishing up...",
        task: async () => {
            const manifest = {};
            const distDir = CONFIG.dirs.dist;

            const filesToHash = {
                'assets/js/index.js': 'assets/js/app.js',
                'assets/css/index.css': 'assets/css/style.css',
                'b/sw.js': 'b/sw.js'
            };

            for (const [htmlRef, diskPath] of Object.entries(filesToHash)) {
                const fullPath = path.join(distDir, diskPath);
                if (!fs.existsSync(fullPath)) continue;

                const hash = getFileHash(fullPath);
                const ext = path.extname(fullPath);
                const dir = path.dirname(fullPath);
                
                const newFileName = `${hash}${ext}`;
                const newFullPath = path.join(dir, newFileName);
                
                fs.renameSync(fullPath, newFullPath);
                
                const relPath = normalizePath(path.relative(distDir, newFullPath));
                manifest[htmlRef] = relPath;
            }

            const htmlGlob = new Glob('**/*.html');
            for await (const htmlFile of htmlGlob.scan({ cwd: distDir, absolute: true })) {
                let content = await Bun.file(htmlFile).text();
                
                if (!content.startsWith("\n")) content = "\n" + content;

                for (const [original, hashed] of Object.entries(manifest)) {
                    if (original === 'assets/js/index.js' || original === 'assets/css/index.css') {
                        const escaped = original.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                        const regex = new RegExp(`(src|href)=["']/?${escaped}["']`, 'g');
                        content = content.replace(regex, `$1="/${hashed}" defer`);
                    }
                }

                for (const fileToRemove of CONFIG.devFilesToRemove) {
                    const escaped = fileToRemove.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                    content = content.replace(new RegExp(`<script[^>]*src=["']/?${escaped}["'][^>]*>\\s*</script>\\s*\\n?`, 'gi'), '');
                    content = content.replace(new RegExp(`<link[^>]*href=["']/?${escaped}["'][^>]*>\\s*\\n?`, 'gi'), '');
                }

                await Bun.write(htmlFile, content);
            }

            const appJsRelPath = manifest['assets/js/index.js'];
            if (appJsRelPath && manifest['b/sw.js']) {
                const appJsPath = path.join(distDir, appJsRelPath);
                let appContent = await Bun.file(appJsPath).text();
                
                const swOriginal = 'b/sw.js';
                const swHashed = manifest['b/sw.js'];
                const swEscaped = swOriginal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                
                appContent = appContent.replace(new RegExp(`(['"\`])\\./${swEscaped}\\1`, 'g'), `$1./${swHashed}$1`);
                appContent = appContent.replace(new RegExp(`(['"\`])/${swEscaped}\\1`, 'g'), `$1/${swHashed}$1`);

                await Bun.write(appJsPath, appContent);
            }
        }
    }
];

async function main() {
    console.log(`\n${colors.bold}Starting build...${colors.reset}\n`);
    const startTime = performance.now();
    const totalSteps = steps.length;
    let spinner;

    try {
        for (let i = 0; i < totalSteps; i++) {
            const step = steps[i];
            const progress = `[${i + 1}/${totalSteps}]`;
            const label = `${progress} ${step.name}`;

            let frame = 0;
            const spinnerFrames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠇', '⠏'];
            process.stdout.write('\x1B[?25l');
            
            spinner = setInterval(() => {
                process.stdout.write(`\r${colors.cyan}${spinnerFrames[frame]}${colors.reset} ${label}...`);
                frame = (frame + 1) % spinnerFrames.length;
            }, 80);

            await step.task();

            clearInterval(spinner);
            spinner = null;
            process.stdout.write('\r'.padEnd(process.stdout.columns) + '\r');
            console.log(`${colors.green}✔${colors.reset} ${label}`);
        }

        const duration = ((performance.now() - startTime) / 1000).toFixed(2);
        console.log(`\n${colors.bold}${colors.green}Build completed in ${duration}s!${colors.reset}\n`);

    } catch (err) {
        if (spinner) clearInterval(spinner);
        process.stdout.write('\r'.padEnd(process.stdout.columns) + '\r');
        console.error(`\n${colors.bold}${colors.red}✖ Build Failed${colors.reset}`);
        console.error(err);
        process.exit(1);
    } finally {
        process.stdout.write('\x1B[?25h');
    }
}

main();
