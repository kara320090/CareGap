// Only completed public values are cached. Never share a pending D1 promise
// between Worker requests: that I/O belongs to its originating request.
const completed = new WeakMap<object, Map<string, { expires: number; value: unknown }>>();
export async function publishedRead<T>(db: object | undefined, key: string, read: () => Promise<T>, ttl = 30_000): Promise<T> {
  if (!db) return read();
  let entries = completed.get(db);
  if (!entries) completed.set(db, entries = new Map());
  const now = Date.now(), cached = entries.get(key);
  if (cached && cached.expires > now) return structuredClone(cached.value) as T;
  entries.delete(key);
  const value = await read(); // Exceptions and partial results are never cached.
  for (const [k, entry] of entries) if (entry.expires <= now) entries.delete(k);
  if (entries.size >= 64) entries.delete(entries.keys().next().value!);
  entries.set(key, { expires: Date.now() + ttl, value: structuredClone(value) });
  return value;
}
export function invalidatePublishedReads(db: object) { completed.delete(db); }
