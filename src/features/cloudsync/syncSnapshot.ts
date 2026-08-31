import { negativeMessage } from "../../core/runtime/messages.ts";

const SYNC_SCHEMA_VERSION = 3 as const;
const LEGACY_SYNC_SCHEMA_VERSION = 2 as const;

const FOLIO_DB = "__folio_controller";
const FOLIO_STORE = "state";
const FOLIO_COOKIE_KEY = "cookies";
const FOLIO_CHANNEL = "__folio_controller_channel";
const IDB_REGISTRY_KEY = "lyra-sync-idb-names";
const MAX_SITE_RECORD_BYTES = 1024 * 1024;

const LOCAL_ONLY_RIVET_STORES = new Set(["extensions", "extension_files"]);

const LOCAL_ONLY_KEYS = new Set([
  "auth_user",
  "auth_token",
  "lyra-sync-meta",
  IDB_REGISTRY_KEY,
  "__lyra_folio_session",
]);

const SENSITIVE_PARTS = new Set([
  "password",
  "passwd",
  "secret",
  "credential",
  "credentials",
  "auth",
  "authorization",
  "bearer",
  "cookie",
  "csrf",
  "oauth",
  "token",
  "jwt",
  "session",
  "sessionid",
  "xsrf",
]);

type KeyPath = string | string[] | null;

type EncodedValue =
  | { type: "null" }
  | { type: "undefined" }
  | { type: "boolean"; value: boolean }
  | { type: "string"; value: string }
  | { type: "number"; value: number | "nan" | "infinity" | "-infinity" | "-0" }
  | { type: "bigint"; value: string }
  | { type: "reference"; value: number }
  | { type: "date"; id: number; value: string }
  | { type: "regexp"; id: number; value: { source: string; flags: string } }
  | { type: "array"; id: number; value: EncodedValue[] }
  | { type: "object"; id: number; value: Record<string, EncodedValue> }
  | { type: "map"; id: number; value: Array<[EncodedValue, EncodedValue]> }
  | { type: "set"; id: number; value: EncodedValue[] }
  | { type: "array_buffer"; id: number; value: string }
  | {
      type: "typed_array";
      id: number;
      value: {
        name: string;
        buffer: EncodedValue;
        byteOffset: number;
        length: number;
      };
    }
  | { type: "blob"; id: number; value: { mediaType: string; bytes: string } }
  | {
      type: "file";
      id: number;
      value: {
        name: string;
        mediaType: string;
        lastModified: number;
        bytes: string;
      };
    };

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
  schemaVersion:
    | typeof LEGACY_SYNC_SCHEMA_VERSION
    | typeof SYNC_SCHEMA_VERSION;
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

interface EncodeState {
  ids: WeakMap<object, number>;
  nextId: number;
}

const TYPED_ARRAY_NAMES = new Set([
  "DataView",
  "Int8Array",
  "Uint8Array",
  "Uint8ClampedArray",
  "Int16Array",
  "Uint16Array",
  "Int32Array",
  "Uint32Array",
  "Float32Array",
  "Float64Array",
  "BigInt64Array",
  "BigUint64Array",
]);

function syncError(message: string): Error {
  return new Error(negativeMessage(message));
}

function normalizedParts(name: string): string[] {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

export function isSensitiveSyncName(name: string): boolean {
  const trimmed = name.trim();
  const normalized = trimmed.toLowerCase();
  if (!normalized) return false;
  const leaf = normalized.slice(normalized.lastIndexOf("@") + 1);
  const originalLeaf = trimmed.slice(trimmed.lastIndexOf("@") + 1);
  if (LOCAL_ONLY_KEYS.has(normalized) || LOCAL_ONLY_KEYS.has(leaf)) return true;
  if (
    /(?:access|refresh|identity|id|auth|session|api|private)[_-]?token/.test(
      leaf,
    ) ||
    /(?:csrf|xsrf|oauth)[_-]?token/.test(leaf) ||
    /(?:api|private)[_-]?key/.test(leaf)
  ) {
    return true;
  }
  return normalizedParts(originalLeaf).some((part) => SENSITIVE_PARTS.has(part));
}

function isSiteStorageName(name: string): boolean {
  const separator = name.lastIndexOf("@");
  return separator > 0 && separator < name.length - 1;
}

function isSiteDatabaseName(name: string): boolean {
  const separator = name.lastIndexOf("@");
  if (separator < 1 || separator === name.length - 1) return false;
  const origin = name.slice(0, separator).toLowerCase();
  return origin.startsWith("https://") || origin.startsWith("http://");
}

function allowsSensitiveDatabase(name: string): boolean {
  return (
    name === FOLIO_DB ||
    name === "rivet_extensions" ||
    isSiteDatabaseName(name)
  );
}

export function canSyncIndexedDBStore(
  databaseName: string,
  storeName: string,
): boolean {
  return (
    databaseName !== "rivet_extensions" ||
    !LOCAL_ONLY_RIVET_STORES.has(storeName)
  );
}

export function containsLocalOnlySiteData(
  value: unknown,
  seen = new WeakSet<object>(),
): boolean {
  if (typeof value !== "object" || value === null) return false;
  if (
    value instanceof ArrayBuffer ||
    ArrayBuffer.isView(value) ||
    (typeof Blob !== "undefined" && value instanceof Blob)
  ) {
    return true;
  }
  if (seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value) || value instanceof Set) {
    for (const entry of value) {
      if (containsLocalOnlySiteData(entry, seen)) return true;
    }
    return false;
  }
  if (value instanceof Map) {
    for (const [key, entry] of value) {
      if (
        containsLocalOnlySiteData(key, seen) ||
        containsLocalOnlySiteData(entry, seen)
      ) {
        return true;
      }
    }
    return false;
  }
  return Object.values(value).some((entry) =>
    containsLocalOnlySiteData(entry, seen),
  );
}

function looksLikeJwt(value: string): boolean {
  const parts = value.trim().split(".");
  return (
    parts.length === 3 &&
    parts[0]!.startsWith("eyJ") &&
    parts[1]!.startsWith("eyJ") &&
    parts.every(
      (part) => part.length >= 8 && /^[a-zA-Z0-9_-]+$/.test(part),
    )
  );
}

function looksLikeProviderCredential(value: string): boolean {
  const trimmed = value.trim();
  return (
    /^(?:bearer|basic)\s+\S{8,}$/i.test(trimmed) ||
    /-----begin [^-\r\n]*private key-----/i.test(trimmed) ||
    /^\$(?:2[aby]|argon2(?:id|i|d))\$/.test(trimmed) ||
    /^(?:gh[pousr]_[a-zA-Z0-9]{20,}|github_pat_[a-zA-Z0-9_]{20,}|xox[baprs]-\S{10,}|sk_(?:live|test)_[a-zA-Z0-9]{12,})$/.test(
      trimmed,
    ) ||
    /^AKIA[A-Z0-9]{16}$/.test(trimmed)
  );
}

function containsCredentialText(value: string): boolean {
  if (looksLikeJwt(value) || looksLikeProviderCredential(value)) return true;
  return (
    /(?:^|[^a-zA-Z0-9_-])eyJ[a-zA-Z0-9_-]{5,}\.eyJ[a-zA-Z0-9_-]{5,}\.[a-zA-Z0-9_-]{8,}(?:$|[^a-zA-Z0-9_-])/.test(
      value,
    ) ||
    /["'](?:access[_-]?token|refresh[_-]?token|auth[_-]?token|session[_-]?token|api[_-]?key|private[_-]?key|password|passwd|secret|authorization|credential|jwt)["']\s*[:=]/i.test(
      value,
    ) ||
    /(?:^|[\s"'=:\[])(?:bearer|basic)\s+[a-zA-Z0-9+/_=-]{8,}/i.test(value) ||
    /(?:^|[^a-zA-Z0-9_])(?:gh[pousr]_[a-zA-Z0-9]{20,}|github_pat_[a-zA-Z0-9_]{20,}|xox[baprs]-\S{10,}|sk_(?:live|test)_[a-zA-Z0-9]{12,}|AKIA[A-Z0-9]{16})(?:$|[^a-zA-Z0-9_])/.test(
      value,
    ) ||
    /-----begin [^-\r\n]*private key-----/i.test(value) ||
    /\$(?:2[aby]|argon2(?:id|i|d))\$/.test(value)
  );
}

function containsSensitiveJson(
  value: unknown,
  seen = new WeakSet<object>(),
): boolean {
  if (typeof value === "string") return isSensitiveSyncText(value, false);
  if (typeof value !== "object" || value === null) return false;
  if (seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) {
    return value.some((entry) => containsSensitiveJson(entry, seen));
  }
  for (const [key, entry] of Object.entries(value)) {
    if (isSensitiveSyncName(key) || containsSensitiveJson(entry, seen)) return true;
  }
  return false;
}

function isSensitiveSyncText(
  value: string,
  inspectJson = true,
): boolean {
  if (containsCredentialText(value)) return true;
  if (!inspectJson || value.length > 1024 * 1024) return false;
  const trimmed = value.trim();
  if (
    !(
      (trimmed.startsWith("{") && trimmed.endsWith("}")) ||
      (trimmed.startsWith("[") && trimmed.endsWith("]"))
    )
  ) {
    return false;
  }
  try {
    return containsSensitiveJson(JSON.parse(trimmed));
  } catch {
    return false;
  }
}

export function canSyncStorageValue(name: string, value: string): boolean {
  return (
    isSiteStorageName(name) ||
    (!isSensitiveSyncName(name) && !isSensitiveSyncText(value))
  );
}

function bytesContainSensitiveText(bytes: Uint8Array): boolean {
  const decoder = new TextDecoder();
  const chunkSize = 64 * 1024;
  const overlap = 512;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    const start = Math.max(0, offset - overlap);
    const text = decoder.decode(bytes.subarray(start, offset + chunkSize));
    if (containsCredentialText(text)) return true;
  }
  return false;
}

function validEncodedBytes(value: string): boolean {
  const chunkSize = 64 * 1024;
  const overlap = 512;
  if (
    value.length % 4 !== 0 ||
    (value.indexOf("=") >= 0 && value.indexOf("=") < value.length - 2)
  ) {
    return false;
  }
  let carry = new Uint8Array();
  try {
    for (let offset = 0; offset < value.length; offset += chunkSize) {
      const binary = atob(value.slice(offset, offset + chunkSize));
      const scanned = new Uint8Array(carry.length + binary.length);
      scanned.set(carry);
      for (let index = 0; index < binary.length; index++) {
        scanned[carry.length + index] = binary.charCodeAt(index);
      }
      if (bytesContainSensitiveText(scanned)) return false;
      carry = scanned.slice(Math.max(0, scanned.length - overlap));
    }
    return true;
  } catch {
    return false;
  }
}

async function containsSensitiveTextValue(
  value: unknown,
  inspectNames = false,
  seen = new WeakSet<object>(),
): Promise<boolean> {
  if (typeof value === "string") return isSensitiveSyncText(value);
  if (typeof value !== "object" || value === null) return false;
  if (isCredentialObject(value)) return true;
  if (seen.has(value)) return false;
  seen.add(value);
  if (value instanceof ArrayBuffer) {
    return bytesContainSensitiveText(new Uint8Array(value));
  }
  if (ArrayBuffer.isView(value)) {
    return bytesContainSensitiveText(new Uint8Array(value.buffer));
  }
  if (typeof Blob !== "undefined" && value instanceof Blob) {
    return bytesContainSensitiveText(new Uint8Array(await value.arrayBuffer()));
  }
  if (Array.isArray(value) || value instanceof Set) {
    for (const entry of value) {
      if (await containsSensitiveTextValue(entry, inspectNames, seen)) return true;
    }
    return false;
  }
  if (value instanceof Map) {
    for (const [key, entry] of value) {
      if (
        (inspectNames && typeof key === "string" && isSensitiveSyncName(key)) ||
        (await containsSensitiveTextValue(key, inspectNames, seen)) ||
        (await containsSensitiveTextValue(entry, inspectNames, seen))
      ) {
        return true;
      }
    }
    return false;
  }
  for (const [key, entry] of Object.entries(value)) {
    if (
      (inspectNames && isSensitiveSyncName(key)) ||
      (await containsSensitiveTextValue(entry, inspectNames, seen))
    ) {
      return true;
    }
  }
  return false;
}

function hasOwn(value: object, key: PropertyKey): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function isCredentialObject(value: object): boolean {
  return [
    "[object CryptoKey]",
    "[object Credential]",
    "[object PasswordCredential]",
    "[object FederatedCredential]",
    "[object PublicKeyCredential]",
  ].includes(Object.prototype.toString.call(value));
}

function bytesToBase64(bytes: Uint8Array): string {
  const chunks: string[] = [];
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    const chunk = bytes.subarray(offset, offset + chunkSize);
    chunks.push(String.fromCharCode(...chunk));
  }
  return btoa(chunks.join(""));
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function bytesToArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;
}

function typedArray(
  name: string,
  buffer: ArrayBuffer,
  byteOffset: number,
  length: number,
): ArrayBufferView {
  switch (name) {
    case "DataView":
      return new DataView(buffer, byteOffset, length);
    case "Int8Array":
      return new Int8Array(buffer, byteOffset, length);
    case "Uint8Array":
      return new Uint8Array(buffer, byteOffset, length);
    case "Uint8ClampedArray":
      return new Uint8ClampedArray(buffer, byteOffset, length);
    case "Int16Array":
      return new Int16Array(buffer, byteOffset, length);
    case "Uint16Array":
      return new Uint16Array(buffer, byteOffset, length);
    case "Int32Array":
      return new Int32Array(buffer, byteOffset, length);
    case "Uint32Array":
      return new Uint32Array(buffer, byteOffset, length);
    case "Float32Array":
      return new Float32Array(buffer, byteOffset, length);
    case "Float64Array":
      return new Float64Array(buffer, byteOffset, length);
    case "BigInt64Array":
      return new BigInt64Array(buffer, byteOffset, length);
    case "BigUint64Array":
      return new BigUint64Array(buffer, byteOffset, length);
    default:
      throw syncError("unsupported typed array");
  }
}

async function encodeValue(
  value: unknown,
  state: EncodeState,
  allowSensitive = false,
): Promise<EncodedValue> {
  if (value === null) return { type: "null" };
  if (value === undefined) return { type: "undefined" };
  if (typeof value === "boolean") return { type: "boolean", value };
  if (typeof value === "string") return { type: "string", value };
  if (typeof value === "bigint") return { type: "bigint", value: String(value) };
  if (typeof value === "number") {
    const encoded = Number.isNaN(value)
      ? "nan"
      : value === Number.POSITIVE_INFINITY
        ? "infinity"
        : value === Number.NEGATIVE_INFINITY
          ? "-infinity"
          : Object.is(value, -0)
            ? "-0"
            : value;
    return { type: "number", value: encoded };
  }
  if (typeof value !== "object") {
    throw syncError("unsupported browser storage value");
  }
  if (isCredentialObject(value)) {
    throw syncError("credential values cannot be synced");
  }

  const existingId = state.ids.get(value);
  if (existingId !== undefined) return { type: "reference", value: existingId };
  const id = state.nextId++;
  state.ids.set(value, id);

  if (value instanceof Date) {
    return { type: "date", id, value: value.toISOString() };
  }
  if (value instanceof RegExp) {
    return {
      type: "regexp",
      id,
      value: { source: value.source, flags: value.flags },
    };
  }
  if (value instanceof ArrayBuffer) {
    return {
      type: "array_buffer",
      id,
      value: bytesToBase64(new Uint8Array(value)),
    };
  }
  if (ArrayBuffer.isView(value)) {
    const name = value instanceof DataView ? "DataView" : value.constructor.name;
    const length = "length" in value ? Number(value.length) : value.byteLength;
    return {
      type: "typed_array",
      id,
      value: {
        name,
        buffer: await encodeValue(value.buffer, state, allowSensitive),
        byteOffset: value.byteOffset,
        length,
      },
    };
  }
  if (typeof File !== "undefined" && value instanceof File) {
    return {
      type: "file",
      id,
      value: {
        name: value.name,
        mediaType: value.type,
        lastModified: value.lastModified,
        bytes: bytesToBase64(new Uint8Array(await value.arrayBuffer())),
      },
    };
  }
  if (typeof Blob !== "undefined" && value instanceof Blob) {
    return {
      type: "blob",
      id,
      value: {
        mediaType: value.type,
        bytes: bytesToBase64(new Uint8Array(await value.arrayBuffer())),
      },
    };
  }
  if (Array.isArray(value)) {
    return {
      type: "array",
      id,
      value: await Promise.all(
        value.map((entry) => encodeValue(entry, state, allowSensitive)),
      ),
    };
  }
  if (value instanceof Map) {
    const entries: Array<[EncodedValue, EncodedValue]> = [];
    for (const [key, entry] of value) {
      if (
        !allowSensitive &&
        typeof key === "string" &&
        isSensitiveSyncName(key)
      ) {
        continue;
      }
      entries.push([
        await encodeValue(key, state, allowSensitive),
        await encodeValue(entry, state, allowSensitive),
      ]);
    }
    return { type: "map", id, value: entries };
  }
  if (value instanceof Set) {
    const entries: EncodedValue[] = [];
    for (const entry of value) {
      entries.push(await encodeValue(entry, state, allowSensitive));
    }
    return { type: "set", id, value: entries };
  }

  const entries: Record<string, EncodedValue> = Object.create(null);
  for (const key of Object.keys(value).sort()) {
    if (!allowSensitive && isSensitiveSyncName(key)) continue;
    entries[key] = await encodeValue(
      (value as Record<string, unknown>)[key],
      state,
      allowSensitive,
    );
  }
  return { type: "object", id, value: entries };
}

function encodeBrowserValue(
  value: unknown,
  allowSensitive = false,
): Promise<EncodedValue> {
  return encodeValue(
    value,
    { ids: new WeakMap(), nextId: 1 },
    allowSensitive,
  );
}

function decodeValue(
  encoded: EncodedValue,
  references: Map<number, unknown>,
): unknown {
  switch (encoded.type) {
    case "null":
      return null;
    case "undefined":
      return undefined;
    case "boolean":
    case "string":
      return encoded.value;
    case "number":
      if (typeof encoded.value === "number") return encoded.value;
      if (encoded.value === "nan") return Number.NaN;
      if (encoded.value === "infinity") return Number.POSITIVE_INFINITY;
      if (encoded.value === "-infinity") return Number.NEGATIVE_INFINITY;
      return -0;
    case "bigint":
      return BigInt(encoded.value);
    case "reference": {
      if (!references.has(encoded.value)) {
        throw syncError("invalid browser storage reference");
      }
      return references.get(encoded.value);
    }
    case "date": {
      const value = new Date(encoded.value);
      references.set(encoded.id, value);
      return value;
    }
    case "regexp": {
      const value = new RegExp(encoded.value.source, encoded.value.flags);
      references.set(encoded.id, value);
      return value;
    }
    case "array": {
      const value: unknown[] = [];
      references.set(encoded.id, value);
      for (const entry of encoded.value) {
        value.push(decodeValue(entry, references));
      }
      return value;
    }
    case "object": {
      const value: Record<string, unknown> = {};
      references.set(encoded.id, value);
      for (const [key, entry] of Object.entries(encoded.value)) {
        Object.defineProperty(value, key, {
          value: decodeValue(entry, references),
          enumerable: true,
          configurable: true,
          writable: true,
        });
      }
      return value;
    }
    case "map": {
      const value = new Map<unknown, unknown>();
      references.set(encoded.id, value);
      for (const [key, entry] of encoded.value) {
        value.set(
          decodeValue(key, references),
          decodeValue(entry, references),
        );
      }
      return value;
    }
    case "set": {
      const value = new Set<unknown>();
      references.set(encoded.id, value);
      for (const entry of encoded.value) {
        value.add(decodeValue(entry, references));
      }
      return value;
    }
    case "array_buffer": {
      const bytes = base64ToBytes(encoded.value);
      const value = bytesToArrayBuffer(bytes);
      references.set(encoded.id, value);
      return value;
    }
    case "typed_array": {
      const buffer = decodeValue(encoded.value.buffer, references) as ArrayBuffer;
      const value = typedArray(
        encoded.value.name,
        buffer,
        encoded.value.byteOffset,
        encoded.value.length,
      );
      references.set(encoded.id, value);
      return value;
    }
    case "blob": {
      const value = new Blob([bytesToArrayBuffer(base64ToBytes(encoded.value.bytes))], {
        type: encoded.value.mediaType,
      });
      references.set(encoded.id, value);
      return value;
    }
    case "file": {
      const bytes = base64ToBytes(encoded.value.bytes);
      const value =
        typeof File === "undefined"
          ? new Blob([bytesToArrayBuffer(bytes)], { type: encoded.value.mediaType })
          : new File([bytesToArrayBuffer(bytes)], encoded.value.name, {
              type: encoded.value.mediaType,
              lastModified: encoded.value.lastModified,
            });
      references.set(encoded.id, value);
      return value;
    }
  }
}

function decodeBrowserValue(encoded: EncodedValue): unknown {
  return decodeValue(encoded, new Map());
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
    Object.entries(cookies).sort(([left], [right]) => left.localeCompare(right)),
  );
}

const COOKIE_NAME_PATTERN = /^[!#$%&'*+\-.^_`|~0-9a-zA-Z]+$/;
const COOKIE_VALUE_PATTERN = /^[\x21-\x7e]*$/;
const COOKIE_DOMAIN_PATTERN = /^\.?[a-zA-Z0-9.-]+$/;

function cookieStore(): CookieStoreLike | null {
  const store = (globalThis as unknown as { cookieStore?: unknown }).cookieStore;
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
      (!Number.isFinite(cookie.expires) || cookie.expires < 0 || cookie.expires > 8.64e15)) ||
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
      if (typeof entry.name !== "string" || typeof entry.value !== "string") continue;
      const sameSite = ["strict", "lax", "none"].includes(String(entry.sameSite))
        ? (entry.sameSite as SyncSameSite)
        : "lax";
      const cookie: SyncCookie = {
        name: entry.name,
        value: entry.value,
        domain: typeof entry.domain === "string" && entry.domain ? entry.domain : null,
        path: typeof entry.path === "string" && entry.path ? entry.path : "/",
        expires:
          typeof entry.expires === "number" && Number.isFinite(entry.expires)
            ? entry.expires
            : null,
        sameSite,
        secure: typeof entry.secure === "boolean" ? entry.secure : secureContext,
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
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
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
          (field) =>
            field in cookie && typeof cookie[field] !== "string",
        ) ||
        ["hostOnly", "secure", "httpOnly", "partitioned"].some(
          (field) =>
            field in cookie && typeof cookie[field] !== "boolean",
        ) ||
        ["expires", "maxAge"].some(
          (field) =>
            field in cookie && typeof cookie[field] !== "number",
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
    transaction.onabort = () => reject(syncError("indexeddb transaction aborted"));
    transaction.onerror = () => reject(syncError("indexeddb transaction failed"));
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
          name &&
          (allowsSensitiveDatabase(name) || !isSensitiveSyncName(name)),
      )
      .sort();
    globalThis.localStorage?.setItem(IDB_REGISTRY_KEY, JSON.stringify(safe));
  } catch {}
}

export function rememberIndexedDBName(name: string): void {
  if (
    !name ||
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
          (allowsSensitiveDatabase(name) || !isSensitiveSyncName(name)),
      )
      .sort();
    saveDatabaseNames(names);
    return names;
  }

  const names: string[] = [];
  for (const name of [...registeredDatabaseNames()].sort()) {
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
    request.onblocked = () => reject(syncError("indexeddb database open blocked"));
  });
}

function keyPath(value: string | string[] | null): KeyPath {
  return Array.isArray(value) ? [...value] : value;
}

async function readRawRecords(store: IDBObjectStore): Promise<Array<{ key: IDBValidKey; value: unknown }>> {
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
    if (
      isSiteDatabaseName(databaseName) &&
      new TextEncoder().encode(JSON.stringify(record)).byteLength >
        MAX_SITE_RECORD_BYTES
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
  const databases = await mapConcurrent(names, 4, async (name) => [
    name,
    await exportDatabase(factory, name),
  ] as const);
  const indexedDB = Object.fromEntries(databases);
  return {
    schemaVersion: SYNC_SCHEMA_VERSION,
    localStorage: exportStorage(globalThis.localStorage),
    sessionStorage: exportStorage(globalThis.sessionStorage),
    cookies,
    indexedDB,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validKeyPath(value: unknown): value is KeyPath {
  return (
    value === null ||
    typeof value === "string" ||
    (Array.isArray(value) && value.every((entry) => typeof entry === "string"))
  );
}

function validEncodedValue(
  value: unknown,
  ids = new Set<number>(),
  allowSensitive = false,
): value is EncodedValue {
  if (!isRecord(value) || typeof value.type !== "string") return false;
  if (value.type === "null" || value.type === "undefined") return true;
  if (value.type === "boolean") return typeof value.value === "boolean";
  if (value.type === "string") {
    return (
      typeof value.value === "string" &&
      (allowSensitive || !isSensitiveSyncText(value.value))
    );
  }
  if (value.type === "bigint") {
    return typeof value.value === "string";
  }
  if (value.type === "number") {
    return (
      typeof value.value === "number" ||
      ["nan", "infinity", "-infinity", "-0"].includes(String(value.value))
    );
  }
  if (value.type === "reference") {
    return typeof value.value === "number" && ids.has(value.value);
  }
  if (typeof value.id !== "number" || ids.has(value.id)) return false;
  ids.add(value.id);
  if (value.type === "date") {
    return typeof value.value === "string";
  }
  if (value.type === "array_buffer") {
    return (
      typeof value.value === "string" &&
      (allowSensitive || validEncodedBytes(value.value))
    );
  }
  if (value.type === "regexp") {
    return (
      isRecord(value.value) &&
      typeof value.value.source === "string" &&
      typeof value.value.flags === "string"
    );
  }
  if (value.type === "array" || value.type === "set") {
    return (
      Array.isArray(value.value) &&
      value.value.every((entry) =>
        validEncodedValue(entry, ids, allowSensitive),
      )
    );
  }
  if (value.type === "object") {
    return (
      isRecord(value.value) &&
      Object.entries(value.value).every(
        ([key, entry]) =>
          (allowSensitive || !isSensitiveSyncName(key)) &&
          validEncodedValue(entry, ids, allowSensitive),
      )
    );
  }
  if (value.type === "map") {
    return (
      Array.isArray(value.value) &&
      value.value.every(
        (entry) =>
          Array.isArray(entry) &&
          entry.length === 2 &&
          (allowSensitive || !(
            isRecord(entry[0]) &&
            entry[0].type === "string" &&
            typeof entry[0].value === "string" &&
            isSensitiveSyncName(entry[0].value)
          )) &&
          validEncodedValue(entry[0], ids, allowSensitive) &&
          validEncodedValue(entry[1], ids, allowSensitive),
      )
    );
  }
  if (value.type === "typed_array") {
    return (
      isRecord(value.value) &&
      typeof value.value.name === "string" &&
      TYPED_ARRAY_NAMES.has(value.value.name) &&
      typeof value.value.byteOffset === "number" &&
      typeof value.value.length === "number" &&
      validEncodedValue(value.value.buffer, ids, allowSensitive)
    );
  }
  if (value.type === "blob") {
    return (
      isRecord(value.value) &&
      typeof value.value.mediaType === "string" &&
      typeof value.value.bytes === "string" &&
      (allowSensitive || validEncodedBytes(value.value.bytes))
    );
  }
  if (value.type === "file") {
    return (
      isRecord(value.value) &&
      typeof value.value.name === "string" &&
      typeof value.value.mediaType === "string" &&
      typeof value.value.lastModified === "number" &&
      typeof value.value.bytes === "string" &&
      (allowSensitive || validEncodedBytes(value.value.bytes))
    );
  }
  return false;
}

function isSyncSnapshot(value: unknown): value is SyncSnapshot {
  if (
    !isRecord(value) ||
    ![
      LEGACY_SYNC_SCHEMA_VERSION,
      SYNC_SCHEMA_VERSION,
    ].includes(value.schemaVersion as 2 | 3) ||
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
          (!includeSensitive || !isSiteStorageName(key)) &&
            (isSensitiveSyncName(key) || isSensitiveSyncText(entry)),
      )
    ) {
      return false;
    }
  }
  if (
    !Array.isArray(value.cookies) ||
    value.cookies.length > 1024 ||
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
): void {
  const currentKeys: string[] = [];
  for (let index = 0; index < storage.length; index++) {
    const key = storage.key(index);
    if (key !== null) currentKeys.push(key);
  }
  for (const key of currentKeys) {
    const current = storage.getItem(key);
    const replaceSensitive = includeSensitive && isSiteStorageName(key);
    if (
      (replaceSensitive ||
        (!isSensitiveSyncName(key) &&
          !(current !== null && isSensitiveSyncText(current)))) &&
      !hasOwn(remote, key)
    ) {
      storage.removeItem(key);
    }
  }
  for (const [key, value] of Object.entries(remote)) {
    storage.setItem(key, value);
  }
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

async function replaceCookies(remote: SyncCookie[]): Promise<void> {
  const current = await exportBrowserCookies();
  const remoteIds = new Set(remote.map(cookieIdentity));
  const store = cookieStore();
  for (const cookie of current) {
    if (remoteIds.has(cookieIdentity(cookie))) continue;
    if (store) {
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
    } else {
      expireCookie(cookie.name);
    }
  }
  for (const cookie of remote) {
    if (domainMatchesCurrentHost(cookie.domain)) writeCookie(cookie);
  }
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
    request.onerror = () => reject(syncError("indexeddb database creation failed"));
    request.onblocked = () => reject(syncError("indexeddb database creation blocked"));
  });
}

async function reconcileDatabase(
  factory: IDBFactory,
  name: string,
  snapshot: SyncDatabase,
  exists: boolean,
  includeSensitive: boolean,
): Promise<IDBDatabase> {
  if (!exists) return openNewDatabase(factory, name, snapshot);
  const allowSensitive =
    includeSensitive && allowsSensitiveDatabase(name);
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
  if (schemaMatches) return database;

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
    request.onerror = () => reject(syncError("indexeddb schema restore failed"));
    request.onblocked = () => reject(syncError("indexeddb schema restore blocked"));
  });
  return database;
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

async function replaceRecords(
  database: IDBDatabase,
  databaseName: string,
  storeName: string,
  snapshot: SyncStore,
  includeSensitive: boolean,
): Promise<number | null> {
  if (!canSyncIndexedDBStore(databaseName, storeName)) return null;
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
  const remoteByKey = new Map(remoteRecords.map((record) => [record.keyId, record]));
  for (const localRecord of localRecords) {
    const encodedKey = await encodeBrowserValue(
      localRecord.key,
      replaceSensitive,
    );
    const keyId = JSON.stringify(encodedKey);
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
    const remote = remoteRecords.find((record) => record.key === FOLIO_COOKIE_KEY);
    const local = localRecords.find((record) => record.key === FOLIO_COOKIE_KEY);
    if (remote) {
      remote.value = mergeFolioCookieState(
        remote.value,
        local?.value,
        replaceSensitive,
      );
      folioUpdatedAt = (remote.value as { updatedAt: number }).updatedAt;
    }
  }

  const writeTransaction = database.transaction(storeName, "readwrite");
  const done = transactionDone(writeTransaction);
  const store = writeTransaction.objectStore(storeName);
  store.clear();
  for (const record of remoteRecords) {
    if (snapshot.keyPath === null) store.put(record.value, record.key);
    else store.put(record.value);
  }
  await done;
  return folioUpdatedAt;
}

function deleteDatabase(factory: IDBFactory, name: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = factory.deleteDatabase(name);
    request.onsuccess = () => {
      forgetIndexedDBName(name);
      resolve();
    };
    request.onerror = () => reject(syncError("indexeddb database deletion failed"));
    request.onblocked = () => reject(syncError("indexeddb database deletion blocked"));
  });
}

async function restoreIndexedDB(
  remote: Record<string, SyncDatabase>,
  includeSensitive: boolean,
): Promise<void> {
  const factory = globalThis.indexedDB;
  if (!factory) throw syncError("indexeddb is unavailable");
  const currentNames = await databaseNames(factory);
  for (const name of currentNames) {
    const replaceSensitive =
      includeSensitive && allowsSensitiveDatabase(name);
    if (
      (replaceSensitive || !isSensitiveSyncName(name)) &&
      !hasOwn(remote, name)
    ) {
      await deleteDatabase(factory, name);
    }
  }

  let folioUpdatedAt: number | null = null;
  for (const [databaseName, databaseSnapshot] of Object.entries(remote)) {
    const database = await reconcileDatabase(
      factory,
      databaseName,
      databaseSnapshot,
      currentNames.includes(databaseName),
      includeSensitive,
    );
    try {
      for (const [storeName, storeSnapshot] of Object.entries(
        databaseSnapshot.stores,
      )) {
        const updatedAt = await replaceRecords(
          database,
          databaseName,
          storeName,
          storeSnapshot,
          includeSensitive,
        );
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

async function normalizeLegacySnapshot(value: unknown): Promise<SyncSnapshot | null> {
  if (!isRecord(value) || !isRecord(value.localStorage) || !isRecord(value.indexedDB)) {
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
  for (const [databaseName, legacyDatabase] of Object.entries(value.indexedDB)) {
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
): Promise<void> {
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
  replaceStorage(
    globalThis.localStorage,
    snapshot.localStorage,
    includeSensitive,
  );
  progress("restoring session storage...");
  replaceStorage(
    globalThis.sessionStorage,
    snapshot.sessionStorage,
    includeSensitive,
  );
  progress("restoring cookies...");
  await replaceCookies(snapshot.cookies);
  progress("restoring indexeddb...");
  await restoreIndexedDB(snapshot.indexedDB, includeSensitive);
}

export async function payloadFingerprint(payload: string): Promise<string> {
  if (globalThis.crypto?.subtle) {
    const digest = await globalThis.crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(payload),
    );
    return bytesToBase64(new Uint8Array(digest));
  }
  return payload;
}

export function snapshotFingerprint(snapshot: SyncSnapshot): Promise<string> {
  return payloadFingerprint(JSON.stringify(snapshot));
}

export function changedDuringUpload(
  capturedVersion: number,
  currentVersion: number,
): boolean {
  return capturedVersion !== currentVersion;
}