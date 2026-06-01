/**
 * In-process async memo for stable, expensive lookups.
 *
 * Motivating case: product "alternatives" are derived purely from the static
 * catalog via a brain → Pinecone round-trip, yet `llm.ts` recomputes them on
 * every turn and awaits them before the first spoken token. Caching by key
 * turns that into a once-per-key cost.
 *
 * Only NON-null results are cached — a transient upstream failure (e.g. the
 * brain breaker returning an empty fallback) must not be pinned for the
 * process lifetime. Call `clear()` when the underlying data changes (catalog
 * reload).
 */
export interface AsyncMemo<T> {
  get(key: string, compute: () => Promise<T | null>): Promise<T | null>;
  clear(): void;
}

export function createAsyncMemo<T>(): AsyncMemo<T> {
  const cache = new Map<string, T>();

  async function get(key: string, compute: () => Promise<T | null>): Promise<T | null> {
    const hit = cache.get(key);
    if (hit !== undefined) return hit;
    const value = await compute();
    if (value !== null && value !== undefined) cache.set(key, value);
    return value;
  }

  function clear(): void {
    cache.clear();
  }

  return { get, clear };
}
