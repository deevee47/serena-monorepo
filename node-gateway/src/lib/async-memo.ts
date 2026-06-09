/**
 * In-process async memo for stable, expensive lookups.
 *
 * Motivating case: product "alternatives" are derived purely from the static
 * catalog via a brain → Pinecone round-trip, yet `llm.ts` recomputes them on
 * every turn and awaits them before the first spoken token. Caching by key
 * turns that into a once-per-key cost.
 *
 * Two behaviors worth knowing:
 *   - Concurrent gets for the same key share ONE in-flight compute (the promise
 *     is cached immediately), so a burst of identical lookups — e.g. several
 *     turns racing during a barge-in — collapses to a single round-trip.
 *   - A non-null result is cached until `clear()` (catalog reload). A `null`
 *     result is, by default, NOT cached — a transient upstream failure that
 *     surfaces as null must not be pinned for the process lifetime. Opt into a
 *     TTL'd negative cache via `negativeTtlMs` when "nothing here" is common,
 *     stable, and worth not re-querying every call (the TTL still lets a
 *     wrongly-cached failure self-heal).
 */
export interface AsyncMemo<T> {
  get(key: string, compute: () => Promise<T | null>): Promise<T | null>;
  clear(): void;
}

export interface AsyncMemoOptions {
  /** When > 0, a `null` result is remembered for this many ms (a TTL'd negative
   *  cache) instead of being recomputed on every call. Use only when compute()
   *  can return null for a *legitimate* "nothing here" — the TTL bounds how long
   *  a null produced by a transient failure (e.g. a circuit-breaker empty
   *  fallback) stays pinned. Default 0 → null is never cached. */
  negativeTtlMs?: number;
}

export function createAsyncMemo<T>(options: AsyncMemoOptions = {}): AsyncMemo<T> {
  const negativeTtlMs = options.negativeTtlMs ?? 0;
  // Cache the in-flight/resolved promise so concurrent gets share one compute.
  // A non-null result stays here until clear(); a null is removed (see below).
  const positive = new Map<string, Promise<T | null>>();
  // key → epoch-ms until which a cached `null` is served without recomputing.
  const negativeUntil = new Map<string, number>();

  async function get(key: string, compute: () => Promise<T | null>): Promise<T | null> {
    const negExpiry = negativeUntil.get(key);
    if (negExpiry !== undefined) {
      if (negExpiry > Date.now()) return null;
      negativeUntil.delete(key); // expired — fall through and recompute
    }

    const inflight = positive.get(key);
    if (inflight !== undefined) return inflight;

    const p = (async () => {
      const value = await compute();
      if (value === null || value === undefined) {
        // Don't keep a null in the positive cache. Optionally remember it as a
        // time-boxed negative so we don't re-query every single call.
        positive.delete(key);
        if (negativeTtlMs > 0) negativeUntil.set(key, Date.now() + negativeTtlMs);
      }
      return value;
    })().catch((err) => {
      // Never pin a thrown failure — drop it so the next call retries.
      positive.delete(key);
      throw err;
    });

    positive.set(key, p);
    return p;
  }

  function clear(): void {
    positive.clear();
    negativeUntil.clear();
  }

  return { get, clear };
}
