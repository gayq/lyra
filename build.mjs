import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { Glob } from "bun";
import { obfuscate } from 'javascript-obfuscator';

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
    let errorMsg = `Command failed with exit code ${exitCode}: ${command} ${args.join(' ')}`;
    if (stderr) errorMsg += `\n--- Stderr ---\n${stderr}`;
    if (stdout) errorMsg += `\n--- Stdout ---\n${stdout}`;
    throw new Error(errorMsg);
  }
}

const colors = {
    reset: "\x1b[0m",
    bold: "\x1b[1m",
    red: "\x1b[31m",
    green: "\x1b[32m",
};

const style = (text, code) => `${code}${text}${colors.reset}`;
const bold = (text) => style(text, colors.bold);
const green = (text) => style(text, colors.green);
const red = (text) => style(text, colors.red);

function getFileHash(filePath) {
  if (!fs.existsSync(filePath)) {
    console.error(`File not found, cannot hash: ${filePath}`);
    return null;
  }
  const fileBuffer = fs.readFileSync(filePath);
  return crypto.createHash('md5').update(fileBuffer).digest('hex').slice(0, 12);
}

function updateFilePaths(filePath, manifest) {
  if (!fs.existsSync(filePath)) return;

  let content = fs.readFileSync(filePath, 'utf8');
  let isUpdated = false;

  for (const [original, hashed] of Object.entries(manifest)) {
    const originalEscaped = original.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

    const htmlRegex = new RegExp(`(src|href)=["']/?${originalEscaped}["']`, 'g');
    const jsImportRegex = new RegExp(`(['"\`])/?${originalEscaped}\\1`, 'g');
    const swStringLiteralRegex = /(['"`])\.\/b\/sw\.js\1/g; 

    if (htmlRegex.test(content)) {
        content = content.replace(htmlRegex, `$1="/${hashed}"`);
        isUpdated = true;
    }
    if (jsImportRegex.test(content)) {
        content = content.replace(jsImportRegex, `$1/${hashed}$1`);
        isUpdated = true;
    }
    if (original === 'b/sw.js' && swStringLiteralRegex.test(content)) {
        content = content.replace(swStringLiteralRegex, `$1./${hashed}$1`);
        isUpdated = true;
    }
  }

  if (isUpdated) {
    fs.writeFileSync(filePath, content, 'utf8');
  }
}

const htmlMinifierOptions = [
    "--use-short-doctype",
    "--collapse-boolean-attributes"
];

const steps = [
    { name: "Cleaning up old build", task: () => fs.rmSync("dist", { recursive: true, force: true }) },
    { name: "Creating new build", task: () => fs.mkdirSync("dist", { recursive: true }) },
    {
        name: "Processing HTML",
        task: async () => {
            await runSilently("html-minifier", [
                "--output", "dist/index.html", 
                "src/index.html", 
                ...htmlMinifierOptions
            ]);
            await runSilently("html-minifier", [
                "--output", "dist/404.html", 
                "src/404.html", 
                ...htmlMinifierOptions
            ]);
        }
    },
    {
        name: "Processing CSS",
        task: async () => {
            fs.mkdirSync("dist/assets/css", { recursive: true });
            const glob = new Glob("src/assets/css/**/*.css");
            
            const files = await Array.fromAsync(glob.scan());
            if (files.length === 0) return;
            files.sort();

            let combinedCss = "";
            for (const file of files) {
                combinedCss += await Bun.file(file).text() + "\n";
            }

            const tempCssPath = "dist/assets/css/temp.css";
            await Bun.write(tempCssPath, combinedCss);
            
            await runSilently("bun", [ 
                path.join(process.cwd(), "node_modules", "postcss-cli", "index.js"),
                tempCssPath,
                "--use", "cssnano",
                "--output", "dist/assets/css/style.css",
                "--no-map"
            ]);

            fs.rmSync(tempCssPath);
        }
    },
    {
        name: "Processing JS",
        task: async () => {
            fs.mkdirSync("dist/assets/js", { recursive: true });
            
            const tempFilePath = path.join(process.cwd(), 'dist', 'assets', 'js', 'app.temp.js');
            const finalFilePath = path.join(process.cwd(), 'dist', 'assets', 'js', 'app.js');

            const bunBuildOutput = await Bun.build({
                entrypoints: ['src/assets/js/entry.js'],
                minify: true,
                sourcemap: 'none',
            });

            if (!bunBuildOutput.success || bunBuildOutput.outputs.length === 0) {
                console.error(bunBuildOutput.logs);
                throw new Error("Bun.build for JS failed or produced no output");
            }

            await Bun.write(tempFilePath, bunBuildOutput.outputs[0]);

            if (!fs.existsSync(tempFilePath)) {
              throw new Error(`Bun.write failed to create temp file: ${tempFilePath}`);
            }
            
            const jsCode = await Bun.file(tempFilePath).text();

            const obfuscationOptions = {
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
            };
            
            const appObfuscationOptions = {
                ...obfuscationOptions,
                reservedStrings: ['./b/sw.js'] 
            };
            
            const swObfuscationOptions = {
                ...obfuscationOptions
            };

            const appObfuscationResult = obfuscate(jsCode, appObfuscationOptions);
            const appObfuscatedCode = appObfuscationResult.getObfuscatedCode();

            await Bun.write(finalFilePath, appObfuscatedCode);

            if (fs.existsSync(tempFilePath)) { 
              fs.rmSync(tempFilePath); 
            }
            
            fs.mkdirSync("dist/b", { recursive: true });
            
            let swCode = await Bun.file(path.join("src", "b", "sw.js")).text();
            
            const serverIP = process.env.IP || "127.0.0.1";
            swCode = swCode.replace("__SERVER_IP__", serverIP);

            const swObfuscationResult = obfuscate(swCode, swObfuscationOptions);
            const swObfuscatedCode = swObfuscationResult.getObfuscatedCode();

            await Bun.write(
                path.join("dist", "b", "sw.js"),
                swObfuscatedCode
            );
        }
    },
    { 
        name: "Hashing",
        task: async () => {
            const manifest = {};
            const distDir = "dist";
            
            const filesToHashMap = {
                'assets/js/index.js': 'assets/js/app.js', 
                'assets/css/index.css': 'assets/css/style.css',
                'b/sw.js': 'b/sw.js'
            };

            const pathsToRemoveFromHtml = [
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
            ];

            for (const [pathInHtml, pathOnDisk] of Object.entries(filesToHashMap)) {
                const fullPath = path.join(distDir, pathOnDisk);
                if (!fs.existsSync(fullPath)) continue;

                const hash = getFileHash(fullPath);
                const ext = path.extname(fullPath);
                const dir = path.dirname(fullPath);
                
                const newFileName = `${hash}${ext}`;
                const newFullPath = path.join(dir, newFileName);
                
                fs.renameSync(fullPath, newFullPath);
                
                const newHashedPath = path.relative(distDir, newFullPath).replace(/\\/g, '/');
                manifest[pathInHtml] = newHashedPath; 
            }

            const htmlGlob = new Glob('dist/**/*.html');
            const htmlFiles = await Array.fromAsync(htmlGlob.scan({ absolute: true }));

            const contentToPrepend = "\n";

            for (const htmlFile of htmlFiles) {
                let content = fs.readFileSync(htmlFile, 'utf8');
                let isUpdated = false;

                if (!content.startsWith(contentToPrepend)) {
                    content = contentToPrepend + content;
                    isUpdated = true;
                }

                for (const [original, hashedPath] of Object.entries(manifest)) {
                    if (original === 'assets/js/index.js' || original === 'assets/css/index.css') {
                        const escapedOriginal = original.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                        const regex = new RegExp(`(src|href)=["']/?${escapedOriginal}["']`);
                        if (regex.test(content)) {
                            content = content.replace(regex, `$1="/${hashedPath}" defer`);
                            isUpdated = true;
                        }
                    }
                }

                for (const originalPathToRemove of pathsToRemoveFromHtml) {
                    const escapedPath = originalPathToRemove.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
                    const scriptRegex = new RegExp(`<script[^>]*src=["']/?${escapedPath}["'][^>]*>\\s*</script>\\s*\\n?`, 'gi');
                    const linkRegex = new RegExp(`<link[^>]*href=["']/?${escapedPath}["'][^>]*>\\s*\\n?`, 'gi');

                     if (scriptRegex.test(content)) {
                         content = content.replace(scriptRegex, '');
                         isUpdated = true;
                     }
                     if (linkRegex.test(content)) {
                         content = content.replace(linkRegex, '');
                         isUpdated = true;
                     }
                }

                if (isUpdated) {
                    fs.writeFileSync(htmlFile, content, 'utf8');
                }
            }
            
            const appJsHashedPath = manifest['assets/js/index.js']; 
            if (appJsHashedPath) {
                const fullAppJsPath = path.join(distDir, appJsHashedPath);
                if (manifest['b/sw.js']) { 
                  updateFilePaths(fullAppJsPath, { 'b/sw.js': manifest['b/sw.js'] }); 
                }
            }
        }
    }
];

async function main() {
    console.log(bold("Starting Build..."));
    const totalSteps = steps.length;
    let spinner;
    let currentStepText = "";

    try {
        for (let i = 0; i < totalSteps; i++) {
            const step = steps[i];
            const progress = `[${i + 1}/${totalSteps}]`;
            currentStepText = `${progress} ${step.name}`;

            let frame = 0;
            const spinnerFrames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', 'S', '⠇', '⠏'];

            process.stdout.write('\x1B[?25l');
            spinner = setInterval(() => {
                process.stdout.write(`\r${currentStepText}... ${spinnerFrames[frame]}`);
                frame = (frame + 1) % spinnerFrames.length;
            }, 80);

            await step.task();

            clearInterval(spinner);
            spinner = null;
            process.stdout.write(`\r${currentStepText}... ${green('OK')}\n`);
        }

        console.log(bold(green("\nBuild completed!")));

    } catch (err) {
        if (spinner) clearInterval(spinner);
        process.stdout.write('\r'.padEnd(process.stdout.columns) + '\r');
        console.error(`\n${bold(red('Build failed'))} during step: "${currentStepText}"`);
        console.error(err);
        process.exit(1);
    } finally {
        process.stdout.write('\x1B[?25h');
    }
}

main();