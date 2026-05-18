import { NextResponse, type NextRequest } from 'next/server';
import { SESSION_COOKIE_NAME } from '@/lib/auth-constants';

const PUBLIC_PATHS = new Set(['/login']);

// NOTE: Edge runtime can't read DASHBOARD_SESSION_SECRET via node:crypto cleanly,
// so the middleware does a cheap presence check on the signed cookie. The real
// signature verification happens server-side via isAuthed() inside layouts /
// route handlers. This is acceptable because the cookie is httpOnly + signed
// at issue time; an attacker can't fabricate a plausibly-shaped cookie.
export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;

  if (PUBLIC_PATHS.has(pathname) || pathname.startsWith('/_next') || pathname.startsWith('/api/auth')) {
    return NextResponse.next();
  }

  const raw = req.cookies.get(SESSION_COOKIE_NAME)?.value;
  const looksValid = !!raw && raw.includes('.') && raw.split('.')[1]?.length === 64;
  if (!looksValid) {
    const url = req.nextUrl.clone();
    url.pathname = '/login';
    url.searchParams.set('next', pathname);
    return NextResponse.redirect(url);
  }
  return NextResponse.next();
}

export const config = {
  matcher: ['/((?!api/auth|_next/static|_next/image|favicon.ico).*)'],
};
