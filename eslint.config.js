const runtimeGlobals = {
  AbortController: "readonly",
  AbortSignal: "readonly",
  Blob: "readonly",
  btoa: "readonly",
  Buffer: "readonly",
  Bun: "readonly",
  clearInterval: "readonly",
  clearTimeout: "readonly",
  console: "readonly",
  document: "readonly",
  DOMException: "readonly",
  fetch: "readonly",
  Headers: "readonly",
  localStorage: "readonly",
  MediaSource: "readonly",
  performance: "readonly",
  process: "readonly",
  queueMicrotask: "readonly",
  ReadableStream: "readonly",
  requestAnimationFrame: "readonly",
  Request: "readonly",
  Response: "readonly",
  sessionStorage: "readonly",
  setInterval: "readonly",
  setTimeout: "readonly",
  TextDecoder: "readonly",
  TextEncoder: "readonly",
  URL: "readonly",
  window: "readonly",
};

export default [
  {
    ignores: [
      "dist/**",
      "node_modules/**",
      "public/b/**",
      "services/**/target/**",
      "src/b/**",
      "vendor/**",
      "cache/**",
    ],
  },
  {
    files: ["**/*.{js,mjs,cjs}"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: runtimeGlobals,
    },
    rules: {
      "no-unused-vars": ["warn", { argsIgnorePattern: "^_" }],
      "no-undef": "error",
    },
  },
  {
    files: ["**/*.cjs"],
    languageOptions: {
      sourceType: "commonjs",
      globals: { __dirname: "readonly", __filename: "readonly" },
    },
  },
];
