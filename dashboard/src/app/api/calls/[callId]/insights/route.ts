import { type NextRequest, NextResponse } from 'next/server';
import { isAuthed } from '@/lib/auth';
import { prisma } from '@/lib/prisma';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const BRAIN_URL = process.env.FASTAPI_BRAIN_URL ?? 'http://localhost:8000';

/** How long a `PENDING` insight row can sit before we treat it as stuck.
 *  Real generations finish in 5-15s; anything older than this almost
 *  always means the brain crashed mid-OpenAI-call (or got SIGTERM'd by a
 *  dev-server restart) and the row never advanced to READY/FAILED. */
const PENDING_STALE_MS = 90_000; // 90 seconds

/** Fire-and-forget brain call. We don't await — the client polls this
 *  same endpoint until status flips to READY. `regenerate=true` skips the
 *  brain's "existing READY row" early-return, letting us heal stuck
 *  PENDING rows by re-running the full flow. */
function triggerGeneration(callId: string, regenerate = false) {
  fetch(`${BRAIN_URL}/insights/generate`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Internal-Secret': process.env.INTERNAL_SERVICE_SECRET ?? '',
    },
    body: JSON.stringify({ call_id: callId, regenerate }),
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

  // Auto-recover stuck PENDING rows. A real PENDING window is 5-15s; if the
  // row has been PENDING for more than ~90s the previous brain run almost
  // certainly died (OpenAI timeout, brain restart mid-flight, etc.). Refire
  // with regenerate=true so the brain runs the full path and writes a
  // terminal status. The next 4s client poll will pick up the new state.
  if (insight.status === 'PENDING') {
    const ageMs = Date.now() - new Date(insight.generatedAt).getTime();
    if (ageMs > PENDING_STALE_MS) {
      triggerGeneration(callId, true);
    }
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
