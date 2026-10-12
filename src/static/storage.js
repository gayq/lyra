function installStaticStorage(namespace, globalThis = self) {
  if (globalThis.__LYRA_STORAGE_NAMESPACE__ === namespace) return;
  globalThis.__LYRA_STORAGE_NAMESPACE__ = namespace;
  const storageAreas = new Map();
  for (const name of ["localStorage", "sessionStorage"]) {
    if (!(name in globalThis)) continue;
    const storage = globalThis[name];
    const keys = () => Array.from({ length: storage.length }, (_, index) => storage.key(index))
      .filter((key) => key?.startsWith(namespace));
    const methods = {
      getItem: (key) => storage.getItem(namespace + String(key)),
      setItem: (key, value) => storage.setItem(namespace + String(key), String(value)),
      removeItem: (key) => storage.removeItem(namespace + String(key)),
      clear: () => { for (const key of keys()) storage.removeItem(key); },
      key: (index) => keys()[Number(index)]?.slice(namespace.length) ?? null,
    };
    const wrapped = new Proxy(storage, {
      get(_target, key) {
        if (key === "length") return keys().length;
        if (key in methods) return methods[key];
        if (typeof key === "symbol") return Reflect.get(storage, key);
        return methods.getItem(key);
      },
      set(_target, key, value) { methods.setItem(key, value); return true; },
      deleteProperty(_target, key) { methods.removeItem(key); return true; },
      ownKeys: () => keys().map((key) => key.slice(namespace.length)),
      has: (_target, key) => key in methods || methods.getItem(key) !== null,
      getOwnPropertyDescriptor(_target, key) {
        const value = methods.getItem(key);
        return value === null ? undefined : { configurable: true, enumerable: true, writable: true, value };
      },
    });
    storageAreas.set(storage, wrapped);
    Object.defineProperty(globalThis, name, { configurable: true, value: wrapped });
  }
  if ("indexedDB" in globalThis) {
    const database = globalThis.indexedDB;
    Object.defineProperty(globalThis, "indexedDB", { configurable: true, value: new Proxy(database, {
      get(target, property) {
        if (property === "open") return (name, version) => version === undefined
          ? target.open(namespace + name) : target.open(namespace + name, version);
        if (property === "deleteDatabase") return (name) => target.deleteDatabase(namespace + name);
        if (property === "databases") return async () => (await target.databases())
          .filter((entry) => entry.name?.startsWith(namespace))
          .map((entry) => ({ ...entry, name: entry.name.slice(namespace.length) }));
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) });
  }
  if ("caches" in globalThis) {
    const cacheStorage = globalThis.caches;
    Object.defineProperty(globalThis, "caches", { configurable: true, value: {
      open: (name) => cacheStorage.open(namespace + name),
      delete: (name) => cacheStorage.delete(namespace + name),
      has: (name) => cacheStorage.has(namespace + name),
      keys: async () => (await cacheStorage.keys()).filter((name) => name.startsWith(namespace)).map((name) => name.slice(namespace.length)),
      async match(request, options = {}) {
        if (options.cacheName) return cacheStorage.match(request, { ...options, cacheName: namespace + options.cacheName });
        for (const name of await cacheStorage.keys()) {
          if (!name.startsWith(namespace)) continue;
          const match = await cacheStorage.match(request, { ...options, cacheName: name });
          if (match) return match;
        }
      },
    } });
  }
  if (globalThis.window === globalThis) {
    const { document, Document, EventTarget, Event, StorageEvent } = globalThis;
    const cookiePrefix = namespace.replace(/:/g, "_");
    const cookie = Object.getOwnPropertyDescriptor(Document.prototype, "cookie");
    if (cookie?.get && cookie?.set) Object.defineProperty(document, "cookie", {
      configurable: true,
      get: () => cookie.get.call(document).split(";").map((part) => part.trim())
        .filter((part) => part.startsWith(cookiePrefix)).map((part) => part.slice(cookiePrefix.length)).join("; "),
      set(value) {
        const [pair, ...attributes] = String(value).split(";");
        const scoped = attributes.filter((part) => !/^\s*(?:path|domain)\s*=/i.test(part));
        cookie.set.call(document, `${cookiePrefix}${pair};${scoped.join(";")};path=${globalThis.__LYRA_APP_BASE__};SameSite=Lax`);
      },
    });
    if (globalThis.cookieStore) {
      const store = globalThis.cookieStore;
      const events = new EventTarget();
      const visible = (entries) => entries.filter((entry) => entry.name.startsWith(cookiePrefix))
        .map((entry) => ({ ...entry, name: entry.name.slice(cookiePrefix.length), path: "/" }));
      const options = (input) => ({ ...(typeof input === "string" ? { name: input } : input),
        name: cookiePrefix + (typeof input === "string" ? input : input.name),
        path: globalThis.__LYRA_APP_BASE__, domain: null });
      store.addEventListener("change", (event) => {
        const changed = visible(event.changed), deleted = visible(event.deleted);
        if (!changed.length && !deleted.length) return;
        const scoped = new Event("change");
        Object.assign(scoped, { changed, deleted });
        events.dispatchEvent(scoped);
      });
      Object.defineProperty(globalThis, "cookieStore", { configurable: true, value: Object.assign(events, {
        get: async (input) => visible([await store.get(options(input))].filter(Boolean))[0] || null,
        getAll: async (input) => visible(await store.getAll(input === undefined ? undefined : options(input))),
        set: (input, value) => store.set(options(typeof input === "string" ? { name: input, value } : input)),
        delete: (input) => store.delete(options(input)),
      }) });
    }
    const forwarded = new WeakSet();
    globalThis.addEventListener("storage", (event) => {
      if (forwarded.has(event)) return;
      event.stopImmediatePropagation();
      if (!event.key?.startsWith(namespace)) return;
      const local = new StorageEvent("storage", { key: event.key.slice(namespace.length), oldValue: event.oldValue,
        newValue: event.newValue, url: event.url });
      Object.defineProperty(local, "storageArea", { value: storageAreas.get(event.storageArea) || null });
      forwarded.add(local);
      globalThis.dispatchEvent(local);
    }, true);
  }
}
