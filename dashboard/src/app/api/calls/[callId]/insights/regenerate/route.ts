import { type NextRequest, NextResponse } from 'next/server';
import { isAuthed } from '@/lib/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const BRAIN_URL = process.env.FASTAPI_BRAIN_URL ?? 'http://localhost:8000';

export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ callId: string }> },
) {
  if (!(await isAuthed())) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  const { callId } = await params;
  try {
    const res = await fetch(`${BRAIN_URL}/insights/generate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Internal-Secret': process.env.INTERNAL_SERVICE_SECRET ?? '',
      },
      body: JSON.stringify({ call_id: callId, regenerate: true }),
      cache: 'no-store',
    });
    const body = await res.json().catch(() => null);
    return NextResponse.json(body ?? { ok: res.ok }, { status: res.status });
  } catch (err) {
    return NextResponse.json(
      { error: 'brain_unreachable', detail: err instanceof Error ? err.message : String(err) },
      { status: 502 },
    );
  }
}
