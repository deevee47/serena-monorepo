import { describe, it, expect } from 'bun:test';
import { createAsyncMemo } from '../../src/lib/async-memo.js';

describe('createAsyncMemo', () => {
  it('computes once per key and serves the cached value thereafter', async () => {
    const memo = createAsyncMemo<string>();
    let calls = 0;
    const compute = async () => {
      calls++;
      return 'value';
    };

    const a = await memo.get('k', compute);
    const b = await memo.get('k', compute);

    expect(a).toBe('value');
    expect(b).toBe('value');
    expect(calls).toBe(1);
  });

  it('does NOT cache a null result (so a transient miss/failure can retry)', async () => {
    const memo = createAsyncMemo<string>();
    let calls = 0;
    const computeNull = async () => {
      calls++;
      return null;
    };

    await memo.get('k', computeNull);
    await memo.get('k', computeNull);

    expect(calls).toBe(2);
  });

  it('keys results independently', async () => {
    const memo = createAsyncMemo<string>();
    const a = await memo.get('a', async () => 'A');
    const b = await memo.get('b', async () => 'B');
    expect(a).toBe('A');
    expect(b).toBe('B');
  });

  it('clear() drops cached values so the next get recomputes', async () => {
    const memo = createAsyncMemo<string>();
    let calls = 0;
    const compute = async () => {
      calls++;
      return 'v';
    };

    await memo.get('k', compute);
    memo.clear();
    await memo.get('k', compute);

    expect(calls).toBe(2);
  });
});
