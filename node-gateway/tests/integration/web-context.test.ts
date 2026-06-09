import { describe, it, expect, mock } from 'bun:test';
import { config as realConfig } from '../../src/config/env.js';

mock.module('../../src/config/env.js', () => ({
  config: { ...realConfig, VOICE_PROVIDER: 'vapi' },
}));

const config = { ...realConfig, VOICE_PROVIDER: 'vapi' as const };

// The /calls/web-context endpoint touches only redis (pending_call write +
// getSession), so redis is the only collaborator that needs mocking — the
// brain/DB are never reached on this path. Capture pending_call writes; `get`
// returns null so getSession() finds no live session to patch (the normal
// create-time path).
const setexCalls: Array<{ key: string; ttl: number; value: string }> = [];
mock.module('../../src/lib/redis.js', () => ({
  redis: {
    get: async () => null,
    set: async () => 'OK',
    setex: async (key: string, ttl: number, value: string) => {
      setexCalls.push({ key, ttl, value });
      return 'OK';
    },
    incr: async () => 1,
    expire: async () => 1,
    del: async () => 1,
    ping: async () => 'PONG',
  },
}));

const { buildApp } = await import('../../src/app.js');

const ADMIN = { 'x-admin-secret': config.ADMIN_SECRET, 'content-type': 'application/json' };

describe('POST /calls/web-context', () => {
  it('rejects without the admin secret', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/calls/web-context',
      payload: { call_id: 'call-web-1', product_id: 'prod-xyz' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('writes a pending_call binding for the selected product', async () => {
    setexCalls.length = 0;
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/calls/web-context',
      headers: ADMIN,
      payload: { call_id: 'call-web-1', product_id: 'prod-egg-white' },
    });
    expect(res.statusCode).toBe(204);

    const pending = setexCalls.find((c) => c.key === 'pending_call:call-web-1');
    expect(pending).toBeDefined();
    expect(pending!.ttl).toBe(60);
    expect(JSON.parse(pending!.value)).toEqual({
      productId: 'prod-egg-white',
      triggerReason: 'web_talk',
    });
  });

  it('is a no-op (no binding) for a product-agnostic inbound web call', async () => {
    setexCalls.length = 0;
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/calls/web-context',
      headers: ADMIN,
      payload: { call_id: 'call-web-2', product_id: null },
    });
    expect(res.statusCode).toBe(204);
    expect(setexCalls.find((c) => c.key.startsWith('pending_call:'))).toBeUndefined();
  });
});
