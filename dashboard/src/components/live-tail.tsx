'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  CircleNotch,
  PhoneDisconnect,
  Broadcast,
  Sparkle,
  WifiHigh,
  WifiSlash,
  Wrench,
} from '@phosphor-icons/react/dist/ssr';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Separator } from '@/components/ui/separator';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Transcript, type TranscriptTurn } from '@/components/transcript';
import { ChatView } from '@/components/chat-view';
import { CopyTranscriptButton } from '@/components/copy-transcript-button';
import { DownloadRecordingButton } from '@/components/download-recording-button';
import { OutcomeBadge } from '@/components/outcome-badge';
import { cn } from '@/lib/utils';

interface InitialPayload {
  callId: string;
  isActive: boolean;
  session?: {
    callMode?: string;
    stage?: string;
    couponsApplied?: string[];
    selectedPlanId?: string;
  } | null;
  persisted: {
    outcome: string | null;
    endedAt: string | null;
    selectedPlanId: string | null;
    couponApplied: string | null;
    phoneNumber: string | null;
    customerName: string | null;
    turns: Array<{
      speaker: string;
      utterance: string;
      objectionType: string | null;
      sentiment: string | null;
      toolCalled: string | null;
      toolArgs: unknown;
      observationsCalled: unknown;
      createdAt: string;
    }>;
  };
}

type LiveEvent =
  | { type: 'hello' }
  | { type: 'status'; status: 'thinking' | 'tool_calling' | 'speaking' | 'idle'; tool?: string }
  | {
      type: 'session_init';
      selectedPlanId: string;
      callMode: 'INBOUND_PRESALES' | 'OUTBOUND_RECOVERY';
      stage: string;
      couponsApplied: string[];
      ts: string;
    }
  | { type: 'user_utterance'; utterance: string; ts: string }
  | { type: 'text_delta'; delta: string; ts: string }
  | { type: 'agent_turn'; utterance: string; ts: string }
  | { type: 'observation'; name: string; args: Record<string, unknown>; result: unknown; ts: string }
  | { type: 'tool_call'; name: string; args: Record<string, unknown>; ts: string }
  | { type: 'turn_done'; ts: string }
  | {
      type: 'classified';
      callTurnId: string;
      utterance: string;
      objectionType: string;
      subtype: string | null;
      sentiment: 'POSITIVE' | 'NEGATIVE' | 'NEUTRAL';
      ts: string;
    }
  | { type: 'call_ended'; reason?: string; ts: string };

type Status = 'thinking' | 'tool_calling' | 'speaking' | 'idle';

interface ObservationLogItem {
  name: string;
  args: Record<string, unknown>;
  ts: string;
}

const PHASE_LABEL: Record<string, string> = {
  PHASE1: 'One-Step',
  PHASE2: 'Two-Step',
  INSTANT: 'Instant Fund',
};

function prettyArgs(args: Record<string, unknown> | undefined): string {
  if (!args) return '';
  const parts = Object.entries(args)
    .filter(([, v]) => v !== null && v !== undefined && v !== '')
    .map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`);
  return parts.length ? ` (${parts.join(', ')})` : '';
}

export function LiveTail({
  callId,
  hideEndButton = false,
}: {
  callId: string;
  /** When true, suppresses the in-card "Hang up" button. Used by the
   * Talk-to-agent page, which has its own browser-side vapi.stop() button
   * in the connected header — two hang-ups in one view is confusing. */
  hideEndButton?: boolean;
}) {
  const [initial, setInitial] = useState<InitialPayload | null>(null);
  const [turns, setTurns] = useState<TranscriptTurn[]>([]);
  const [partial, setPartial] = useState<string>('');
  const [status, setStatus] = useState<Status>('idle');
  const [statusTool, setStatusTool] = useState<string | undefined>(undefined);
  const [observations, setObservations] = useState<ObservationLogItem[]>([]);
  const [connected, setConnected] = useState(false);
  const [ended, setEnded] = useState(false);
  const [endReason, setEndReason] = useState<string | null>(null);
  const [endingNow, setEndingNow] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const esRef = useRef<EventSource | null>(null);
  const partialBufferRef = useRef('');
  // Observations the LLM ran since the last agent_turn — attached when the
  // next agent_turn lands so the chat / transcript can show them as chips.
  const pendingObservationsRef = useRef<Array<{ name: string; args: Record<string, unknown> }>>([]);

  // ── Bootstrap with persisted state (so we render something while the
  //    stream connects, and so we have customer / plan metadata).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`/api/live/${callId}`, { cache: 'no-store' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = (await res.json()) as InitialPayload;
        if (cancelled) return;
        setInitial(data);
        setTurns(
          data.persisted.turns.map((t) => ({
            speaker: t.speaker as 'USER' | 'AGENT',
            utterance: t.utterance,
            objectionType: t.objectionType,
            sentiment: (t.sentiment ?? null) as
              | 'POSITIVE'
              | 'NEGATIVE'
              | 'NEUTRAL'
              | null,
            toolCalled: t.toolCalled,
            toolArgs: t.toolArgs,
            observations: Array.isArray(t.observationsCalled)
              ? (t.observationsCalled as Array<{ name: string; args?: Record<string, unknown> }>)
              : undefined,
            timestamp: t.createdAt,
          })),
        );
        if (!data.isActive) {
          setEnded(true);
          setEndReason(data.persisted.outcome ?? 'ended');
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : 'load failed');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [callId]);

  // ── Open the SSE stream ───────────────────────────────────────────────
  useEffect(() => {
    if (ended) return; // never reopen after end
    const es = new EventSource(`/api/live/${callId}/stream`);
    esRef.current = es;

    es.onopen = () => setConnected(true);
    es.onerror = () => {
      setConnected(false);
      // EventSource auto-reconnects; nothing to do.
    };
    es.onmessage = (msg) => {
      let event: LiveEvent;
      try {
        event = JSON.parse(msg.data) as LiveEvent;
      } catch {
        return;
      }
      switch (event.type) {
        case 'hello':
          setConnected(true);
          break;
        case 'session_init':
          // Gateway lazy-created the session — backfill the panel chips
          // that initially rendered as "—" because the /api/live fetch
          // raced session creation and lost.
          setInitial((prev) =>
            prev
              ? {
                  ...prev,
                  persisted: {
                    ...prev.persisted,
                    selectedPlanId: event.selectedPlanId,
                    couponApplied:
                      event.couponsApplied[0] ?? prev.persisted.couponApplied,
                  },
                  session: {
                    ...(prev.session ?? {}),
                    callMode: event.callMode,
                    stage: event.stage,
                    selectedPlanId: event.selectedPlanId,
                  },
                }
              : prev,
          );
          break;
        case 'status':
          setStatus(event.status);
          setStatusTool(event.tool);
          break;
        case 'user_utterance':
          setPartial('');
          partialBufferRef.current = '';
          pendingObservationsRef.current = [];
          setTurns((prev) => [
            ...prev,
            {
              speaker: 'USER',
              utterance: event.utterance,
              timestamp: event.ts,
              objectionType: null,
              sentiment: null,
              toolCalled: null,
              toolArgs: null,
            },
          ]);
          break;
        case 'text_delta':
          partialBufferRef.current += event.delta;
          setPartial(partialBufferRef.current);
          break;
        case 'agent_turn': {
          const finalText = event.utterance;
          partialBufferRef.current = '';
          setPartial('');
          // Attach observations that ran during this turn.
          const observationsForTurn = pendingObservationsRef.current;
          pendingObservationsRef.current = [];
          setTurns((prev) => [
            ...prev,
            {
              speaker: 'AGENT',
              utterance: finalText,
              timestamp: event.ts,
              objectionType: null,
              sentiment: null,
              toolCalled: null,
              toolArgs: null,
              observations: observationsForTurn,
            },
          ]);
          break;
        }
        case 'observation':
          setObservations((prev) => [...prev.slice(-9), { name: event.name, args: event.args, ts: event.ts }]);
          pendingObservationsRef.current = [
            ...pendingObservationsRef.current,
            { name: event.name, args: event.args },
          ];
          break;
        case 'tool_call':
          // Side-effect tool — annotate the LAST agent turn (if any) so it
          // matches the persisted view of the conversation.
          setTurns((prev) => {
            if (prev.length === 0) return prev;
            const next = [...prev];
            for (let i = next.length - 1; i >= 0; i--) {
              if (next[i].speaker === 'AGENT' && !next[i].toolCalled) {
                next[i] = { ...next[i], toolCalled: event.name, toolArgs: event.args };
                break;
              }
            }
            return next;
          });
          break;
        case 'turn_done':
          // No-op for now; status already flipped to idle.
          break;
        case 'classified': {
          // Stamp the chip onto the matching caller turn. Classification
          // runs async via BullMQ after the turn is persisted, so we
          // match on utterance text (id isn't carried on live turns).
          // Walk back-to-front and tag the most recent USER turn whose
          // text matches and doesn't yet have a chip — that way two
          // identical "hello" turns don't both get overwritten.
          const target = event.utterance.trim();
          setTurns((prev) => {
            for (let i = prev.length - 1; i >= 0; i--) {
              const t = prev[i];
              if (
                t.speaker === 'USER' &&
                !t.objectionType &&
                t.utterance.trim() === target
              ) {
                const next = [...prev];
                next[i] = {
                  ...t,
                  objectionType: event.objectionType,
                  sentiment: event.sentiment,
                };
                return next;
              }
            }
            return prev;
          });
          break;
        }
        case 'call_ended':
          setEnded(true);
          setEndReason(event.reason ?? 'ended');
          setStatus('idle');
          setStatusTool(undefined);
          es.close();
          // Mark ended in Postgres so the Live page drops it immediately,
          // even if Vapi's end-of-call-report webhook never arrives.
          fetch(`/api/live/${callId}/mark-ended`, { method: 'POST' }).catch(() => {
            /* best-effort */
          });
          break;
      }
    };

    return () => {
      es.close();
      esRef.current = null;
    };
  }, [callId, ended]);

  const handleEnd = useCallback(async () => {
    if (endingNow || ended) return;
    if (!window.confirm('Hang up this call now?')) return;
    setEndingNow(true);
    try {
      const res = await fetch(`/api/live/${callId}/end`, { method: 'POST' });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        setError(
          (body as { error?: { message?: string } } | null)?.error?.message ??
            `Gateway returned ${res.status}`,
        );
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'end-call failed');
    } finally {
      setEndingNow(false);
    }
  }, [callId, ended, endingNow]);

  const allTurns: TranscriptTurn[] =
    partial.length > 0
      ? [
          ...turns,
          {
            speaker: 'AGENT',
            utterance: partial,
            timestamp: new Date().toISOString(),
            objectionType: null,
              sentiment: null,
            toolCalled: null,
            toolArgs: null,
          },
        ]
      : turns;

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="flex flex-row flex-wrap items-center justify-between gap-3">
          <div className="space-y-1">
            <CardTitle className="text-base">
              {initial?.persisted.customerName ?? initial?.persisted.phoneNumber ?? 'Anonymous caller'}
            </CardTitle>
            <div className="flex flex-wrap items-center gap-2 text-xs">
              {ended ? (
                <OutcomeBadge outcome={initial?.persisted.outcome ?? endReason} />
              ) : (
                <Badge variant="ff">
                  <Broadcast className="mr-1 size-3 animate-pulse" />
                  Live
                </Badge>
              )}
              <StatusChip status={status} tool={statusTool} ended={ended} />
              <span
                className={cn(
                  'flex items-center gap-1',
                  connected ? 'text-muted-foreground' : 'text-destructive',
                )}
              >
                {connected ? <WifiHigh className="size-3" /> : <WifiSlash className="size-3" />}
                {connected ? 'streaming' : 'reconnecting…'}
              </span>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {ended ? (
              <DownloadRecordingButton
                callId={callId}
                filenameBase={`ff-call-${initial?.persisted.customerName?.replace(/\s+/g, '-').toLowerCase() ?? callId.slice(0, 8)}`}
              />
            ) : null}
            {hideEndButton ? null : (
              <Button
                variant="destructive"
                size="sm"
                onClick={handleEnd}
                disabled={ended || endingNow}
              >
                <PhoneDisconnect className="size-4" />
                {endingNow ? 'Hanging up…' : ended ? 'Call ended' : 'Hang up'}
              </Button>
            )}
          </div>
        </CardHeader>
        <CardContent>
          <dl className="grid grid-cols-2 gap-y-2 text-sm md:grid-cols-4">
            <dt className="text-muted-foreground">Plan</dt>
            <dd>
              {initial?.persisted.selectedPlanId
                ? prettyPlan(initial.persisted.selectedPlanId)
                : '—'}
            </dd>
            <dt className="text-muted-foreground">Mode</dt>
            <dd>{initial?.session?.callMode ?? '—'}</dd>
            <dt className="text-muted-foreground">Stage</dt>
            <dd>{initial?.session?.stage ?? '—'}</dd>
            <dt className="text-muted-foreground">Coupon</dt>
            <dd>
              {initial?.persisted.couponApplied ?? initial?.session?.couponsApplied?.[0] ?? '—'}
            </dd>
          </dl>
          {error ? (
            <p className="mt-3 rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
              {error}
            </p>
          ) : null}
        </CardContent>
      </Card>

      {observations.length > 0 ? (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Tool activity</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-wrap gap-2">
            {observations.map((o, i) => (
              <Badge key={`${o.ts}-${i}`} variant="info" className="font-normal">
                <Wrench className="mr-1 size-3" />
                {o.name}
                <span className="ml-1 text-[10px] opacity-70">{prettyArgs(o.args)}</span>
              </Badge>
            ))}
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <Tabs defaultValue="chat" className="w-full">
          <CardHeader className="flex flex-row items-center justify-between gap-3">
            <CardTitle>Conversation ({allTurns.length})</CardTitle>
            <div className="flex items-center gap-2">
              {partial.length > 0 ? (
                <Badge variant="ff" className="font-normal">
                  <Sparkle className="mr-1 size-3" />
                  streaming
                </Badge>
              ) : null}
              <CopyTranscriptButton
                turns={allTurns}
                agentLabel="Maya"
                header={[
                  'Funded Friday call',
                  initial?.persisted.customerName ?? initial?.persisted.phoneNumber ?? null,
                  new Date().toLocaleString(),
                ]
                  .filter(Boolean)
                  .join(' — ')}
              />
              <TabsList>
                <TabsTrigger value="chat">Chat</TabsTrigger>
                <TabsTrigger value="transcript">Transcript</TabsTrigger>
              </TabsList>
            </div>
          </CardHeader>
          <Separator />
          <TabsContent value="chat" className="m-0">
            <ChatView
              turns={allTurns}
              thinking={!ended && (status === 'thinking' || status === 'tool_calling')}
              thinkingTool={status === 'tool_calling' ? statusTool ?? null : null}
              emptyHint={
                ended
                  ? 'Call ended before any messages were exchanged.'
                  : 'Waiting for the first message…'
              }
            />
          </TabsContent>
          <TabsContent value="transcript" className="m-0">
            <Transcript
              turns={allTurns}
              emptyHint={
                ended
                  ? 'Call ended before any turns were recorded.'
                  : 'Waiting for the first turn…'
              }
            />
          </TabsContent>
        </Tabs>
      </Card>
    </div>
  );
}

function StatusChip({
  status,
  tool,
  ended,
}: {
  status: Status;
  tool?: string;
  ended: boolean;
}) {
  if (ended) return null;
  switch (status) {
    case 'thinking':
      return (
        <Badge variant="warning" className="font-normal">
          <CircleNotch className="mr-1 size-3 animate-spin" />
          Thinking…
        </Badge>
      );
    case 'tool_calling':
      return (
        <Badge variant="info" className="font-normal">
          <Wrench className="mr-1 size-3" />
          Calling {tool ?? 'tool'}…
        </Badge>
      );
    case 'speaking':
      return (
        <Badge variant="ff" className="font-normal">
          <Sparkle className="mr-1 size-3" />
          Speaking
        </Badge>
      );
    case 'idle':
    default:
      return (
        <Badge variant="secondary" className="font-normal">
          Idle
        </Badge>
      );
  }
}

function prettyPlan(planId: string): string {
  const match = planId.match(/^(phase1|phase2|instant)_(\d+)k$/i);
  if (!match) return planId;
  const phaseKey = match[1].toUpperCase().startsWith('PHASE1')
    ? 'PHASE1'
    : match[1].toUpperCase().startsWith('PHASE2')
      ? 'PHASE2'
      : 'INSTANT';
  return `$${match[2]}K ${PHASE_LABEL[phaseKey]}`;
}
