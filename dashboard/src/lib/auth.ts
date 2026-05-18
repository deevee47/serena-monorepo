import { createHmac, timingSafeEqual } from 'node:crypto';
import { cookies } from 'next/headers';
import { SESSION_COOKIE_NAME, SESSION_MAX_AGE_S } from './auth-constants';

const COOKIE_NAME = SESSION_COOKIE_NAME;
const COOKIE_MAX_AGE_S = SESSION_MAX_AGE_S;

function getSecret(): string {
  const secret = process.env.DASHBOARD_SESSION_SECRET;
  if (!secret || secret.length < 16) {
    throw new Error(
      'DASHBOARD_SESSION_SECRET is missing or too short (need >= 16 chars).',
    );
  }
  return secret;
}

function signed(value: string): string {
  const sig = createHmac('sha256', getSecret()).update(value).digest('hex');
  return `${value}.${sig}`;
}

function verifySigned(raw: string | undefined): string | null {
  if (!raw) return null;
  const idx = raw.lastIndexOf('.');
  if (idx <= 0) return null;
  const value = raw.slice(0, idx);
  const sig = raw.slice(idx + 1);
  const expected = createHmac('sha256', getSecret()).update(value).digest('hex');
  const a = Buffer.from(sig, 'hex');
  const b = Buffer.from(expected, 'hex');
  if (a.length !== b.length) return null;
  return timingSafeEqual(a, b) ? value : null;
}

export function passwordMatches(input: string): boolean {
  const expected = process.env.DASHBOARD_PASSWORD ?? '';
  if (!expected) return false;
  const a = Buffer.from(input);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export async function signIn(): Promise<void> {
  const issuedAt = Date.now().toString();
  const cookieStore = await cookies();
  cookieStore.set(COOKIE_NAME, signed(issuedAt), {
    httpOnly: true,
    secure: process.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/',
    maxAge: COOKIE_MAX_AGE_S,
  });
}

export async function signOut(): Promise<void> {
  const cookieStore = await cookies();
  cookieStore.delete(COOKIE_NAME);
}

export async function isAuthed(): Promise<boolean> {
  const cookieStore = await cookies();
  const raw = cookieStore.get(COOKIE_NAME)?.value;
  return verifySigned(raw) !== null;
}

export { SESSION_COOKIE_NAME };
export { verifySigned as verifySignedSession };
