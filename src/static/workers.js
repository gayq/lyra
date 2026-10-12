
function installStaticWorkers(realm = globalThis) {
  for (const kind of ["Worker", "SharedWorker"]) {
    const Native = realm[kind];
    if (!Native || Native[Symbol.for("lyra.staticWorker")]) continue;
    realm[kind] = class extends Native {
      static [Symbol.for("lyra.staticWorker")] = true;
      constructor(source, options) {
        const target = new URL(String(source), realm.__LYRA_WORKER_BASE__ || realm.location.href);
        const origin = realm.__LYRA_WORKER_ORIGIN__ || realm.location.origin;
        const local = target.origin === origin && ["assets/", "b/"].some((path) => target.pathname.startsWith("__STATIC_BASE__" + path));
        if (!local) { super(source, options); return; }
        target.searchParams.set("__lyra_backend", String(realm.__LYRA_BACKEND_INDEX__));
        if (kind === "SharedWorker") { super(target.href, options); return; }
        const module = options && typeof options === "object" && options.type === "module";
        const script = `globalThis.__LYRA_WORKER_ORIGIN__=${JSON.stringify(origin)};globalThis.__LYRA_WORKER_BASE__=${JSON.stringify(target.href)};globalThis.__LYRA_BACKEND__=${JSON.stringify(realm.__LYRA_BACKEND__)};` +
          (module ? `import ${JSON.stringify(target.href)};` : `importScripts(${JSON.stringify(target.href)});`);
        const bootstrap = URL.createObjectURL(new Blob([script], { type: "application/javascript" }));
        try { super(bootstrap + "#__lyra_backend=" + realm.__LYRA_BACKEND_INDEX__, options); }
        finally { setTimeout(() => URL.revokeObjectURL(bootstrap), 30_000); }
      }
    };
  }
}
