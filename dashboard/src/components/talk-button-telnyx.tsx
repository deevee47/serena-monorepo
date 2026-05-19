'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Microphone,
  MicrophoneSlash,
  Phone,
  PhoneDisconnect,
} from '@phosphor-icons/react/dist/ssr';
import { TelnyxAIAgent } from '@telnyx/ai-agent-lib';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { LiveTail } from '@/components/live-tail';
import { cn } from '@/lib/utils';

/** How long to wait for the gateway to populate `web_call_bridge:<uuid>`.
 *  Anchored on real-call timing:
 *    - Telnyx accepts INVITE, plays its built-in greeting (~3-5s)
 *    - User speaks, STT transcribes (~2-4s)
 *    - First /llm/chat/completions reaches gateway, writes the bridge (~1s)
 *  Observed first-turn latency: 7-14s. Cap at 45s with a 750ms cadence so
 *  even slow STT cases resolve. After that, the call is almost certainly
 *  dead and a longer wait would just leak a poller. */
const BRIDGE_POLL_INTERVAL_MS = 750;
const BRIDGE_POLL_MAX_ATTEMPTS = 60;

async function resolveBridgeCallId(uuid: string, signal: AbortSignal): Promise<string | null> {
  for (let i = 0; i < BRIDGE_POLL_MAX_ATTEMPTS; i++) {
    if (signal.aborted) return null;
    try {
      const res = await fetch(`/api/calls/by-bridge/${encodeURIComponent(uuid)}`, {
        cache: 'no-store',
        signal,
      });
      if (res.ok) {
        const body = (await res.json()) as { call_id?: string };
        if (body.call_id) return body.call_id;
      }
    } catch {
      if (signal.aborted) return null;
    }
    await new Promise((resolve) => setTimeout(resolve, BRIDGE_POLL_INTERVAL_MS));
  }
  return null;
}

type Status = 'idle' | 'connecting' | 'live' | 'ending' | 'error';
type CallMode = 'INBOUND_PRESALES' | 'OUTBOUND_RECOVERY';

interface ProductOption {
  id: string;
  name: string;
  price: number;
  category: string | null;
}

interface OfferLite {
  discountPct: number;
  shortPitch: string;
}

type TalkButtonTelnyxProps = {
  products: ProductOption[];
  offersByProduct: Record<string, OfferLite>;
  assistantId: string;
};

function productLabel(p: ProductOption): string {
  return `${p.name} — $${p.price.toFixed(0)}`;
}

/**
 * Telnyx AI Assistant talk button.
 *
 * Uses `@telnyx/ai-agent-lib` (TelnyxAIAgent) — the higher-level wrapper
 * Telnyx's own portal widget at /ai-widget-demo uses. The raw `@telnyx/webrtc`
 * Verto SDK accepts the INVITE but the AI Assistant runtime never auto-answers
 * an anonymous WebRTC call placed through it; ai-agent-lib runs the
 * AI-Assistant-specific signaling that triggers auto-answer.
 */
export function TalkButtonTelnyx(props: TalkButtonTelnyxProps) {
  const { products, offersByProduct, assistantId } = props;
  const agentRef = useRef<TelnyxAIAgent | null>(null);
  const remoteAudioRef = useRef<HTMLAudioElement | null>(null);
  const [status, setStatus] = useState<Status>('idle');
  const [muted, setMuted] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  const [mode, setMode] = useState<CallMode>('OUTBOUND_RECOVERY');
  const [productId, setProductId] = useState<string>(products[0]?.id ?? '');
  const [activeMode, setActiveMode] = useState<CallMode | null>(null);
  const [activeProductId, setActiveProductId] = useState<string | null>(null);
  // Canonical Telnyx call ID, resolved via the gateway's bridge map. Null
  // until the first LLM turn lands and writes `web_call_bridge:<uuid>`.
  const [resolvedCallId, setResolvedCallId] = useState<string | null>(null);
  // Abort controller for the in-flight bridge poll. Reset on stop/error so a
  // new call doesn't inherit the previous attempt's poll.
  const bridgePollAbort = useRef<AbortController | null>(null);

  useEffect(() => {
    const agent = new TelnyxAIAgent({
      agentId: assistantId,
      environment: 'production',
      debug: true,
      // Default is true already; pinning explicitly to document the intent.
      // Skips sticky reconnection to the previous b2bua-rtc instance, which
      // is the main mitigation for `LOGIN_FAILED: Login Incorrect` caused
      // by RMQ propagation lag on Telnyx's voice-sdk-proxy.
      skipLastVoiceSdkId: true,
    });
    agentRef.current = agent;

    // Clear any stale reconnect token cached by a previous mount/page-load.
    // Without this, an earlier session's b2bua-rtc routing token can pin us
    // to an instance whose state was already torn down — VSP responds with
    // "Login Incorrect" on the next anonymous_login.
    agent.clearReconnectToken();

    let recoveryAttempted = false;

    const onConnected = (info: unknown) => {
      console.info('[telnyx-ai] connected', info);
      setReady(true);
      setErrorMsg(null);
      recoveryAttempted = false;
    };
    const onDisconnected = () => {
      console.info('[telnyx-ai] disconnected');
      setReady(false);
    };
    const onError = (err: Error) => {
      console.error('[telnyx-ai] error', err);
      const msg = err.message ?? String(err);

      // Single-shot recovery for the known `LOGIN_FAILED: Login Incorrect`
      // race. Clear the cached routing token and reconnect once. If it
      // fails again we surface the error to the UI.
      if (
        !recoveryAttempted &&
        (msg.includes('LOGIN_FAILED') || msg.includes('Login Incorrect'))
      ) {
        recoveryAttempted = true;
        console.warn(
          '[telnyx-ai] LOGIN_FAILED detected — clearing reconnect token and retrying once',
        );
        try {
          agent.clearReconnectToken();
        } catch {
          /* method is best-effort */
        }
        void agent.connect().catch((retryErr: unknown) => {
          console.error('[telnyx-ai] retry connect failed', retryErr);
          setStatus('error');
          setErrorMsg(retryErr instanceof Error ? retryErr.message : 'Failed to reconnect');
        });
        return;
      }

      setStatus('error');
      setErrorMsg(msg);
    };
    const onConversationUpdate = (note: unknown) => {
      const n = note as {
        call?: { state?: string; remoteStream?: MediaStream | null };
      };
      console.info('[telnyx-ai] conversation update', n.call?.state);
      if (n.call?.state === 'active') {
        setStatus('live');
        setErrorMsg(null);
        if (n.call.remoteStream && remoteAudioRef.current) {
          remoteAudioRef.current.srcObject = n.call.remoteStream;
        }
      } else if (n.call?.state === 'hangup' || n.call?.state === 'destroy') {
        setStatus('idle');
        setMuted(false);
        setActiveMode(null);
        setActiveProductId(null);
        setResolvedCallId(null);
        bridgePollAbort.current?.abort();
        bridgePollAbort.current = null;
      }
    };

    agent.on('agent.connected', onConnected);
    agent.on('agent.disconnected', onDisconnected);
    agent.on('agent.error', onError);
    agent.on('conversation.update', onConversationUpdate);

    console.info('[telnyx-ai] connecting…', { assistantId });
    void agent.connect().catch((err: unknown) => {
      console.error('[telnyx-ai] connect failed', err);
      setStatus('error');
      setErrorMsg(err instanceof Error ? err.message : 'Failed to connect');
    });

    return () => {
      agent.off('agent.connected', onConnected);
      agent.off('agent.disconnected', onDisconnected);
      agent.off('agent.error', onError);
      agent.off('conversation.update', onConversationUpdate);
      void agent.disconnect().catch(() => undefined);
      agentRef.current = null;
    };
  }, [assistantId]);

  const start = useCallback(async () => {
    const agent = agentRef.current;
    if (!agent) return;
    if (!ready) {
      setStatus('error');
      setErrorMsg('Telnyx not connected yet — wait a moment and retry');
      return;
    }
    setStatus('connecting');
    setErrorMsg(null);

    const effectiveProductId =
      mode === 'OUTBOUND_RECOVERY' ? productId : productId || products[0]?.id || '';
    setActiveMode(mode);
    setActiveProductId(effectiveProductId || null);

    const offer = effectiveProductId ? offersByProduct[effectiveProductId] : null;
    const bridgeUuid = crypto.randomUUID();

    try {
      // `X-` headers map to dynamic variables in the assistant prompt
      // (`X-Call-Mode` → `{{call_mode}}`). Underscored versions are what the
      // assistant template sees. X-Bridge-UUID is read by the gateway's LLM
      // route to populate `web_call_bridge:<uuid>` → callId, which LiveTail
      // then resolves below.
      await agent.startConversation({
        callerName: 'Serena Dashboard',
        customHeaders: [
          { name: 'X-Call-Mode', value: mode },
          { name: 'X-Product-Id', value: effectiveProductId || '' },
          { name: 'X-Bridge-UUID', value: bridgeUuid },
          ...(offer
            ? [
                { name: 'X-Discount-Pct', value: String(offer.discountPct) },
                { name: 'X-Short-Pitch', value: offer.shortPitch.slice(0, 100) },
              ]
            : []),
        ],
      });

      // Kick off bridge resolution in the background. The first LLM turn
      // writes the bridge entry; we poll until it shows up. AbortController
      // lets a hangup short-circuit the loop.
      bridgePollAbort.current?.abort();
      const ac = new AbortController();
      bridgePollAbort.current = ac;
      void resolveBridgeCallId(bridgeUuid, ac.signal).then((resolved) => {
        if (resolved && !ac.signal.aborted) {
          setResolvedCallId(resolved);
        }
      });
    } catch (err) {
      console.error('[telnyx-ai] start failed', err);
      setStatus('error');
      setErrorMsg(err instanceof Error ? err.message : 'Failed to start call');
      setActiveMode(null);
      setActiveProductId(null);
    }
  }, [ready, mode, productId, products, offersByProduct]);

  const stop = useCallback(async () => {
    const agent = agentRef.current;
    if (!agent) return;
    setStatus('ending');
    try {
      await agent.endConversation();
    } catch {
      // conversation.update will reset state regardless
    }
  }, []);

  const toggleMute = useCallback(() => {
    const call = agentRef.current?.activeCall as
      | { muteAudio?: () => void; unmuteAudio?: () => void }
      | null
      | undefined;
    if (!call) return;
    const next = !muted;
    if (next) call.muteAudio?.();
    else call.unmuteAudio?.();
    setMuted(next);
  }, [muted]);

  const live = status === 'live' || status === 'ending';
  const activeProduct = activeProductId ? products.find((p) => p.id === activeProductId) : null;

  const audioEl = (
    <audio ref={remoteAudioRef} autoPlay playsInline style={{ display: 'none' }} />
  );

  if (live) {
    return (
      <div className="space-y-4">
        {audioEl}
        <Card>
          <CardContent className="flex flex-wrap items-center justify-between gap-3 p-4">
            <div className="flex flex-wrap items-center gap-2">
              <span className="relative flex size-2">
                <span className="absolute inline-flex size-full animate-ping bg-ff-orange opacity-75" />
                <span className="relative inline-flex size-2 bg-ff-orange" />
              </span>
              <span className="text-sm font-medium">Connected — speak now</span>
              {activeMode ? (
                <Badge variant="outline">
                  {activeMode === 'INBOUND_PRESALES' ? 'Inbound' : 'Outbound'}
                </Badge>
              ) : null}
              {activeProduct ? <Badge variant="outline">{productLabel(activeProduct)}</Badge> : null}
              {muted ? <Badge variant="outline">Muted</Badge> : null}
            </div>
            <div className="flex items-center gap-2">
              <Button variant="ghost" size="sm" onClick={toggleMute}>
                {muted ? (
                  <MicrophoneSlash className="size-4" />
                ) : (
                  <Microphone className="size-4" />
                )}
                {muted ? 'Unmute mic' : 'Mute mic'}
              </Button>
              <Button
                variant="destructive"
                size="sm"
                onClick={stop}
                disabled={status === 'ending'}
              >
                <PhoneDisconnect className="size-4" />
                {status === 'ending' ? 'Hanging up…' : 'Hang up'}
              </Button>
            </div>
          </CardContent>
        </Card>
        {resolvedCallId ? (
          <LiveTail callId={resolvedCallId} hideEndButton />
        ) : (
          <Card>
            <CardContent className="p-6 text-center text-sm text-muted-foreground">
              Waiting for Telnyx to assign a call ID…
            </CardContent>
          </Card>
        )}
      </div>
    );
  }

  const connecting = status === 'connecting';
  const outbound = mode === 'OUTBOUND_RECOVERY';
  const canStart =
    !connecting && (mode === 'INBOUND_PRESALES' || (outbound && productId.length > 0));

  return (
    <div className="grid gap-6 md:grid-cols-[1fr_320px]">
      {audioEl}
      <div className="flex flex-col items-center justify-center gap-4 rounded-md border bg-card/40 p-12">
        <Button
          type="button"
          size="lg"
          variant="ff"
          disabled={!canStart}
          onClick={start}
          className={cn('size-24 rounded-full', connecting && 'animate-pulse')}
        >
          <Phone className="size-10" />
        </Button>
        <div className="flex flex-col items-center gap-1.5 text-center">
          {status === 'idle' && (
            <Badge variant={ready ? 'outline' : 'secondary'}>
              {ready ? 'Ready' : 'Connecting to Telnyx…'}
            </Badge>
          )}
          {connecting && <Badge variant="outline">Connecting call…</Badge>}
          {status === 'error' && <Badge variant="destructive">Error</Badge>}
          <p className="max-w-sm text-sm text-muted-foreground">
            {status === 'idle' &&
              (ready
                ? 'Tap to start talking to the agent in your browser.'
                : 'Opening WebSocket to Telnyx — this usually takes a second.')}
            {connecting && 'Asking for mic permission and dialing the assistant…'}
            {status === 'error' && (errorMsg ?? 'Something went wrong. Tap to retry.')}
          </p>
        </div>
      </div>

      <Card>
        <CardContent className="space-y-5 p-5">
          <div>
            <div className="mb-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
              Call mode
            </div>
            <div className="grid grid-cols-2 border">
              <button
                type="button"
                onClick={() => setMode('INBOUND_PRESALES')}
                className={cn(
                  'border-r px-3 py-2 text-sm font-medium transition-colors',
                  mode === 'INBOUND_PRESALES'
                    ? 'bg-ff-orange text-white'
                    : 'bg-transparent text-muted-foreground hover:text-foreground',
                )}
              >
                Inbound
              </button>
              <button
                type="button"
                onClick={() => setMode('OUTBOUND_RECOVERY')}
                className={cn(
                  'px-3 py-2 text-sm font-medium transition-colors',
                  mode === 'OUTBOUND_RECOVERY'
                    ? 'bg-ff-orange text-white'
                    : 'bg-transparent text-muted-foreground hover:text-foreground',
                )}
              >
                Outbound
              </button>
            </div>
            <p className="mt-2 text-xs text-muted-foreground">
              {mode === 'INBOUND_PRESALES'
                ? 'Anonymous shopper calling in with questions. Greet + listen.'
                : 'Follow-up on a customer who abandoned cart. Open with the product they picked.'}
            </p>
          </div>

          <div>
            <div className="mb-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
              Product {outbound ? '' : '(optional)'}
            </div>
            <select
              value={productId}
              onChange={(e) => setProductId(e.target.value)}
              className={cn(
                'h-9 w-full min-w-0 border border-input bg-transparent px-3 py-1 text-sm outline-none',
                'focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50',
                'disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50',
              )}
            >
              {!outbound ? <option value="">Default (first product)</option> : null}
              {products.map((p) => (
                <option key={p.id} value={p.id}>
                  {productLabel(p)}
                </option>
              ))}
            </select>
            <p className="mt-2 text-xs text-muted-foreground">
              {outbound
                ? 'The product Sera assumes the caller abandoned. Drives the opener.'
                : 'Inbound starts agnostic — leave on default unless you want to bias the greeting.'}
            </p>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
