import { NextResponse, type NextRequest } from 'next/server';
import { passwordMatches, signIn, signOut } from '@/lib/auth';

export const runtime = 'nodejs';

export async function POST(req: NextRequest) {
  const form = await req.formData();
  const action = form.get('action')?.toString();

  if (action === 'logout') {
    await signOut();
    return NextResponse.redirect(new URL('/login', req.url), { status: 303 });
  }

  const password = form.get('password')?.toString() ?? '';
  if (!passwordMatches(password)) {
    const url = new URL('/login', req.url);
    url.searchParams.set('error', '1');
    return NextResponse.redirect(url, { status: 303 });
  }
  await signIn();
  const next = form.get('next')?.toString();
  return NextResponse.redirect(new URL(next && next.startsWith('/') ? next : '/', req.url), {
    status: 303,
  });
}
