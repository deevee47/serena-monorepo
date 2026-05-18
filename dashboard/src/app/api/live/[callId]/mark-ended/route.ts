import { type NextRequest, NextResponse } from 'next/server';
import { isAuthed } from '@/lib/auth';
import { prisma } from '@/lib/prisma';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Called by the dashboard's live-tail client when its SSE stream receives
 * a `call_ended` event. Marks the Postgres call row as ended so the Live
 * page stops listing it, even when Vapi's `end-of-call-report` webhook
 * never fires (e.g. mis-configured Server URL).
 *
 * Idempotent: if the row is already ended, it's a no-op.
 */
export async function POST(
  _req: NextRequest,
  { params }: { params: Promise<{ callId: string }> },
) {
  if (!(await isAuthed())) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  const { callId } = await params;

  const call = await prisma.call.findUnique({
    where: { callId },
    select: { id: true, endedAt: true, createdAt: true },
  });
  if (!call) {
    return NextResponse.json({ error: 'call_not_found' }, { status: 404 });
  }
  if (call.endedAt) {
    return NextResponse.json({ ok: true, alreadyEnded: true });
  }

  // Outcome: CONVERTED if a checkout-link tool fired during the call.
  const checkout = await prisma.callTurn.findFirst({
    where: { callId, toolCalled: 'send_whatsapp_checkout_link' },
    select: { id: true },
  });

  const endedAt = new Date();
  const durationSeconds = Math.max(
    0,
    Math.floor((endedAt.getTime() - call.createdAt.getTime()) / 1000),
  );

  await prisma.call.update({
    where: { id: call.id },
    data: {
      endedAt,
      durationSeconds,
      outcome: checkout ? 'CONVERTED' : 'DROPPED',
    },
  });

  return NextResponse.json({ ok: true });
}
