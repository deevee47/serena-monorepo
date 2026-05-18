import { NextResponse, type NextRequest } from 'next/server';
import { isAuthed } from '@/lib/auth';
import { prisma } from '@/lib/prisma';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Cheap summary used by the global LiveCallsIndicator in the header. Same
// "in-flight" definition as loadActiveCalls(): endedAt null + created in the
// last 30 minutes. Returns the most-recent so a click can jump straight in.
export async function GET(_req: NextRequest) {
  if (!(await isAuthed())) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  const thirtyMinAgo = new Date(Date.now() - 30 * 60 * 1000);
  const [count, mostRecent] = await Promise.all([
    prisma.call.count({
      where: { endedAt: null, createdAt: { gte: thirtyMinAgo } },
    }),
    prisma.call.findFirst({
      where: { endedAt: null, createdAt: { gte: thirtyMinAgo } },
      orderBy: { createdAt: 'desc' },
      select: {
        callId: true,
        createdAt: true,
        phoneNumber: true,
        customer: { select: { name: true } },
      },
    }),
  ]);
  return NextResponse.json({
    count,
    mostRecent: mostRecent
      ? {
          callId: mostRecent.callId,
          createdAt: mostRecent.createdAt,
          customerName: mostRecent.customer?.name ?? null,
          phoneNumber: mostRecent.phoneNumber,
        }
      : null,
  });
}
