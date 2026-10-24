import { SYNC_LOCAL_DATABASE } from "./syncPolicy.ts";

type LocalStore = "keys" | "base";
const STORES: LocalStore[] = ["keys", "base"];

function openLocalState(): Promise<IDBDatabase | null> {
  const factory = globalThis.indexedDB;
  if (!factory) return Promise.resolve(null);
  return new Promise((resolve) => {
    let request: IDBOpenDBRequest;
    try {
      request = factory.open(SYNC_LOCAL_DATABASE, 1);
    } catch {
      resolve(null);
      return;
    }
    request.onupgradeneeded = () => {
      for (const store of STORES) {
        if (!request.result.objectStoreNames.contains(store)) {
          request.result.createObjectStore(store);
        }
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
    request.onblocked = () => resolve(null);
  });
}

async function withStore<T>(
  store: LocalStore,
  mode: IDBTransactionMode,
  run: (objectStore: IDBObjectStore) => IDBRequest | null,
): Promise<T | null> {
  const database = await openLocalState();
  if (!database) return null;
  try {
    return await new Promise<T | null>((resolve) => {
      const transaction = database.transaction(store, mode);
      const request = run(transaction.objectStore(store));
      transaction.oncomplete = () =>
        resolve(request ? ((request.result as T | undefined) ?? null) : null);
      transaction.onerror = () => resolve(null);
      transaction.onabort = () => resolve(null);
    });
  } catch {
    return null;
  } finally {
    database.close();
  }
}

export function readLocalState<T>(
  store: LocalStore,
  key: string,
): Promise<T | null> {
  return withStore<T>(store, "readonly", (objectStore) =>
    objectStore.get(key),
  );
}

export async function writeLocalState(
  store: LocalStore,
  key: string,
  value: unknown,
): Promise<void> {
  await withStore(store, "readwrite", (objectStore) =>
    objectStore.put(value, key),
  );
}

export async function deleteLocalState(
  store: LocalStore,
  key: string,
): Promise<void> {
  await withStore(store, "readwrite", (objectStore) =>
    objectStore.delete(key),
  );
}
