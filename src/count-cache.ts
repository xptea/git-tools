import type { LineCounts } from './counter.ts';

export interface CachedCount {
  sha: string;
  bytes: number;
  counts: LineCounts | null;
  used: number;
}
const LIMIT = 12_000;
const session = new Map<string, CachedCount>();
let database: Promise<IDBDatabase | undefined> | undefined;
let privateGeneration = 0;
export function privateCacheGeneration() {
  return privateGeneration;
}

function openDatabase() {
  database ??= new Promise<IDBDatabase | undefined>((resolve) => {
    if (typeof indexedDB === 'undefined') {
      resolve(undefined);
      return;
    }
    const request = indexedDB.open('git-tools-counts-v1', 1);
    request.onupgradeneeded = () => {
      const store = request.result.createObjectStore('counts', { keyPath: 'sha' });
      store.createIndex('used', 'used');
    };
    request.onsuccess = () => {
      request.result.onversionchange = () => request.result.close();
      resolve(request.result);
    };
    request.onerror = () => resolve(undefined);
    request.onblocked = () => resolve(undefined);
  });
  return database;
}

export function validCachedCount(value: unknown): value is CachedCount {
  if (!value || typeof value !== 'object') return false;
  const item = value as CachedCount;
  if (
    typeof item.sha !== 'string' ||
    !Number.isSafeInteger(item.bytes) ||
    item.bytes < 0 ||
    !Number.isFinite(item.used)
  )
    return false;
  if (item.counts === null) return true;
  const counts = item.counts;
  return (
    !!counts &&
    [counts.lines, counts.source, counts.blank].every((n) => Number.isSafeInteger(n) && n >= 0) &&
    counts.lines === counts.source + counts.blank
  );
}

/** Only public blob hashes and derived counts are persisted; no source, paths, repos, or credentials. */
export async function readCounts(
  shas: string[],
  publicRepo: boolean,
): Promise<Map<string, CachedCount>> {
  const result = new Map<string, CachedCount>();
  for (const sha of shas) {
    const item = session.get(`${publicRepo ? 'public' : 'private'}:${sha}`);
    if (item) result.set(sha, item);
  }
  if (!publicRepo) return result;
  const db = await openDatabase();
  if (!db) return result;
  await new Promise<void>((resolve) => {
    try {
      const tx = db.transaction('counts', 'readonly');
      for (const sha of new Set(shas)) {
        if (result.has(sha)) continue;
        const request = tx.objectStore('counts').get(sha);
        request.onsuccess = () => {
          if (validCachedCount(request.result) && request.result.sha === sha)
            result.set(sha, request.result);
        };
      }
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    } catch {
      resolve();
    }
  });
  return result;
}

export async function writeCounts(
  items: CachedCount[],
  publicRepo: boolean,
  generation = privateGeneration,
): Promise<void> {
  if (!publicRepo && generation !== privateGeneration) return;
  for (const item of items) {
    const key = `${publicRepo ? 'public' : 'private'}:${item.sha}`;
    session.delete(key);
    session.set(key, item);
    if (session.size > LIMIT) session.delete(session.keys().next().value!);
  }
  if (!publicRepo || !items.length) return;
  const db = await openDatabase();
  if (!db) return;
  await new Promise<void>((resolve) => {
    try {
      const tx = db.transaction('counts', 'readwrite');
      const store = tx.objectStore('counts');
      for (const item of items) store.put(item);
      const count = store.count();
      count.onsuccess = () => {
        let remove = Math.max(0, count.result - LIMIT);
        if (!remove) return;
        const cursor = store.index('used').openCursor();
        cursor.onsuccess = () => {
          if (cursor.result && remove-- > 0) {
            cursor.result.delete();
            cursor.result.continue();
          }
        };
      };
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
      tx.onabort = () => resolve();
    } catch {
      resolve();
    }
  });
}

export function clearPrivateCounts() {
  privateGeneration++;
  for (const key of session.keys()) if (key.startsWith('private:')) session.delete(key);
}
