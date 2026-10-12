function installStaticBackend(config, controlKey, realm = globalThis) {
  if (realm.__LYRA_BACKENDS__ && config.some((entry) => entry.origin === realm.__LYRA_BACKEND__)) return;
  let state = {};
  const storage = realm.window === realm ? realm.localStorage : null;
  const read = () => {
    try { return JSON.parse(storage?.getItem(controlKey) || "{}"); } catch { return {}; }
  };
  if (storage) state = read();
  const workerUrl = new URL(realm.__LYRA_WORKER_BASE__ || realm.location.href);
  const parameter = workerUrl.searchParams.get("__lyra_backend") || new URLSearchParams(workerUrl.hash.slice(1)).get("__lyra_backend");
  const index = storage ? config.findIndex((entry) => entry.origin === state?.backend) :
    (parameter !== null && /^\d+$/.test(parameter) ? Number(parameter) : 0);
  const selected = config.find((entry) => entry.origin === realm.__LYRA_BACKEND__) || config[index] || config[0];
  realm.__LYRA_BACKEND__ = selected.origin;
  realm.__LYRA_BACKEND_INDEX__ = config.indexOf(selected);
  realm.__LYRA_BACKENDS__ = config.map((entry) => entry.origin);
  if (!storage) return;
  const save = (next) => { storage.setItem(controlKey, JSON.stringify(next)); };
  realm.__LYRA_BACKEND_CONTROL__ = {
    failed(origin) {
      const at = Number(read()?.failed?.[origin]);
      return Number.isFinite(at) && at <= Date.now() && Date.now() - at < 30_000;
    },
    markFailed() {
      const failed = {};
      for (const entry of config) if (this.failed(entry.origin)) failed[entry.origin] = read().failed[entry.origin];
      failed[selected.origin] = Date.now();
      save({ backend: selected.origin, failed });
    },
    select(origin) {
      if (origin === selected.origin || !config.some((entry) => entry.origin === origin)) return false;
      save({ backend: origin, failed: read()?.failed || {} });
      realm.location.reload();
      return true;
    },
  };
  realm.addEventListener("storage", (event) => {
    if (event.key !== controlKey) return;
    const backend = read()?.backend;
    if (backend !== selected.origin && config.some((entry) => entry.origin === backend)) realm.location.reload();
  }, true);
}
