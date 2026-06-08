import { NextResponse, type NextRequest } from 'next/server';
import { passwordMatches, signIn, signOut } from '@/lib/auth';

export const runtime = 'nodejs';

// Behind a reverse proxy (Traefik/Coolify) `req.url`'s host is the container's
// internal `localhost:4000`, so an absolute redirect built from it sends the
// browser there. A *relative* Location header is resolved by the browser
// against the real request origin, so it always lands on the public domain.
function redirectTo(path: string) {
  return new NextResponse(null, { status: 303, headers: { Location: path } });
}

export async function POST(req: NextRequest) {
  const form = await req.formData();
  const action = form.get('action')?.toString();

  if (action === 'logout') {
    await signOut();
    return redirectTo('/login');
  }

  const password = form.get('password')?.toString() ?? '';
  if (!passwordMatches(password)) {
    return redirectTo('/login?error=1');
  }
  await signIn();
  const next = form.get('next')?.toString();
  // Only same-origin, non-protocol-relative paths (guards against open redirect).
  const safeNext = next && next.startsWith('/') && !next.startsWith('//') ? next : '/';
  return redirectTo(safeNext);
}
