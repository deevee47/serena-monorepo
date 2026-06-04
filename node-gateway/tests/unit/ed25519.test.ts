import { describe, it, expect } from 'bun:test';
import nacl from 'tweetnacl';
import { verifyTelnyxSignature } from '../../src/services/voice-provider/ed25519.js';

function makeFixture(body: string, ts: number, keypair = nacl.sign.keyPair()) {
  const message = Buffer.concat([Buffer.from(`${ts}|`), Buffer.from(body, 'utf8')]);
  const signature = nacl.sign.detached(message, keypair.secretKey);
  return {
    rawBody: Buffer.from(body, 'utf8'),
    signatureBase64: Buffer.from(signature).toString('base64'),
    timestampHeader: String(ts),
    publicKeyBase64: Buffer.from(keypair.publicKey).toString('base64'),
    now: ts, // pin clock so tolerance check passes
  };
}

describe('verifyTelnyxSignature', () => {
  it('accepts a freshly-signed payload', () => {
    const fx = makeFixture('{"data":{"event_type":"call.initiated"}}', 1_700_000_000);
    expect(verifyTelnyxSignature(fx)).toEqual({ ok: true });
  });

  it('rejects a payload with a wrong signature', () => {
    const fx = makeFixture('{"a":1}', 1_700_000_000);
    fx.signatureBase64 = Buffer.from(new Uint8Array(64)).toString('base64');
    const res = verifyTelnyxSignature(fx);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('signature_mismatch');
  });

  it('rejects when timestamp is out of window', () => {
    const fx = makeFixture('{}', 1_700_000_000);
    fx.now = 1_700_000_000 + 600; // 10 min skew, tolerance is 5 min
    const res = verifyTelnyxSignature(fx);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('timestamp_out_of_window');
  });

  it('rejects when headers are missing', () => {
    const res = verifyTelnyxSignature({
      rawBody: Buffer.from('{}'),
      signatureBase64: undefined,
      timestampHeader: undefined,
      publicKeyBase64: Buffer.from(new Uint8Array(32)).toString('base64'),
    });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('missing_signature_headers');
  });

  it('rejects when timestamp is not a number', () => {
    const fx = makeFixture('{}', 1_700_000_000);
    fx.timestampHeader = 'not-a-number';
    const res = verifyTelnyxSignature(fx);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('invalid_timestamp');
  });

  it('rejects when the public key is the wrong length', () => {
    const fx = makeFixture('{}', 1_700_000_000);
    fx.publicKeyBase64 = Buffer.from(new Uint8Array(16)).toString('base64');
    const res = verifyTelnyxSignature(fx);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('invalid_public_key_length');
  });

  it('rejects when the body is tampered with after signing', () => {
    const fx = makeFixture('{"a":1}', 1_700_000_000);
    fx.rawBody = Buffer.from('{"a":2}'); // change after signing
    const res = verifyTelnyxSignature(fx);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe('signature_mismatch');
  });
});
