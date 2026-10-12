declare const __LYRA_STATIC_BASE__: string;
declare const __LYRA_STATIC_BACKEND__: string;

export const staticBase = typeof __LYRA_STATIC_BASE__ === "string" ? __LYRA_STATIC_BASE__ : "";
export const isStatic = Boolean(staticBase);
export const staticBackend = (globalThis as { __LYRA_BACKEND__?: string }).__LYRA_BACKEND__ ||
  (typeof __LYRA_STATIC_BACKEND__ === "string" ? __LYRA_STATIC_BACKEND__ : "");

export function appPath(path: string): string {
  return staticBase ? staticBase + path.replace(/^\/+/, "") : path;
}

export async function appServiceWorkers(): Promise<readonly ServiceWorkerRegistration[]> {
  const registrations = await navigator.serviceWorker.getRegistrations();
  return isStatic ? registrations.filter((registration) => registration.scope === new URL(staticBase, location.origin).href) : registrations;
}

export function logicalDatabaseName(name: string): string {
  const namespace = (globalThis as { __LYRA_STORAGE_NAMESPACE__?: string }).__LYRA_STORAGE_NAMESPACE__;
  return namespace && name.startsWith(namespace) ? name.slice(namespace.length) : name;
}
