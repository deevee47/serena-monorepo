import { type NextRequest, NextResponse } from 'next/server';
import Redis from 'ioredis';
import { isAuthed } from '@/lib/auth';
import { getLiveSession } from '@/lib/gateway';
import { prisma } from '@/lib/prisma';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Two parallel sources feed this SSE stream:
//
//   1. A 1.5s poll of the gateway's `/debug/session/:id` (Redis) and Postgres
//      `call_turns` for persisted, eventually-consistent state (session
//      stage, finalized agent_turn, observations, tool_call annotations).
//
//   2. A Redis pub/sub subscription to `live:<callId>` for per-token events
//      the gateway emits during streaming (`text_delta`, `status: thinking`).
//      These are the chunks that make the agent text appear ChatGPT-style
//      while the brain is still generating, instead of arriving 1.5s late.
//
// LiveTail's `partialBufferRef` accumulates `text_delta` chunks and clears
// them when the poll's `agent_turn` arrives, so the user sees streaming
// text → finalized turn with no flicker.

const POLL_INTERVAL_MS = 1500;
const MAX_DURATION_MS = 10 * 60 * 1000; // 10 minutes per SSE connection
const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6379';

interface TurnRow {
  speaker: string;
  utterance: string;
  objectionType: string | null;
  sentiment: string | null;
  toolCalled: string | null;
  toolArgs: unknown;
  observationsCalled: unknown;
  // Turn-quality signals — surfaced live so chat-view chips render within one
  // poll tick of the agent / user turn landing in Postgres.
  pushAttempt: number | null;
  responseLatencyMs: number | null;
  discountOffered: number | null;
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

      // ── Redis subscriber for real-time text_delta + status events ─────
      // CRITICAL: the SUBSCRIBE call must NOT block the poll loop below.
      // We fire it in the background — if Redis is slow to handshake or the
      // connection has issues, the poll path still emits events on schedule.
      // Errors on the subscriber are swallowed (logged once) so a flaky pub/
      // sub never breaks the eventually-consistent persistence-based stream.
      const subscriber = new Redis(REDIS_URL, {
        lazyConnect: false,
        maxRetriesPerRequest: 2,
        // Don't queue commands if disconnected — fail fast instead of
        // building up a backlog of subscribe attempts we'd never deliver.
        enableOfflineQueue: false,
      });
      const channel = `live:${callId}`;
      let subscriberErrorLogged = false;
      subscriber.on('message', (_chan, raw) => {
        if (closed) return;
        try {
          // Forward verbatim — the publisher already conforms to the SSE
          // event shape LiveTail expects ({ type, ...payload, ts }).
          controller.enqueue(new TextEncoder().encode(`data: ${raw}\n\n`));
        } catch {
          /* controller closed mid-write */
        }
      });
      subscriber.on('error', (err) => {
        // Only emit ONE status event per stream — otherwise a reconnect
        // loop would spam LiveTail. Subscribe-side failures are non-fatal
        // since the 1.5s poll path keeps the conversation flowing.
        if (subscriberErrorLogged || closed) return;
        subscriberErrorLogged = true;
        try {
          controller.enqueue(
            jsonEvent({
              type: 'status',
              status: 'idle',
              error: `live_subscriber: ${err.message}`,
            }),
          );
        } catch {
          /* controller closed */
        }
      });
      // Fire subscribe in the background. If it never resolves, the poll
      // loop still feeds the stream — the user only loses real-time deltas,
      // not the conversation itself.
      void subscriber.subscribe(channel).catch(() => undefined);

      const abortHandler = () => {
        closed = true;
        void subscriber.quit().catch(() => undefined);
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
                pushAttempt: true,
                responseLatencyMs: true,
                discountOffered: true,
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
                // Replaces the legacy `stage` machine — pushAttempt is the
                // new way to read "where in the recovery ladder are we?".
                pushAttempt: session.pushAttempt ?? 0,
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
                jsonEvent({
                  type: 'user_utterance',
                  utterance: turn.utterance,
                  // Pre-response latency in ms (gap between previous AGENT
                  // TTS-finished and this USER turn arriving). Null on the
                  // first turn.
                  responseLatencyMs: turn.responseLatencyMs,
                  ts,
                }),
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
                jsonEvent({
                  type: 'agent_turn',
                  utterance: turn.utterance,
                  // Persistence-counter chip data — null for the opener and
                  // for pure clarifications that don't burn an attempt.
                  pushAttempt: turn.pushAttempt,
                  // Discount % committed to on this turn (only set when the
                  // checkout tool fired with a non-zero discount).
                  discountOffered: turn.discountOffered,
                  ts,
                }),
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
      closed = true;
      void subscriber.quit().catch(() => undefined);
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
