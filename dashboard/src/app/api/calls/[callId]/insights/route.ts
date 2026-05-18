import { type NextRequest, NextResponse } from 'next/server';
import { isAuthed } from '@/lib/auth';
import { prisma } from '@/lib/prisma';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const BRAIN_URL = process.env.FASTAPI_BRAIN_URL ?? 'http://localhost:8000';

// Fire-and-forget brain call. We don't await — the client polls this same
// endpoint until status flips to READY.
function triggerGeneration(callId: string) {
  fetch(`${BRAIN_URL}/insights/generate`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Internal-Secret': process.env.INTERNAL_SERVICE_SECRET ?? '',
    },
    body: JSON.stringify({ call_id: callId, regenerate: false }),
    cache: 'no-store',
  }).catch(() => undefined);
}

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ callId: string }> },
) {
  if (!(await isAuthed())) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  const { callId } = await params;
  const insight = await prisma.callInsight.findUnique({ where: { callId } });

  // No row yet — only fire generation if the call has actually ended,
  // otherwise we'd burn LLM tokens summarizing a one-turn call.
  if (!insight) {
    const call = await prisma.call.findUnique({
      where: { callId },
      select: { endedAt: true },
    });
    if (call?.endedAt) triggerGeneration(callId);
    return NextResponse.json({ status: 'MISSING' }, { status: 200 });
  }

  return NextResponse.json({
    status: insight.status,
    summary: insight.summary,
    overallSentiment: insight.overallSentiment,
    emotions: insight.emotions,
    sentimentTrend: insight.sentimentTrend,
    sentimentConfidence: insight.sentimentConfidence,
    serviceConcerns: insight.serviceConcerns,
    tags: insight.tags,
    fallbackUsed: insight.fallbackUsed,
    errorMessage: insight.errorMessage,
    generatedAt: insight.generatedAt,
  });
}
