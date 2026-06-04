import { describe, it, expect } from 'bun:test';
import { VapiProvider } from '../../src/services/voice-provider/vapi-provider.js';

const provider = new VapiProvider();
const RAW = Buffer.from('{}'); // not inspected by parseWebhook

function speechUpdate(role: 'user' | 'assistant', status: 'started' | 'stopped', timestamp?: number) {
  return {
    message: {
      type: 'speech-update',
      timestamp,
      status,
      role,
      call: { id: 'call-vapi-1' },
    },
  };
}

describe('VapiProvider.parseWebhook — speech-update', () => {
  it('maps assistant-stopped to a speech.boundary event with the provider timestamp', () => {
    const events = provider.parseWebhook(RAW, speechUpdate('assistant', 'stopped', 1700000000000));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: 'speech.boundary',
      callId: 'call-vapi-1',
      role: 'assistant',
      status: 'stopped',
      atMs: 1700000000000,
    });
  });

  it('maps user-started to a speech.boundary event', () => {
    const events = provider.parseWebhook(RAW, speechUpdate('user', 'started', 1700000005000));
    expect(events[0]).toMatchObject({
      kind: 'speech.boundary',
      role: 'user',
      status: 'started',
      atMs: 1700000005000,
    });
  });

  it('emits atMs=null when the provider omits the timestamp (handler falls back to receipt time)', () => {
    const events = provider.parseWebhook(RAW, speechUpdate('user', 'started'));
    expect(events[0]).toMatchObject({ kind: 'speech.boundary', atMs: null });
  });

  it('ignores a speech-update with no call id', () => {
    const events = provider.parseWebhook(RAW, {
      message: { type: 'speech-update', status: 'started', role: 'user', call: {} },
    });
    expect(events).toEqual([]);
  });
});
