import { type NextRequest, NextResponse } from 'next/server';
import { isAuthed } from '@/lib/auth';
import { prisma } from '@/lib/prisma';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Serena's node-gateway exposes no dedicated `/calls/:id/end` endpoint, so
// this route closes out the call directly in Postgres (mirrors the
// mark-ended fallback) and returns OK. The Redis session will expire on its
// own once the gateway sees no more turns.
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
