import { defineConfig } from "vite";
import preact from "@preact/preset-vite";
import meow from "./build.js";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

export default defineConfig({
  plugins: [
    preact(),
    meow(),
  ],
  root: "src",
  publicDir: false,
  server: {
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin",
      "Cross-Origin-Embedder-Policy": "require-corp",
      "Cross-Origin-Resource-Policy": "cross-origin",
    },
  },
  build: {
    outDir: "../dist",
    emptyOutDir: true,
    sourcemap: false,
    target: "esnext",
    minify: "terser",
    terserOptions: {
      compress: { drop_console: true, passes: 2 },
      mangle: true,
    },
    cssMinify: "lightningcss",
    assetsInlineLimit: 8192,
    rollupOptions: {
      onwarn(warning, warn) {
        if (warning.code === "PLUGIN_TIMINGS") return;
        warn(warning);
      },
      input: {
        main: resolve(__dirname, "src/index.html"),
        "404": resolve(__dirname, "src/404.html"),
        ed: resolve(__dirname, "src/ed.html"),
      },
      output: {
        manualChunks(id) {
          if (id.includes("node_modules/preact")) return "preact";
          if (id.includes("node_modules/zustand")) return "zustand";
          if (id.includes("node_modules")) return "vendor";
        },
      },
    },
  },
  css: {
    modules: {
      localsConvention: "camelCaseOnly",
      generateScopedName: "[name]__[local]___[hash:base64:5]",
    },
  },
  resolve: {
    alias: {
      react: "preact/compat",
      "react-dom": "preact/compat",
      "react/jsx-runtime": "preact/jsx-runtime",
    },
  },
});