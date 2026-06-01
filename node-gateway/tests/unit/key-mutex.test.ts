import { describe, it, expect } from 'bun:test';
import { withKeyLock } from '../../src/lib/key-mutex.js';

describe('withKeyLock', () => {
  it('serializes critical sections on the same key (no lost updates)', async () => {
    // A deliberate async read-modify-write gap: without serialization,
    // concurrent runners all read the same value and overwrite each other.
    let value = 0;
    const incrementWithGap = async () => {
      const read = value;
      await new Promise((r) => setTimeout(r, 1));
      value = read + 1;
    };

    await Promise.all(
      Array.from({ length: 50 }, () => withKeyLock('call-1', incrementWithGap)),
    );

    // Serialized → every increment lands. (Unlocked, this would be far < 50.)
    expect(value).toBe(50);
  });

  it('runs different keys concurrently (not serialized against each other)', async () => {
    const order: string[] = [];
    const slow = async () => {
      await new Promise((r) => setTimeout(r, 20));
      order.push('slow');
    };
    const fast = async () => {
      order.push('fast');
    };

    await Promise.all([withKeyLock('a', slow), withKeyLock('b', fast)]);

    // 'b' is independent of 'a', so the fast section finishes first.
    expect(order).toEqual(['fast', 'slow']);
  });

  it('does not let a throwing critical section block the next on the same key', async () => {
    const ran: string[] = [];
    const boom = withKeyLock('call-2', async () => {
      throw new Error('boom');
    });
    await expect(boom).rejects.toThrow('boom');

    await withKeyLock('call-2', async () => {
      ran.push('ran');
    });
    expect(ran).toEqual(['ran']);
  });

  it('returns the critical section result to the caller', async () => {
    const out = await withKeyLock('call-3', async () => 42);
    expect(out).toBe(42);
  });
});
