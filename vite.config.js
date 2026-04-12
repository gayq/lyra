import { defineConfig } from "vite";
import preact from "@preact/preset-vite";
import meow from "./build.js";

export default defineConfig({
  plugins: [
    preact(),
    meow(),
  ],
  root: "src",
  publicDir: false,
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
      input: {
        main: "index.html",
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