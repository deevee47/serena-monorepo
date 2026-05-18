import { type NextRequest, NextResponse } from 'next/server';
import { isAuthed } from '@/lib/auth';
import { getLiveSession } from '@/lib/gateway';
import { prisma } from '@/lib/prisma';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Serena's node-gateway has no native SSE endpoint, so the dashboard derives
// the live event stream by polling the gateway's Redis-backed
// `/debug/session/:id` and the Postgres `call_turns` table every ~1.5s and
// emitting deltas as SSE messages. The live-tail client treats each
// `data: { type: ... }` frame the same way it would handle a server-pushed
// event from the gateway.

const POLL_INTERVAL_MS = 1500;
const MAX_DURATION_MS = 10 * 60 * 1000; // 10 minutes per SSE connection

interface TurnRow {
  speaker: string;
  utterance: string;
  objectionType: string | null;
  sentiment: string | null;
  toolCalled: string | null;
  toolArgs: unknown;
  observationsCalled: unknown;
  turnNumber: number;
  createdAt: Date;
}

function jsonEvent(payload: Record<string, unknown>): Uint8Array {
  return new TextEncoder().encode(`data: ${JSON.stringify(payload)}\n\n`);
}

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ callId: string }> },
) {
  if (!(await isAuthed())) {
    return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  }
  const { callId } = await params;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const startedAt = Date.now();
      let lastTurnNumber = -1;
      let sessionAnnounced = false;
      let closed = false;
      const abortHandler = () => {
        closed = true;
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      };
      req.signal.addEventListener('abort', abortHandler);

      controller.enqueue(jsonEvent({ type: 'hello' }));

      while (!closed) {
        if (Date.now() - startedAt > MAX_DURATION_MS) {
          controller.enqueue(jsonEvent({ type: 'call_ended', reason: 'sse_max_duration' }));
          break;
        }

        try {
          const [session, turns, call] = await Promise.all([
            getLiveSession(callId),
            prisma.callTurn.findMany({
              where: { callId, turnNumber: { gt: lastTurnNumber } },
              orderBy: { turnNumber: 'asc' },
              select: {
                speaker: true,
                utterance: true,
                objectionType: true,
                sentiment: true,
                toolCalled: true,
                toolArgs: true,
                observationsCalled: true,
                turnNumber: true,
                createdAt: true,
              },
            }) as unknown as Promise<TurnRow[]>,
            prisma.call.findUnique({
              where: { callId },
              select: { endedAt: true, productId: true },
            }),
          ]);

          if (!sessionAnnounced && session) {
            controller.enqueue(
              jsonEvent({
                type: 'session_init',
                selectedPlanId: session.currentProductId ?? call?.productId ?? null,
                callMode: 'OUTBOUND_RECOVERY',
                stage: session.stage ?? 'INTRO',
                couponsApplied: (session.discountsOffered ?? []).map((n) => `−${n}%`),
                ts: new Date().toISOString(),
              }),
            );
            sessionAnnounced = true;
          }

          for (const turn of turns) {
            lastTurnNumber = turn.turnNumber;
            const ts = turn.createdAt.toISOString();
            if (turn.speaker === 'USER') {
              controller.enqueue(
                jsonEvent({ type: 'user_utterance', utterance: turn.utterance, ts }),
              );
              if (turn.objectionType || turn.sentiment) {
                controller.enqueue(
                  jsonEvent({
                    type: 'classified',
                    callTurnId: String(turn.turnNumber),
                    utterance: turn.utterance,
                    objectionType: turn.objectionType ?? 'UNKNOWN',
                    subtype: null,
                    sentiment: turn.sentiment ?? 'NEUTRAL',
                    ts,
                  }),
                );
              }
            } else {
              if (
                turn.observationsCalled &&
                Array.isArray(turn.observationsCalled)
              ) {
                for (const obs of turn.observationsCalled) {
                  if (obs && typeof obs === 'object') {
                    const o = obs as { name?: string; args?: Record<string, unknown>; result?: unknown };
                    controller.enqueue(
                      jsonEvent({
                        type: 'observation',
                        name: o.name ?? 'observation',
                        args: o.args ?? {},
                        result: o.result ?? null,
                        ts,
                      }),
                    );
                  }
                }
              }
              if (turn.toolCalled) {
                controller.enqueue(
                  jsonEvent({
                    type: 'tool_call',
                    name: turn.toolCalled,
                    args: (turn.toolArgs as Record<string, unknown> | null) ?? {},
                    ts,
                  }),
                );
              }
              controller.enqueue(
                jsonEvent({ type: 'agent_turn', utterance: turn.utterance, ts }),
              );
              controller.enqueue(jsonEvent({ type: 'turn_done', ts }));
            }
          }

          if (call?.endedAt) {
            controller.enqueue(
              jsonEvent({ type: 'call_ended', ts: call.endedAt.toISOString() }),
            );
            break;
          }
        } catch (err) {
          // Don't tear down the stream on transient errors — keep polling.
          controller.enqueue(
            jsonEvent({
              type: 'status',
              status: 'idle',
              error: err instanceof Error ? err.message : 'poll_failed',
            }),
          );
        }

        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
      }

      req.signal.removeEventListener('abort', abortHandler);
      try {
        controller.close();
      } catch {
        /* already closed */
      }
    },
  });

  return new Response(stream, {
    status: 200,
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    },
  });
}
