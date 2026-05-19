import nacl from 'tweetnacl';

/** Max clock skew between Telnyx's signing timestamp and ours. */
const TIMESTAMP_TOLERANCE_SECONDS = 300;

export type VerifyResult = { ok: true } | { ok: false; reason: string };

/**
 * Verify a Telnyx-style Ed25519 webhook signature.
 *
 *   signed_payload = `${timestamp}|${rawBodyUtf8}`
 *   signature      = base64(sign(privateKey, signed_payload))
 *
 * The public key Telnyx publishes is a raw 32-byte Ed25519 key, base64-encoded
 * (not SPKI-wrapped). `tweetnacl.sign.detached.verify` consumes raw bytes, so
 * no DER unwrapping is needed.
 *
 * Rejects out-of-window timestamps (±5min) to prevent replay attacks.
 */
export function verifyTelnyxSignature(params: {
  rawBody: Buffer;
  signatureBase64: string | undefined;
  timestampHeader: string | undefined;
  publicKeyBase64: string;
  now?: number;
}): VerifyResult {
  const { rawBody, signatureBase64, timestampHeader, publicKeyBase64 } = params;
  const now = params.now ?? Math.floor(Date.now() / 1000);

  if (!signatureBase64 || !timestampHeader) {
    return { ok: false, reason: 'missing_signature_headers' };
  }

  const timestamp = Number.parseInt(timestampHeader, 10);
  if (!Number.isFinite(timestamp)) {
    return { ok: false, reason: 'invalid_timestamp' };
  }
  if (Math.abs(now - timestamp) > TIMESTAMP_TOLERANCE_SECONDS) {
    return { ok: false, reason: 'timestamp_out_of_window' };
  }

  let signature: Uint8Array;
  let publicKey: Uint8Array;
  try {
    signature = Buffer.from(signatureBase64, 'base64');
    publicKey = Buffer.from(publicKeyBase64, 'base64');
  } catch {
    return { ok: false, reason: 'malformed_base64' };
  }

  if (publicKey.length !== 32) {
    return { ok: false, reason: 'invalid_public_key_length' };
  }
  if (signature.length !== 64) {
    return { ok: false, reason: 'invalid_signature_length' };
  }

  const message = Buffer.concat([Buffer.from(`${timestamp}|`), rawBody]);

  const ok = nacl.sign.detached.verify(message, signature, publicKey);
  return ok ? { ok: true } : { ok: false, reason: 'signature_mismatch' };
}
