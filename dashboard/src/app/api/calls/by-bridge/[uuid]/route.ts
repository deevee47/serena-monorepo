import { NextResponse, type NextRequest } from 'next/server';
import { isAuthed } from '@/lib/auth';
import { getCallByBridge } from '@/lib/gateway';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ uuid: string }> },
) {
  if (!(await isAuthed())) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  const { uuid } = await params;
  const callId = await getCallByBridge(uuid);
  if (!callId) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }
  return NextResponse.json({ call_id: callId });
}
