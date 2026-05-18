import { NextResponse, type NextRequest } from 'next/server';
import { isAuthed } from '@/lib/auth';
import { getLiveSession } from '@/lib/gateway';
import { prisma } from '@/lib/prisma';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ callId: string }> },
) {
  if (!(await isAuthed())) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  const { callId } = await params;

  const [session, dbTurns, call] = await Promise.all([
    getLiveSession(callId),
    prisma.callTurn.findMany({
      where: { callId },
      orderBy: { turnNumber: 'asc' },
      select: {
        speaker: true,
        utterance: true,
        objectionType: true,
        sentiment: true,
        toolCalled: true,
        toolArgs: true,
        observationsCalled: true,
        createdAt: true,
      },
    }),
    prisma.call.findUnique({
      where: { callId },
      select: {
        outcome: true,
        endedAt: true,
        durationSeconds: true,
        productId: true,
        discountGiven: true,
        phoneNumber: true,
        customer: { select: { name: true } },
      },
    }),
  ]);

  const explicitlyEnded = call?.endedAt != null;
  const sessionInactive = session?.isActive === false;
  const isActive = !explicitlyEnded && !sessionInactive;

  return NextResponse.json({
    callId,
    isActive,
    session,
    persisted: {
      outcome: call?.outcome ?? null,
      endedAt: call?.endedAt ?? null,
      durationSeconds: call?.durationSeconds ?? null,
      selectedPlanId: call?.productId ?? null,
      couponApplied: call?.discountGiven && call.discountGiven > 0 ? `−${call.discountGiven}%` : null,
      phoneNumber: call?.phoneNumber ?? null,
      customerName: call?.customer?.name ?? null,
      turns: dbTurns,
    },
  });
}
