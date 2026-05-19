import { describe, it, expect } from 'bun:test';
import { TelnyxProvider } from '../../src/services/voice-provider/telnyx-provider.js';

const provider = new TelnyxProvider();
const RAW = Buffer.from('{}'); // not inspected by parseWebhook

function envelope(eventType: string, payload: Record<string, unknown>) {
  return { data: { event_type: eventType, payload } };
}

function clientState(obj: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(obj), 'utf8').toString('base64');
}

describe('TelnyxProvider.parseWebhook', () => {
  it('maps call.initiated to call.started with decoded client_state metadata', () => {
    const events = provider.parseWebhook(
      RAW,
      envelope('call.initiated', {
        call_control_id: 'v3:abc',
        from: '+15551234567',
        client_state: clientState({ product_id: 'prod-001', trigger_reason: 'manual' }),
      }),
    );
    expect(events).toHaveLength(1);
    const e = events[0]!;
    expect(e.kind).toBe('call.started');
    if (e.kind === 'call.started') {
      expect(e.callId).toBe('v3:abc');
      expect(e.phoneNumber).toBe('+15551234567');
      expect(e.metadata['product_id']).toBe('prod-001');
      expect(e.respondWithAssistantId).toBeNull();
    }
  });

  it('maps call.answered to call.started too', () => {
    const events = provider.parseWebhook(
      RAW,
      envelope('call.answered', { call_control_id: 'v3:xyz', from: '+15550000000' }),
    );
    expect(events).toHaveLength(1);
    expect(events[0]!.kind).toBe('call.started');
  });

  it('maps call.hangup to call.ended with computed duration', () => {
    const events = provider.parseWebhook(
      RAW,
      envelope('call.hangup', {
        call_control_id: 'v3:abc',
        hangup_cause: 'normal_clearing',
        start_time: '2026-01-01T00:00:00Z',
        end_time: '2026-01-01T00:02:30Z',
      }),
    );
    expect(events).toHaveLength(1);
    const e = events[0]!;
    expect(e.kind).toBe('call.ended');
    if (e.kind === 'call.ended') {
      expect(e.callId).toBe('v3:abc');
      expect(e.durationSeconds).toBe(150);
      expect(e.endedReason).toBe('normal_clearing');
    }
  });

  it('maps call.recording.saved to recording.ready with mp3/wav URLs', () => {
    const events = provider.parseWebhook(
      RAW,
      envelope('call.recording.saved', {
        call_control_id: 'v3:abc',
        recording_id: 'rec-123',
        recording_urls: { mp3: 'https://r.telnyx/x.mp3', wav: 'https://r.telnyx/x.wav' },
      }),
    );
    expect(events).toHaveLength(1);
    const e = events[0]!;
    expect(e.kind).toBe('recording.ready');
    if (e.kind === 'recording.ready') {
      expect(e.callId).toBe('v3:abc');
      expect(e.recordingId).toBe('rec-123');
      expect(e.recordingUrl).toBe('https://r.telnyx/x.mp3');
      expect(e.stereoRecordingUrl).toBe('https://r.telnyx/x.wav');
    }
  });

  it('falls back to public_recording_urls when recording_urls is absent', () => {
    const events = provider.parseWebhook(
      RAW,
      envelope('call.recording.saved', {
        call_control_id: 'v3:abc',
        recording_id: 'rec-9',
        public_recording_urls: { mp3: 'https://p.telnyx/y.mp3' },
      }),
    );
    const e = events[0]!;
    if (e.kind === 'recording.ready') {
      expect(e.recordingUrl).toBe('https://p.telnyx/y.mp3');
      expect(e.stereoRecordingUrl).toBeNull();
    }
  });

  it('returns empty for unknown event types', () => {
    expect(
      provider.parseWebhook(RAW, envelope('call.machine.greeting.ended', { call_control_id: 'x' })),
    ).toEqual([]);
  });

  it('returns empty when call_control_id is missing', () => {
    expect(provider.parseWebhook(RAW, envelope('call.initiated', {}))).toEqual([]);
  });

  it('handles malformed envelopes gracefully', () => {
    expect(provider.parseWebhook(RAW, null)).toEqual([]);
    expect(provider.parseWebhook(RAW, { data: {} })).toEqual([]);
  });

  it('tolerates malformed client_state (returns empty metadata)', () => {
    const events = provider.parseWebhook(
      RAW,
      envelope('call.initiated', {
        call_control_id: 'v3:abc',
        client_state: 'not-base64-json!',
      }),
    );
    const e = events[0]!;
    if (e.kind === 'call.started') {
      expect(e.metadata).toEqual({});
    }
  });
});
