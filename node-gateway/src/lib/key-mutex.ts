/**
 * Per-key in-process async mutex.
 *
 * Serializes async critical sections that share a key so a concurrent
 * read-modify-write can't interleave and lose an update. The motivating case:
 * two conversation turns for the same call both GET a Redis session, mutate
 * it, and SET it back — without serialization one turn's increment (e.g.
 * pushAttempt / turnCount) clobbers the other's.
 *
 * In-process only — correct for the single-instance gateway we run today (same
 * assumption as the thinking-filler latency window). A multi-instance
 * deployment would need a Redis-based lock (SET NX / Lua); the call sites stay
 * identical, so swapping the implementation later is local to this file.
 */

// Tail of the currently-queued chain per key. The stored promise never
// rejects (see below), so the next waiter always proceeds even if a prior
// critical section threw.
const chains = new Map<string, Promise<unknown>>();

export function withKeyLock<T>(keyName: string, fn: () => Promise<T>): Promise<T> {
  const prev = chains.get(keyName) ?? Promise.resolve();

  // Run fn only after the previous critical section settles.
  const run = prev.then(() => fn());

  // The chain tail swallows rejection so one failed section doesn't poison the
  // queue. The caller still sees fn's real result/rejection via `run`.
  const tail = run.then(
    () => undefined,
    () => undefined,
  );
  chains.set(keyName, tail);

  // Best-effort cleanup: drop the map entry once this is the last waiter, so
  // the map doesn't grow unbounded across many calls/keys over time.
  void tail.then(() => {
    if (chains.get(keyName) === tail) chains.delete(keyName);
  });

  return run;
}
