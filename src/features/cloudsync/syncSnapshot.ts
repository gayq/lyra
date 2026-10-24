import {
  FOLIO_DB,
  IDB_REGISTRY_KEY,
  LOCAL_ONLY_DATABASES,
  isLocalOnlySyncStorageKey,
  isSensitiveSyncName,
  isSensitiveSyncText,
  isSiteStorageName,
  isSiteDatabaseName,
  allowsSensitiveDatabase,
  canSyncIndexedDBStore,
  containsLocalOnlySiteData,
  canSyncStorageValue,
  containsSensitiveTextValue,
  isGameFileRecord,
} from "./syncPolicy.ts";
import {
  encodeBrowserValue,
  decodeBrowserValue,
  validEncodedValue,
  isRecord,
  syncError,
  type EncodedValue,
} from "./snapshotValue.ts";
export {
  isLocalOnlySyncStorageKey,
  isSensitiveSyncName,
  canSyncIndexedDBStore,
  containsLocalOnlySiteData,
  canSyncStorageValue,
} from "./syncPolicy.ts";
import { prepareSnapshot } from "./prepareSnapshot.ts";
export { payloadFingerprint } from "./snapshotPayload.ts";
const SYNC_SCHEMA_VERSION = 3 as const;
const LEGACY_SYNC_SCHEMA_VERSION = 2 as const;
const FOLIO_STORE = "state";
const FOLIO_COOKIE_KEY = "cookies";
const FOLIO_CHANNEL = "__folio_controller_channel";

type KeyPath = string | string[] | null;

interface SyncRecord {
  key: EncodedValue;
  value: EncodedValue;
}

interface SyncIndex {
  keyPath: KeyPath;
  unique: boolean;
  multiEntry: boolean;
}

interface SyncStore {
  keyPath: KeyPath;
  autoIncrement: boolean;
  indexes: Record<string, SyncIndex>;
  records: SyncRecord[];
}

interface SyncDatabase {
  stores: Record<string, SyncStore>;
}

type SyncSameSite = "strict" | "lax" | "none";

interface SyncCookie {
  name: string;
  value: string;
  domain: string | null;
  path: string;
  expires: number | null;
  sameSite: SyncSameSite;
  secure: boolean;
  partitioned: boolean;
}

export interface SyncSnapshot {
  schemaVersion: typeof LEGACY_SYNC_SCHEMA_VERSION | typeof SYNC_SCHEMA_VERSION;
  localStorage: Record<string, string>;
  sessionStorage: Record<string, string>;
  cookies: SyncCookie[];
  indexedDB: Record<string, SyncDatabase>;
}

interface CookieStoreEntry {
  name?: unknown;
  value?: unknown;
  domain?: unknown;
  path?: unknown;
  expires?: unknown;
  sameSite?: unknown;
  secure?: unknown;
  partitioned?: unknown;
}

interface CookieStoreLike {
  getAll(): Promise<CookieStoreEntry[]>;
  delete(options: {
    name: string;
    domain?: string;
    path?: string;
    partitioned?: boolean;
  }): Promise<void>;
}

interface StorageLike {
  readonly length: number;
  key(index: number): string | null;
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function hasOwn(value: object, key: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function exportStorage(storage: StorageLike): Record<string, string> {
  const values: Record<string, string> = {};
  const keys = new Set<string>();
  for (let index = 0; index < storage.length; index++) {
    const key = storage.key(index);
    if (key !== null) keys.add(key);
  }
  for (const key of [...keys].sort()) {
    const value = storage.getItem(key);
    if (value !== null && canSyncStorageValue(key, value)) {
      values[key] = value;
    }
  }
  return values;
}

function exportCookies(cookieHeader: string): Record<string, string> {
  const cookies: Record<string, string> = {};
  for (const part of cookieHeader.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 1) continue;
    const name = part.slice(0, separator).trim();
    if (!name || isSensitiveSyncName(name)) continue;
    const value = part.slice(separator + 1).trim();
    if (!isSensitiveSyncText(value)) cookies[name] = value;
  }
  return Object.fromEntries(
    Object.entries(cookies).sort(([left], [right]) =>
      left.localeCompare(right),
    ),
  );
}

const COOKIE_NAME_PATTERN = /^[!#$%&'*+\-.^_`|~0-9a-zA-Z]+$/;
const COOKIE_VALUE_PATTERN = /^[\x21-\x7e]*$/;
const COOKIE_DOMAIN_PATTERN = /^\.?[a-zA-Z0-9.-]+$/;

function cookieStore(): CookieStoreLike | null {
  const store = (globalThis as unknown as { cookieStore?: unknown })
    .cookieStore;
  if (
    typeof store !== "object" ||
    store === null ||
    typeof (store as CookieStoreLike).getAll !== "function" ||
    typeof (store as CookieStoreLike).delete !== "function"
  ) {
    return null;
  }
  return store as CookieStoreLike;
}

function credentialCookieName(name: string): boolean {
  return (
    isSensitiveSyncName(name) ||
    name.startsWith("__Http-") ||
    name.startsWith("__Host-Http-")
  );
}

function validCookie(cookie: SyncCookie): boolean {
  if (
    cookie.name.length > 256 ||
    !COOKIE_NAME_PATTERN.test(cookie.name) ||
    credentialCookieName(cookie.name) ||
    !COOKIE_VALUE_PATTERN.test(cookie.value) ||
    cookie.value.length > 4096 ||
    /[";,\\]/.test(cookie.value) ||
    isSensitiveSyncText(cookie.value) ||
    (cookie.domain !== null &&
      (cookie.domain.length > 253 ||
        !COOKIE_DOMAIN_PATTERN.test(cookie.domain) ||
        cookie.domain.includes(".."))) ||
    !cookie.path.startsWith("/") ||
    cookie.path.length > 1024 ||
    /[;\x00-\x1f\x7f]/.test(cookie.path) ||
    (cookie.expires !== null &&
      (!Number.isFinite(cookie.expires) ||
        cookie.expires < 0 ||
        cookie.expires > 8.64e15)) ||
    !["strict", "lax", "none"].includes(cookie.sameSite) ||
    (cookie.sameSite === "none" && !cookie.secure) ||
    (cookie.partitioned && !cookie.secure)
  ) {
    return false;
  }
  if (cookie.name.startsWith("__Secure-") && !cookie.secure) return false;
  if (
    cookie.name.startsWith("__Host-") &&
    (!cookie.secure || cookie.domain !== null || cookie.path !== "/")
  ) {
    return false;
  }
  return true;
}

function cookieIdentity(cookie: SyncCookie): string {
  return JSON.stringify([
    cookie.name,
    cookie.domain?.toLowerCase() ?? null,
    cookie.path,
    cookie.partitioned,
  ]);
}

function sortCookies(cookies: SyncCookie[]): SyncCookie[] {
  return cookies.sort((left, right) =>
    cookieIdentity(left).localeCompare(cookieIdentity(right)),
  );
}

function legacyCookies(cookieHeader: string): SyncCookie[] {
  const secure =
    (globalThis as unknown as { location?: { protocol?: string } }).location
      ?.protocol === "https:";
  return sortCookies(
    Object.entries(exportCookies(cookieHeader)).map(([name, value]) => ({
      name,
      value,
      domain: null,
      path: "/",
      expires: null,
      sameSite: "lax" as const,
      secure,
      partitioned: false,
    })),
  );
}

async function exportBrowserCookies(): Promise<SyncCookie[]> {
  const store = cookieStore();
  if (!store) return legacyCookies(globalThis.document.cookie);
  try {
    const secureContext =
      (globalThis as unknown as { location?: { protocol?: string } }).location
        ?.protocol === "https:";
    const cookies: SyncCookie[] = [];
    for (const entry of await store.getAll()) {
      if (typeof entry.name !== "string" || typeof entry.value !== "string")
        continue;
      const sameSite = ["strict", "lax", "none"].includes(
        String(entry.sameSite),
      )
        ? (entry.sameSite as SyncSameSite)
        : "lax";
      const cookie: SyncCookie = {
        name: entry.name,
        value: entry.value,
        domain:
          typeof entry.domain === "string" && entry.domain
            ? entry.domain
            : null,
        path: typeof entry.path === "string" && entry.path ? entry.path : "/",
        expires:
          typeof entry.expires === "number" && Number.isFinite(entry.expires)
            ? entry.expires
            : null,
        sameSite,
        secure:
          typeof entry.secure === "boolean" ? entry.secure : secureContext,
        partitioned: entry.partitioned === true,
      };
      if (validCookie(cookie)) cookies.push(cookie);
    }
    return sortCookies(cookies);
  } catch {
    return legacyCookies(globalThis.document.cookie);
  }
}

type FolioCookie = {
  name?: unknown;
  value?: unknown;
  httpOnly?: unknown;
  [key: string]: unknown;
};

function parseFolioCookies(value: unknown): Record<string, FolioCookie> {
  if (typeof value !== "string") return {};
  try {
    const parsed = JSON.parse(value);
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      return {};
    }
    const cookies: Record<string, FolioCookie> = {};
    for (const [id, entry] of Object.entries(parsed)) {
      if (
        id.length > 2048 ||
        typeof entry !== "object" ||
        entry === null ||
        Array.isArray(entry)
      ) {
        continue;
      }
      const cookie = entry as FolioCookie;
      if (
        typeof cookie.name !== "string" ||
        cookie.name.length > 256 ||
        typeof cookie.value !== "string" ||
        cookie.value.length > 4096 ||
        Object.keys(cookie).length > 32 ||
        ["domain", "path", "sameSite"].some(
          (field) => field in cookie && typeof cookie[field] !== "string",
        ) ||
        ["hostOnly", "secure", "httpOnly", "partitioned"].some(
          (field) => field in cookie && typeof cookie[field] !== "boolean",
        ) ||
        ["expires", "maxAge"].some(
          (field) => field in cookie && typeof cookie[field] !== "number",
        ) ||
        (typeof cookie.domain === "string" && cookie.domain.length > 253) ||
        (typeof cookie.path === "string" &&
          (!cookie.path.startsWith("/") || cookie.path.length > 1024)) ||
        (typeof cookie.sameSite === "string" && cookie.sameSite.length > 64) ||
        Object.entries(cookie).some(
          ([key, field]) =>
            key.length > 256 ||
            !(
              field === null ||
              ["string", "number", "boolean"].includes(typeof field)
            ),
        )
      ) {
        continue;
      }
      cookies[id] = cookie;
    }
    return cookies;
  } catch {
    return {};
  }
}

function splitFolioCookies(value: unknown): {
  safe: Record<string, FolioCookie>;
  local: Record<string, FolioCookie>;
} {
  const safe: Record<string, FolioCookie> = {};
  const local: Record<string, FolioCookie> = {};
  for (const [id, cookie] of Object.entries(parseFolioCookies(value))) {
    const name = typeof cookie?.name === "string" ? cookie.name : id;
    if (
      cookie?.httpOnly === true ||
      isSensitiveSyncName(name) ||
      (typeof cookie?.value === "string" && isSensitiveSyncText(cookie.value))
    ) {
      local[id] = cookie;
    } else {
      safe[id] = cookie;
    }
  }
  return { safe, local };
}

function sanitizeFolioCookieState(
  value: unknown,
  includeSensitive: boolean,
): unknown {
  if (typeof value !== "object" || value === null) return value;
  const cookies = (value as Record<string, unknown>).cookies;
  return {
    updatedAt: 0,
    cookies: JSON.stringify(
      includeSensitive
        ? parseFolioCookies(cookies)
        : splitFolioCookies(cookies).safe,
    ),
  };
}

function mergeFolioCookieState(
  remote: unknown,
  local: unknown,
  includeSensitive: boolean,
): unknown {
  const remoteCookies =
    typeof remote === "object" && remote !== null
      ? (remote as Record<string, unknown>).cookies
      : undefined;
  const localCookies =
    typeof local === "object" && local !== null
      ? (local as Record<string, unknown>).cookies
      : undefined;
  const merged = includeSensitive
    ? parseFolioCookies(remoteCookies)
    : {
        ...splitFolioCookies(remoteCookies).safe,
        ...splitFolioCookies(localCookies).local,
      };
  const localUpdatedAt =
    typeof local === "object" &&
    local !== null &&
    typeof (local as Record<string, unknown>).updatedAt === "number"
      ? ((local as Record<string, number>).updatedAt ?? 0)
      : 0;
  return {
    updatedAt: Math.max(Date.now(), localUpdatedAt + 1),
    cookies: JSON.stringify(merged),
  };
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () =>
      reject(syncError("indexeddb transaction aborted"));
    transaction.onerror = () =>
      reject(syncError("indexeddb transaction failed"));
  });
}

function registeredDatabaseNames(): Set<string> {
  const names = new Set([FOLIO_DB, "rivet_extensions"]);
  try {
    const stored = globalThis.localStorage?.getItem(IDB_REGISTRY_KEY);
    const parsed = stored ? JSON.parse(stored) : [];
    if (Array.isArray(parsed)) {
      for (const name of parsed) {
        if (
          typeof name === "string" &&
          name &&
          (allowsSensitiveDatabase(name) || !isSensitiveSyncName(name))
        ) {
          names.add(name);
        }
      }
    }
  } catch {}
  return names;
}

function saveDatabaseNames(names: Iterable<string>): void {
  try {
    const safe = [...new Set(names)]
      .filter(
        (name) =>
          name && (allowsSensitiveDatabase(name) || !isSensitiveSyncName(name)),
      )
      .sort();
    globalThis.localStorage?.setItem(IDB_REGISTRY_KEY, JSON.stringify(safe));
  } catch {}
}

export function rememberIndexedDBName(name: string): void {
  if (
    !name ||
    LOCAL_ONLY_DATABASES.has(name) ||
    (!allowsSensitiveDatabase(name) && isSensitiveSyncName(name))
  ) {
    return;
  }
  const names = registeredDatabaseNames();
  names.add(name);
  saveDatabaseNames(names);
}

export function forgetIndexedDBName(name: string): void {
  const names = registeredDatabaseNames();
  names.delete(name);
  saveDatabaseNames(names);
}

async function databaseNames(factory: IDBFactory): Promise<string[]> {
  if (typeof factory.databases === "function") {
    const names = (await factory.databases())
      .map((database) => database.name)
      .filter(
        (name): name is string =>
          typeof name === "string" &&
          name.length > 0 &&
          !LOCAL_ONLY_DATABASES.has(name) &&
          (allowsSensitiveDatabase(name) || !isSensitiveSyncName(name)),
      )
      .sort();
    saveDatabaseNames(names);
    return names;
  }

  const names: string[] = [];
  for (const name of [...registeredDatabaseNames()].sort()) {
    if (LOCAL_ONLY_DATABASES.has(name)) continue;
    try {
      const database = await openExistingDatabase(factory, name);
      database.close();
      names.push(name);
    } catch {}
  }
  return names;
}

function openExistingDatabase(
  factory: IDBFactory,
  name: string,
): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = factory.open(name);
    request.onupgradeneeded = () => request.transaction?.abort();
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(syncError("indexeddb database open failed"));
    request.onblocked = () =>
      reject(syncError("indexeddb database open blocked"));
  });
}

function keyPath(value: string | string[] | null): KeyPath {
  return Array.isArray(value) ? [...value] : value;
}

async function readRawRecords(
  store: IDBObjectStore,
): Promise<Array<{ key: IDBValidKey; value: unknown }>> {
  return new Promise((resolve, reject) => {
    const records: Array<{ key: IDBValidKey; value: unknown }> = [];
    const request = store.openCursor();
    request.onerror = () => reject(syncError("indexeddb cursor failed"));
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor) {
        resolve(records);
        return;
      }
      records.push({ key: cursor.primaryKey, value: cursor.value });
      cursor.continue();
    };
  });
}

async function exportStore(
  database: IDBDatabase,
  storeName: string,
  allowSensitive: boolean,
): Promise<SyncStore> {
  const transaction = database.transaction(storeName, "readonly");
  const done = transactionDone(transaction);
  const store = transaction.objectStore(storeName);
  const indexes: Record<string, SyncIndex> = {};
  for (const indexName of Array.from(store.indexNames).sort()) {
    if (!allowSensitive && isSensitiveSyncName(indexName)) continue;
    const index = store.index(indexName);
    indexes[indexName] = {
      keyPath: keyPath(index.keyPath),
      unique: index.unique,
      multiEntry: index.multiEntry,
    };
  }
  if (!canSyncIndexedDBStore(database.name, storeName)) {
    await done;
    return {
      keyPath: keyPath(store.keyPath),
      autoIncrement: store.autoIncrement,
      indexes,
      records: [],
    };
  }
  const rawRecords = await readRawRecords(store);
  await done;
  const records: SyncRecord[] = [];
  for (const record of rawRecords) {
    if (!allowSensitive && isSensitiveSyncName(String(record.key))) continue;
    const value =
      database.name === FOLIO_DB &&
      storeName === FOLIO_STORE &&
      record.key === FOLIO_COOKIE_KEY
        ? sanitizeFolioCookieState(record.value, allowSensitive)
        : record.value;
    if (!allowSensitive && (await containsSensitiveTextValue(value))) continue;
    const encoded = await encodeRecord(
      database.name,
      record.key,
      value,
      allowSensitive,
    );
    if (encoded) records.push(encoded);
  }
  return {
    keyPath: keyPath(store.keyPath),
    autoIncrement: store.autoIncrement,
    indexes,
    records,
  };
}

async function encodeRecord(
  databaseName: string,
  key: IDBValidKey,
  value: unknown,
  allowSensitive: boolean,
): Promise<SyncRecord | null> {
  if (
    isSiteDatabaseName(databaseName) &&
    !isGameFileRecord(value) &&
    (containsLocalOnlySiteData(key) || containsLocalOnlySiteData(value))
  ) {
    return null;
  }
  try {
    const record = {
      key: await encodeBrowserValue(key, allowSensitive),
      value: await encodeBrowserValue(value, allowSensitive),
    };
    if (
      !validEncodedValue(record.key, new Set<number>(), allowSensitive) ||
      !validEncodedValue(record.value, new Set<number>(), allowSensitive)
    ) {
      return null;
    }
    return record;
  } catch {
    return null;
  }
}

async function exportDatabase(
  factory: IDBFactory,
  name: string,
): Promise<SyncDatabase> {
  const database = await openExistingDatabase(factory, name);
  try {
    const allowSensitive = allowsSensitiveDatabase(name);
    const stores: Record<string, SyncStore> = {};
    for (const storeName of Array.from(database.objectStoreNames).sort()) {
      if (!allowSensitive && isSensitiveSyncName(storeName)) continue;
      stores[storeName] = await exportStore(
        database,
        storeName,
        allowSensitive,
      );
    }
    return { stores };
  } finally {
    database.close();
  }
}

async function mapConcurrent<T, R>(
  values: T[],
  limit: number,
  task: (value: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  let next = 0;
  const workers = Array.from(
    { length: Math.min(limit, values.length) },
    async () => {
      while (next < values.length) {
        const index = next++;
        results[index] = await task(values[index]!);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

export async function exportSyncSnapshot(): Promise<SyncSnapshot> {
  const factory = globalThis.indexedDB;
  if (!factory) throw syncError("indexeddb is unavailable");
  const [names, cookies] = await Promise.all([
    databaseNames(factory),
    exportBrowserCookies(),
  ]);
  const databases = await mapConcurrent(
    names,
    4,
    async (name) => [name, await exportDatabase(factory, name)] as const,
  );
  const indexedDB = Object.fromEntries(databases);
  return {
    schemaVersion: SYNC_SCHEMA_VERSION,
    localStorage: exportStorage(globalThis.localStorage),
    sessionStorage: exportStorage(globalThis.sessionStorage),
    cookies,
    indexedDB,
  };
}

function validKeyPath(value: unknown): value is KeyPath {
  return (
    value === null ||
    typeof value === "string" ||
    (Array.isArray(value) && value.every((entry) => typeof entry === "string"))
  );
}

function isSyncSnapshot(value: unknown): value is SyncSnapshot {
  if (
    !isRecord(value) ||
    ![LEGACY_SYNC_SCHEMA_VERSION, SYNC_SCHEMA_VERSION].includes(
      value.schemaVersion as 2 | 3,
    ) ||
    Object.keys(value).length !== 5
  ) {
    return false;
  }
  const includeSensitive = value.schemaVersion === SYNC_SCHEMA_VERSION;
  for (const field of ["localStorage", "sessionStorage"] as const) {
    const entries = value[field];
    if (
      !isRecord(entries) ||
      Object.entries(entries).some(
        ([key, entry]) =>
          typeof entry !== "string" ||
          ((!includeSensitive || !isSiteStorageName(key)) &&
            (isSensitiveSyncName(key) || isSensitiveSyncText(entry))),
      )
    ) {
      return false;
    }
  }
  if (
    !Array.isArray(value.cookies) ||
    value.cookies.some((entry) => {
      if (!isRecord(entry)) return true;
      const cookie = entry as unknown as SyncCookie;
      return (
        Object.keys(entry).length !== 8 ||
        typeof cookie.name !== "string" ||
        typeof cookie.value !== "string" ||
        (cookie.domain !== null && typeof cookie.domain !== "string") ||
        typeof cookie.path !== "string" ||
        (cookie.expires !== null && typeof cookie.expires !== "number") ||
        typeof cookie.sameSite !== "string" ||
        typeof cookie.secure !== "boolean" ||
        typeof cookie.partitioned !== "boolean" ||
        !validCookie(cookie)
      );
    })
  ) {
    return false;
  }
  const cookieIds = new Set<string>();
  for (const cookie of value.cookies as unknown as SyncCookie[]) {
    const identity = cookieIdentity(cookie);
    if (cookieIds.has(identity)) return false;
    cookieIds.add(identity);
  }
  if (!isRecord(value.indexedDB)) return false;
  return Object.entries(value.indexedDB).every(([databaseName, database]) => {
    const allowSensitive =
      includeSensitive && allowsSensitiveDatabase(databaseName);
    if (
      (!allowSensitive && isSensitiveSyncName(databaseName)) ||
      !isRecord(database)
    ) {
      return false;
    }
    if (!isRecord(database.stores)) return false;
    return Object.entries(database.stores).every(([storeName, store]) => {
      if (
        (!allowSensitive && isSensitiveSyncName(storeName)) ||
        !isRecord(store)
      ) {
        return false;
      }
      if (
        !validKeyPath(store.keyPath) ||
        typeof store.autoIncrement !== "boolean" ||
        !isRecord(store.indexes) ||
        !Array.isArray(store.records)
      ) {
        return false;
      }
      const indexesValid = Object.values(store.indexes).every(
        (index) =>
          isRecord(index) &&
          validKeyPath(index.keyPath) &&
          typeof index.unique === "boolean" &&
          typeof index.multiEntry === "boolean",
      );
      return (
        indexesValid &&
        store.records.every(
          (record) =>
            isRecord(record) &&
            validEncodedValue(record.key, new Set<number>(), allowSensitive) &&
            validEncodedValue(record.value, new Set<number>(), allowSensitive),
        )
      );
    });
  });
}

function replaceStorage(
  storage: StorageLike,
  remote: Record<string, string>,
  includeSensitive: boolean,
): number {
  let changes = 0;
  const currentKeys: string[] = [];
  for (let index = 0; index < storage.length; index++) {
    const key = storage.key(index);
    if (key !== null) currentKeys.push(key);
  }
  for (const key of currentKeys) {
    if (isLocalOnlySyncStorageKey(key)) continue;
    const current = storage.getItem(key);
    const replaceSensitive = includeSensitive && isSiteStorageName(key);
    if (
      (replaceSensitive ||
        (!isSensitiveSyncName(key) &&
          !(current !== null && isSensitiveSyncText(current)))) &&
      !hasOwn(remote, key)
    ) {
      storage.removeItem(key);
      changes++;
    }
  }
  for (const [key, value] of Object.entries(remote)) {
    if (isLocalOnlySyncStorageKey(key) || storage.getItem(key) === value) {
      continue;
    }
    storage.setItem(key, value);
    changes++;
  }
  return changes;
}

function expireCookie(name: string): void {
  const expires = "thu, 01 jan 1970 00:00:00 gmt";
  globalThis.document.cookie = `${name}=; expires=${expires}; max-age=0; path=/; samesite=lax`;
}

function domainMatchesCurrentHost(domain: string | null): boolean {
  if (domain === null) return true;
  const hostname = (
    globalThis as unknown as { location?: { hostname?: string } }
  ).location?.hostname?.toLowerCase();
  if (!hostname) return false;
  const normalized = domain.replace(/^\./, "").toLowerCase();
  return hostname === normalized || hostname.endsWith(`.${normalized}`);
}

function writeCookie(cookie: SyncCookie): void {
  const attributes = [
    `${cookie.name}=${cookie.value}`,
    `path=${cookie.path}`,
    `samesite=${cookie.sameSite}`,
  ];
  if (cookie.domain !== null) attributes.push(`domain=${cookie.domain}`);
  if (cookie.expires !== null) {
    attributes.push(`expires=${new Date(cookie.expires).toUTCString()}`);
  }
  if (cookie.secure) attributes.push("secure");
  if (cookie.partitioned) attributes.push("partitioned");
  globalThis.document.cookie = attributes.join("; ");
}

async function deleteCookie(
  store: CookieStoreLike | null,
  cookie: SyncCookie,
): Promise<void> {
  if (!store) {
    expireCookie(cookie.name);
    return;
  }
  const options: {
    name: string;
    domain?: string;
    path?: string;
    partitioned?: boolean;
  } = {
    name: cookie.name,
    path: cookie.path,
    partitioned: cookie.partitioned,
  };
  if (cookie.domain !== null) options.domain = cookie.domain;
  await store.delete(options);
}

async function replaceCookies(remote: SyncCookie[]): Promise<number> {
  const current = await exportBrowserCookies();
  const remoteIds = new Set(remote.map(cookieIdentity));
  const currentCookies = new Map(
    current.map((cookie) => [cookieIdentity(cookie), JSON.stringify(cookie)]),
  );
  const store = cookieStore();
  let changes = 0;
  for (const cookie of current) {
    if (remoteIds.has(cookieIdentity(cookie))) continue;
    changes++;
    await deleteCookie(store, cookie);
  }
  for (const cookie of remote) {
    if (
      !domainMatchesCurrentHost(cookie.domain) ||
      currentCookies.get(cookieIdentity(cookie)) === JSON.stringify(cookie)
    ) {
      continue;
    }
    writeCookie(cookie);
    changes++;
  }
  return changes;
}

function createStore(
  database: IDBDatabase,
  name: string,
  snapshot: SyncStore,
): IDBObjectStore {
  const options: IDBObjectStoreParameters = {
    autoIncrement: snapshot.autoIncrement,
  };
  if (snapshot.keyPath !== null) options.keyPath = snapshot.keyPath;
  const store = database.createObjectStore(name, options);
  for (const [indexName, index] of Object.entries(snapshot.indexes)) {
    store.createIndex(indexName, index.keyPath!, {
      unique: index.unique,
      multiEntry: index.multiEntry,
    });
  }
  return store;
}

function sameKeyPath(left: KeyPath, right: KeyPath): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function sameStoreSchema(
  store: IDBObjectStore,
  snapshot: SyncStore,
  allowSensitive: boolean,
): boolean {
  if (
    !sameKeyPath(keyPath(store.keyPath), snapshot.keyPath) ||
    store.autoIncrement !== snapshot.autoIncrement
  ) {
    return false;
  }
  const names = Array.from(store.indexNames).filter(
    (name) => allowSensitive || !isSensitiveSyncName(name),
  );
  if (names.length !== Object.keys(snapshot.indexes).length) return false;
  return names.every((name) => {
    const expected = snapshot.indexes[name];
    if (!expected) return false;
    const index = store.index(name);
    return (
      sameKeyPath(keyPath(index.keyPath), expected.keyPath) &&
      index.unique === expected.unique &&
      index.multiEntry === expected.multiEntry
    );
  });
}

function openNewDatabase(
  factory: IDBFactory,
  name: string,
  snapshot: SyncDatabase,
): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = factory.open(name, 1);
    request.onupgradeneeded = () => {
      for (const [storeName, store] of Object.entries(snapshot.stores)) {
        createStore(request.result, storeName, store);
      }
    };
    request.onsuccess = () => {
      rememberIndexedDBName(name);
      resolve(request.result);
    };
    request.onerror = () =>
      reject(syncError("indexeddb database creation failed"));
    request.onblocked = () =>
      reject(syncError("indexeddb database creation blocked"));
  });
}

async function reconcileDatabase(
  factory: IDBFactory,
  name: string,
  snapshot: SyncDatabase,
  exists: boolean,
  includeSensitive: boolean,
): Promise<{ database: IDBDatabase; changed: boolean }> {
  if (!exists) {
    return {
      database: await openNewDatabase(factory, name, snapshot),
      changed: true,
    };
  }
  const allowSensitive = includeSensitive && allowsSensitiveDatabase(name);
  let database = await openExistingDatabase(factory, name);
  const syncStores = Array.from(database.objectStoreNames).filter(
    (storeName) => allowSensitive || !isSensitiveSyncName(storeName),
  );
  let schemaMatches =
    syncStores.length === Object.keys(snapshot.stores).length &&
    syncStores.every((storeName) => hasOwn(snapshot.stores, storeName));
  if (schemaMatches && syncStores.length > 0) {
    const transaction = database.transaction(syncStores, "readonly");
    schemaMatches = syncStores.every((storeName) =>
      sameStoreSchema(
        transaction.objectStore(storeName),
        snapshot.stores[storeName]!,
        allowSensitive,
      ),
    );
  }
  if (schemaMatches) return { database, changed: false };

  const nextVersion = database.version + 1;
  database.close();
  database = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = factory.open(name, nextVersion);
    request.onupgradeneeded = () => {
      const upgraded = request.result;
      for (const storeName of Array.from(upgraded.objectStoreNames)) {
        if (
          (allowSensitive || !isSensitiveSyncName(storeName)) &&
          !hasOwn(snapshot.stores, storeName)
        ) {
          upgraded.deleteObjectStore(storeName);
        }
      }
      for (const [storeName, storeSnapshot] of Object.entries(
        snapshot.stores,
      )) {
        if (upgraded.objectStoreNames.contains(storeName)) {
          const store = request.transaction!.objectStore(storeName);
          if (!sameStoreSchema(store, storeSnapshot, allowSensitive)) {
            upgraded.deleteObjectStore(storeName);
            createStore(upgraded, storeName, storeSnapshot);
          }
        } else {
          createStore(upgraded, storeName, storeSnapshot);
        }
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () =>
      reject(syncError("indexeddb schema restore failed"));
    request.onblocked = () =>
      reject(syncError("indexeddb schema restore blocked"));
  });
  return { database, changed: true };
}

function mergeLocalSecrets(remote: unknown, local: unknown): unknown {
  if (typeof local === "string" && isSensitiveSyncText(local)) return local;
  if (!isRecord(remote) || !isRecord(local)) return remote;
  for (const [key, localValue] of Object.entries(local)) {
    if (isSensitiveSyncName(key)) {
      remote[key] = localValue;
    } else if (hasOwn(remote, key)) {
      remote[key] = mergeLocalSecrets(remote[key], localValue);
    }
  }
  return remote;
}

async function sameStoredValue(left: unknown, right: unknown): Promise<boolean> {
  if (left === right) return true;
  try {
    return (
      JSON.stringify(await encodeBrowserValue(left, true)) ===
      JSON.stringify(await encodeBrowserValue(right, true))
    );
  } catch {
    return false;
  }
}

async function replaceRecords(
  database: IDBDatabase,
  databaseName: string,
  storeName: string,
  snapshot: SyncStore,
  includeSensitive: boolean,
): Promise<{ changes: number; folioUpdatedAt: number | null }> {
  if (!canSyncIndexedDBStore(databaseName, storeName)) {
    return { changes: 0, folioUpdatedAt: null };
  }
  const replaceSensitive =
    includeSensitive && allowsSensitiveDatabase(databaseName);
  const readTransaction = database.transaction(storeName, "readonly");
  const readDone = transactionDone(readTransaction);
  const localRecords = await readRawRecords(
    readTransaction.objectStore(storeName),
  );
  await readDone;

  const remoteRecords = await Promise.all(
    snapshot.records.map(async (record) => ({
      key: decodeBrowserValue(record.key) as IDBValidKey,
      keyId: JSON.stringify(record.key),
      value: decodeBrowserValue(record.value),
    })),
  );
  const remoteByKey = new Map(
    remoteRecords.map((record) => [record.keyId, record]),
  );
  const localByKey = new Map<string, (typeof localRecords)[number]>();
  for (const localRecord of localRecords) {
    const encodedKey = await encodeBrowserValue(
      localRecord.key,
      replaceSensitive,
    );
    const keyId = JSON.stringify(encodedKey);
    localByKey.set(keyId, localRecord);
    const remote = remoteByKey.get(keyId);
    if (remote && !replaceSensitive) {
      remote.value = mergeLocalSecrets(remote.value, localRecord.value);
    } else if (
      !remote &&
      ((await encodeRecord(
        databaseName,
        localRecord.key,
        localRecord.value,
        replaceSensitive,
      )) === null ||
        (!replaceSensitive &&
          (isSensitiveSyncName(String(localRecord.key)) ||
            (await containsSensitiveTextValue(localRecord.value, true)))))
    ) {
      remoteRecords.push({
        key: localRecord.key,
        keyId,
        value: localRecord.value,
      });
    }
  }

  let folioUpdatedAt: number | null = null;
  if (databaseName === FOLIO_DB && storeName === FOLIO_STORE) {
    const remote = remoteRecords.find(
      (record) => record.key === FOLIO_COOKIE_KEY,
    );
    const local = localRecords.find(
      (record) => record.key === FOLIO_COOKIE_KEY,
    );
    if (remote) {
      const merged = mergeFolioCookieState(
        remote.value,
        local?.value,
        replaceSensitive,
      ) as { updatedAt: number; cookies: string };
      const localCookies = isRecord(local?.value) ? local.value.cookies : null;
      if (local && localCookies === merged.cookies) {
        remote.value = local.value;
      } else {
        remote.value = merged;
        folioUpdatedAt = merged.updatedAt;
      }
    }
  }

  const remoteKeys = new Set(remoteRecords.map((record) => record.keyId));
  const deletes = [...localByKey]
    .filter(([keyId]) => !remoteKeys.has(keyId))
    .map(([, record]) => record.key);
  const puts: typeof remoteRecords = [];
  for (const record of remoteRecords) {
    const local = localByKey.get(record.keyId);
    if (!local || !(await sameStoredValue(local.value, record.value))) {
      puts.push(record);
    }
  }
  if (!deletes.length && !puts.length) return { changes: 0, folioUpdatedAt };

  const writeTransaction = database.transaction(storeName, "readwrite");
  const done = transactionDone(writeTransaction);
  const store = writeTransaction.objectStore(storeName);
  for (const key of deletes) store.delete(key);
  for (const record of puts) {
    if (snapshot.keyPath === null) store.put(record.value, record.key);
    else store.put(record.value);
  }
  await done;
  return { changes: deletes.length + puts.length, folioUpdatedAt };
}

function deleteDatabase(factory: IDBFactory, name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = factory.deleteDatabase(name);
    request.onsuccess = () => {
      forgetIndexedDBName(name);
      resolve();
    };
    request.onerror = () =>
      reject(syncError("indexeddb database deletion failed"));
    request.onblocked = () =>
      reject(syncError("indexeddb database deletion blocked"));
  });
}

async function restoreIndexedDB(
  remote: Record<string, SyncDatabase>,
  includeSensitive: boolean,
): Promise<number> {
  const factory = globalThis.indexedDB;
  if (!factory) throw syncError("indexeddb is unavailable");
  const currentNames = await databaseNames(factory);
  let changes = 0;
  for (const name of currentNames) {
    const replaceSensitive = includeSensitive && allowsSensitiveDatabase(name);
    if (
      (replaceSensitive || !isSensitiveSyncName(name)) &&
      !hasOwn(remote, name)
    ) {
      await deleteDatabase(factory, name);
      changes++;
    }
  }

  let folioUpdatedAt: number | null = null;
  for (const [databaseName, databaseSnapshot] of Object.entries(remote)) {
    if (LOCAL_ONLY_DATABASES.has(databaseName)) continue;
    const { database, changed } = await reconcileDatabase(
      factory,
      databaseName,
      databaseSnapshot,
      currentNames.includes(databaseName),
      includeSensitive,
    );
    if (changed) changes++;
    try {
      for (const [storeName, storeSnapshot] of Object.entries(
        databaseSnapshot.stores,
      )) {
        const restored = await replaceRecords(
          database,
          databaseName,
          storeName,
          storeSnapshot,
          includeSensitive,
        );
        changes += restored.changes;
        if (restored.folioUpdatedAt !== null) {
          folioUpdatedAt = restored.folioUpdatedAt;
        }
      }
    } finally {
      database.close();
    }
  }

  if (folioUpdatedAt !== null && typeof BroadcastChannel !== "undefined") {
    const channel = new BroadcastChannel(FOLIO_CHANNEL);
    channel.postMessage({ updatedAt: folioUpdatedAt });
    channel.close();
  }
  return changes;
}

function legacyStoreSchema(
  databaseName: string,
  storeName: string,
  usesOutOfLineKeys: boolean,
  records: unknown[],
): { keyPath: KeyPath; autoIncrement: boolean } {
  if (usesOutOfLineKeys) return { keyPath: null, autoIncrement: false };
  if (databaseName === "rivet_extensions" && storeName === "extensions") {
    return { keyPath: "id", autoIncrement: false };
  }
  if (databaseName === FOLIO_DB && storeName === FOLIO_STORE) {
    return { keyPath: null, autoIncrement: false };
  }
  if (
    records.length > 0 &&
    records.every((record) => isRecord(record) && hasOwn(record, "id"))
  ) {
    return { keyPath: "id", autoIncrement: false };
  }
  return { keyPath: null, autoIncrement: true };
}

async function normalizeLegacySnapshot(
  value: unknown,
): Promise<SyncSnapshot | null> {
  if (
    !isRecord(value) ||
    !isRecord(value.localStorage) ||
    !isRecord(value.indexedDB)
  ) {
    return null;
  }
  if (
    value.schemaVersion === 1 &&
    isRecord(value.sessionStorage) &&
    (typeof value.cookies === "string" || isRecord(value.cookies))
  ) {
    const cookieHeader =
      typeof value.cookies === "string"
        ? value.cookies
        : Object.entries(value.cookies)
            .filter(
              ([name, entry]) =>
                !credentialCookieName(name) &&
                typeof entry === "string" &&
                !isSensitiveSyncText(entry),
            )
            .map(([name, entry]) => `${name}=${entry}`)
            .join("; ");
    const migrated = {
      schemaVersion: SYNC_SCHEMA_VERSION,
      localStorage: value.localStorage,
      sessionStorage: value.sessionStorage,
      cookies: legacyCookies(cookieHeader),
      indexedDB: value.indexedDB,
    };
    return isSyncSnapshot(migrated) ? migrated : null;
  }
  const localStorage: Record<string, string> = {};
  const sessionStorage: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value.localStorage)) {
    if (
      typeof entry === "string" &&
      (isSiteStorageName(key) || !isSensitiveSyncName(key))
    ) {
      localStorage[key] = entry;
    }
  }
  if (isRecord(value.sessionStorage)) {
    for (const [key, entry] of Object.entries(value.sessionStorage)) {
      if (
        typeof entry === "string" &&
        (isSiteStorageName(key) || !isSensitiveSyncName(key))
      ) {
        sessionStorage[key] = entry;
      }
    }
  }

  const indexedDB: Record<string, SyncDatabase> = {};
  for (const [databaseName, legacyDatabase] of Object.entries(
    value.indexedDB,
  )) {
    const allowSensitive = allowsSensitiveDatabase(databaseName);
    if (
      (!allowSensitive && isSensitiveSyncName(databaseName)) ||
      !isRecord(legacyDatabase)
    ) {
      continue;
    }
    const stores: Record<string, SyncStore> = {};
    for (const [storeName, legacyStore] of Object.entries(legacyDatabase)) {
      if (
        (!allowSensitive && isSensitiveSyncName(storeName)) ||
        !isRecord(legacyStore)
      ) {
        continue;
      }
      const records = Array.isArray(legacyStore.data) ? legacyStore.data : [];
      const usesOutOfLineKeys = legacyStore.usesOutOfLineKeys === true;
      const schema = legacyStoreSchema(
        databaseName,
        storeName,
        usesOutOfLineKeys,
        records,
      );
      const normalizedRecords: SyncRecord[] = [];
      for (let index = 0; index < records.length; index++) {
        const legacyRecord = records[index];
        let recordKey: unknown;
        let recordValue: unknown;
        if (
          usesOutOfLineKeys &&
          isRecord(legacyRecord) &&
          hasOwn(legacyRecord, "key") &&
          hasOwn(legacyRecord, "value")
        ) {
          recordKey = legacyRecord.key;
          recordValue = legacyRecord.value;
        } else {
          recordValue = legacyRecord;
          recordKey =
            schema.keyPath === "id" && isRecord(legacyRecord)
              ? legacyRecord.id
              : index + 1;
        }
        if (!allowSensitive && isSensitiveSyncName(String(recordKey))) continue;
        if (
          databaseName === FOLIO_DB &&
          storeName === FOLIO_STORE &&
          recordKey === FOLIO_COOKIE_KEY
        ) {
          recordValue = sanitizeFolioCookieState(recordValue, allowSensitive);
        }
        normalizedRecords.push({
          key: await encodeBrowserValue(recordKey, allowSensitive),
          value: await encodeBrowserValue(recordValue, allowSensitive),
        });
      }
      stores[storeName] = {
        ...schema,
        indexes: {},
        records: normalizedRecords,
      };
    }
    indexedDB[databaseName] = { stores };
  }
  let cookies: SyncCookie[] = [];
  if (typeof value.cookies === "string") {
    cookies = legacyCookies(value.cookies);
  } else if (isRecord(value.cookies)) {
    const cookieHeader: string[] = [];
    for (const [key, entry] of Object.entries(value.cookies)) {
      if (
        !credentialCookieName(key) &&
        typeof entry === "string" &&
        !isSensitiveSyncText(entry)
      ) {
        cookieHeader.push(`${key}=${entry}`);
      }
    }
    cookies = legacyCookies(cookieHeader.join("; "));
  }
  return {
    schemaVersion: SYNC_SCHEMA_VERSION,
    localStorage,
    sessionStorage,
    cookies,
    indexedDB,
  };
}

export async function importSyncSnapshot(
  value: unknown,
  progress: (message: string) => void = () => {},
): Promise<number> {
  const snapshot = isSyncSnapshot(value)
    ? value
    : isRecord(value) && value.schemaVersion === SYNC_SCHEMA_VERSION
      ? null
      : await normalizeLegacySnapshot(value);
  if (!snapshot || !isSyncSnapshot(snapshot)) {
    throw syncError("invalid sync snapshot");
  }
  const includeSensitive = snapshot.schemaVersion === SYNC_SCHEMA_VERSION;
  progress("restoring local storage...");
  let changes = replaceStorage(
    globalThis.localStorage,
    snapshot.localStorage,
    includeSensitive,
  );
  progress("restoring session storage...");
  changes += replaceStorage(
    globalThis.sessionStorage,
    snapshot.sessionStorage,
    includeSensitive,
  );
  progress("restoring cookies...");
  changes += await replaceCookies(snapshot.cookies);
  progress("restoring indexeddb...");
  changes += await restoreIndexedDB(snapshot.indexedDB, includeSensitive);
  return changes;
}

function applyStorageDelta(
  storage: StorageLike,
  previous: Record<string, string>,
  target: Record<string, string>,
): number {
  let changes = 0;
  for (const key of new Set([...Object.keys(previous), ...Object.keys(target)])) {
    if (isLocalOnlySyncStorageKey(key)) continue;
    const next = hasOwn(target, key) ? target[key]! : null;
    const prior = hasOwn(previous, key) ? previous[key]! : null;
    if (next === prior || storage.getItem(key) === next) continue;
    if (next === null) storage.removeItem(key);
    else storage.setItem(key, next);
    changes++;
  }
  return changes;
}

async function applyCookieDelta(
  previous: SyncCookie[],
  target: SyncCookie[],
): Promise<number> {
  const store = cookieStore();
  const before = new Map(
    previous.map((cookie) => [cookieIdentity(cookie), JSON.stringify(cookie)]),
  );
  const after = new Set(target.map(cookieIdentity));
  let changes = 0;
  for (const cookie of previous) {
    if (after.has(cookieIdentity(cookie))) continue;
    await deleteCookie(store, cookie);
    changes++;
  }
  for (const cookie of target) {
    if (
      before.get(cookieIdentity(cookie)) === JSON.stringify(cookie) ||
      !domainMatchesCurrentHost(cookie.domain)
    ) {
      continue;
    }
    writeCookie(cookie);
    changes++;
  }
  return changes;
}

function sameStoreDefinition(
  left: SyncStore | undefined,
  right: SyncStore,
): boolean {
  return (
    left !== undefined &&
    sameKeyPath(left.keyPath, right.keyPath) &&
    left.autoIncrement === right.autoIncrement &&
    JSON.stringify(left.indexes) === JSON.stringify(right.indexes)
  );
}

interface RecordDelta {
  puts: Array<{ key: IDBValidKey; value: unknown }>;
  deletes: IDBValidKey[];
}

function recordDelta(
  previous: SyncStore | undefined,
  target: SyncStore,
): RecordDelta {
  const before = new Map(
    (previous?.records ?? []).map((record) => [JSON.stringify(record.key), record]),
  );
  const targetKeys = new Set<string>();
  const puts: RecordDelta["puts"] = [];
  for (const record of target.records) {
    const keyId = JSON.stringify(record.key);
    targetKeys.add(keyId);
    const prior = before.get(keyId);
    if (prior && JSON.stringify(prior.value) === JSON.stringify(record.value)) {
      continue;
    }
    puts.push({
      key: decodeBrowserValue(record.key) as IDBValidKey,
      value: decodeBrowserValue(record.value),
    });
  }
  const deletes: IDBValidKey[] = [];
  for (const [keyId, record] of before) {
    if (!targetKeys.has(keyId)) {
      deletes.push(decodeBrowserValue(record.key) as IDBValidKey);
    }
  }
  return { puts, deletes };
}

async function applyRecordDelta(
  database: IDBDatabase,
  databaseName: string,
  storeName: string,
  keyPath: KeyPath,
  delta: RecordDelta,
): Promise<number | null> {
  let folioUpdatedAt: number | null = null;
  const folioCookies =
    databaseName === FOLIO_DB && storeName === FOLIO_STORE
      ? delta.puts.find((record) => record.key === FOLIO_COOKIE_KEY)
      : undefined;
  if (folioCookies) {
    const readTransaction = database.transaction(storeName, "readonly");
    const readDone = transactionDone(readTransaction);
    const current = readTransaction.objectStore(storeName).get(FOLIO_COOKIE_KEY);
    await readDone;
    folioCookies.value = mergeFolioCookieState(
      folioCookies.value,
      current.result,
      true,
    );
    folioUpdatedAt = (folioCookies.value as { updatedAt: number }).updatedAt;
  }
  const transaction = database.transaction(storeName, "readwrite");
  const done = transactionDone(transaction);
  const store = transaction.objectStore(storeName);
  for (const key of delta.deletes) store.delete(key);
  for (const record of delta.puts) {
    if (keyPath === null) store.put(record.value, record.key);
    else store.put(record.value);
  }
  await done;
  return folioUpdatedAt;
}

async function applyIndexedDBDelta(
  previous: Record<string, SyncDatabase>,
  target: Record<string, SyncDatabase>,
): Promise<number> {
  const factory = globalThis.indexedDB;
  if (!factory) throw syncError("indexeddb is unavailable");
  let changes = 0;
  let folioUpdatedAt: number | null = null;
  for (const name of Object.keys(previous)) {
    if (hasOwn(target, name) || LOCAL_ONLY_DATABASES.has(name)) continue;
    await deleteDatabase(factory, name);
    changes++;
  }
  const currentNames = new Set(await databaseNames(factory));
  for (const [name, snapshot] of Object.entries(target)) {
    if (LOCAL_ONLY_DATABASES.has(name)) continue;
    const prior = previous[name];
    const storeNames = Object.keys(snapshot.stores);
    const schemaUnchanged =
      prior !== undefined &&
      currentNames.has(name) &&
      storeNames.length === Object.keys(prior.stores).length &&
      storeNames.every((storeName) =>
        sameStoreDefinition(prior.stores[storeName], snapshot.stores[storeName]!),
      );
    if (!schemaUnchanged || !allowsSensitiveDatabase(name)) {
      const { database, changed } = await reconcileDatabase(
        factory,
        name,
        snapshot,
        currentNames.has(name),
        true,
      );
      if (changed) changes++;
      try {
        for (const [storeName, store] of Object.entries(snapshot.stores)) {
          const restored = await replaceRecords(database, name, storeName, store, true);
          changes += restored.changes;
          if (restored.folioUpdatedAt !== null) {
            folioUpdatedAt = restored.folioUpdatedAt;
          }
        }
      } finally {
        database.close();
      }
      continue;
    }
    const deltas = storeNames
      .filter((storeName) => canSyncIndexedDBStore(name, storeName))
      .map((storeName) => ({
        storeName,
        delta: recordDelta(prior.stores[storeName], snapshot.stores[storeName]!),
      }))
      .filter(({ delta }) => delta.puts.length || delta.deletes.length);
    if (!deltas.length) continue;
    const database = await openExistingDatabase(factory, name);
    try {
      for (const { storeName, delta } of deltas) {
        const updatedAt = await applyRecordDelta(
          database,
          name,
          storeName,
          snapshot.stores[storeName]!.keyPath,
          delta,
        );
        changes += delta.puts.length + delta.deletes.length;
        if (updatedAt !== null) folioUpdatedAt = updatedAt;
      }
    } finally {
      database.close();
    }
  }
  if (folioUpdatedAt !== null && typeof BroadcastChannel !== "undefined") {
    const channel = new BroadcastChannel(FOLIO_CHANNEL);
    channel.postMessage({ updatedAt: folioUpdatedAt });
    channel.close();
  }
  return changes;
}

export async function applySyncDelta(
  previous: SyncSnapshot,
  target: unknown,
  progress: (message: string) => void = () => {},
): Promise<number> {
  if (
    !isSyncSnapshot(previous) ||
    !isSyncSnapshot(target) ||
    target.schemaVersion !== SYNC_SCHEMA_VERSION
  ) {
    return importSyncSnapshot(target, progress);
  }
  progress("restoring local storage...");
  let changes = applyStorageDelta(
    globalThis.localStorage,
    previous.localStorage,
    target.localStorage,
  );
  progress("restoring session storage...");
  changes += applyStorageDelta(
    globalThis.sessionStorage,
    previous.sessionStorage,
    target.sessionStorage,
  );
  progress("restoring cookies...");
  changes += await applyCookieDelta(previous.cookies, target.cookies);
  progress("restoring indexeddb...");
  changes += await applyIndexedDBDelta(previous.indexedDB, target.indexedDB);
  return changes;
}

export async function snapshotFingerprint(
  snapshot: SyncSnapshot,
): Promise<string> {
  return (await prepareSnapshot({ snapshot })).fingerprint;
}

export function changedDuringUpload(
  capturedVersion: number,
  currentVersion: number,
): boolean {
  return capturedVersion !== currentVersion;
}
