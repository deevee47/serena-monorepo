import { describe, it, expect, mock } from 'bun:test';
import { buildApp } from '../../src/app.js';
import { config } from '../../src/config/env.js';

// Mock brain service so tests don't hit OpenAI
mock.module('../../src/services/brain.service.js', () => ({
  classifyObjection: async () => ({ objection_type: 'NEUTRAL', sentiment: 'NEUTRAL', confidence: 0.5 }),
  generateResponse: async () => ({ text: 'Test response' }),
  FALLBACK_RESPONSES: { INTRO: 'Give me just a moment.', PITCH: '...', OBJECTION: '...', NEGOTIATION: '...', CLOSE: '...', END: '...' },
}));

// Mock db service so tests don't need a real DB
mock.module('../../src/services/db.service.js', () => ({
  createCallRecord: async () => {},
  updateCallRecord: async () => {},
  insertCallTurn: async () => {},
}));

// Mock redis so tests don't need a running Redis
mock.module('../../src/lib/redis.js', () => ({
  redis: {
    get: async (_key: string) => null,
    set: async () => 'OK',
    setex: async () => 'OK',
    incr: async () => 1,
    expire: async () => 1,
    del: async () => 1,
  },
}));

const VALID_AUTH = `Bearer ${config.VAPI_WEBHOOK_SECRET}`;

function makeEvent(type: string, extra: Record<string, unknown> = {}) {
  return {
    message: {
      type,
      call: { id: 'call-test-123', customer: { number: '+15551234567' } },
      ...extra,
    },
  };
}

describe('POST /webhook', () => {
  it('returns 401 with missing auth', async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'POST', url: '/webhook', payload: makeEvent('assistant-request') });
    expect(res.statusCode).toBe(401);
  });

  it('assistant-request: creates session and returns assistantId', async () => {
    process.env['VAPI_ASSISTANT_ID'] = 'asst-123';
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/webhook',
      headers: { authorization: VALID_AUTH },
      payload: makeEvent('assistant-request'),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ assistantId: string }>();
    expect(body.assistantId).toBeDefined();
  });

  it('transcript (user final): returns {} immediately', async () => {
    const app = await buildApp();
    // First create a session
    await app.inject({
      method: 'POST',
      url: '/webhook',
      headers: { authorization: VALID_AUTH },
      payload: makeEvent('assistant-request'),
    });

    const res = await app.inject({
      method: 'POST',
      url: '/webhook',
      headers: { authorization: VALID_AUTH },
      payload: makeEvent('transcript', { role: 'user', transcriptType: 'final', transcript: 'Hello there' }),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({});
  });

  it('end-of-call-report: returns {} and cleans up', async () => {
    const app = await buildApp();
    await app.inject({
      method: 'POST',
      url: '/webhook',
      headers: { authorization: VALID_AUTH },
      payload: makeEvent('assistant-request'),
    });

    const res = await app.inject({
      method: 'POST',
      url: '/webhook',
      headers: { authorization: VALID_AUTH },
      payload: makeEvent('end-of-call-report', { durationSeconds: 120 }),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({});
  });

  it('transcript (assistant final): ignores and returns {}', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/webhook',
      headers: { authorization: VALID_AUTH },
      payload: makeEvent('transcript', { role: 'assistant', transcriptType: 'final', transcript: 'Agent reply' }),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({});
  });
});
