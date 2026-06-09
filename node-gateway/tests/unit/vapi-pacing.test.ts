import { describe, it, expect } from 'bun:test';
import { ASSISTANT_PACING } from '../../src/services/voice-provider/vapi-provider.js';

// createPhoneCall() spreads ASSISTANT_PACING straight into the Vapi
// assistantOverrides, so asserting the const is asserting what PSTN calls send.
describe('VapiProvider ASSISTANT_PACING — endpointing', () => {
  it('uses smart endpointing so mid-sentence pauses do not split one turn into several', () => {
    // The bilingual agent needs the multilingual 'vapi' provider — 'livekit'
    // is English-only and would mishandle the Hindi/Hinglish pauses.
    expect(ASSISTANT_PACING.startSpeakingPlan?.smartEndpointingPlan?.provider).toBe('vapi');
  });

  it('drops the aggressive fixed silence timer that caused the premature firing', () => {
    expect(ASSISTANT_PACING).not.toHaveProperty('responseDelaySeconds');
  });
});
