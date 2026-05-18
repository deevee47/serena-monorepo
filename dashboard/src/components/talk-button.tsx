'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Microphone,
  MicrophoneSlash,
  Phone,
  PhoneDisconnect,
} from '@phosphor-icons/react/dist/ssr';
import Vapi from '@vapi-ai/web';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { LiveTail } from '@/components/live-tail';
import { cn } from '@/lib/utils';

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

interface TalkButtonProps {
  publicKey: string;
  assistantId: string;
  products: ProductOption[];
  /** Active offers keyed by product_id. Surfaced in the opener as a wrap-now carrot. */
  offersByProduct: Record<string, OfferLite>;
}

function productLabel(p: ProductOption): string {
  return `${p.name} — $${p.price.toFixed(0)}`;
}

const AGENT_NAME = 'Sera';
const BUSINESS_NAME = 'Serena';

type OpenerCtx = {
  mode: CallMode;
  productName: string | null;
  activeOffer: OfferLite | null;
};

const OUTBOUND_OPENERS: Array<{
  weight: number;
  build: (c: OpenerCtx) => string | null;
}> = [
  {
    weight: 30,
    build: (c) => {
      const ref = c.productName ? ` noticed you were eyeing the ${c.productName} earlier,` : '';
      return `Hey there, this is ${AGENT_NAME} from ${BUSINESS_NAME} —${ref} mind if I ask what's on your mind?`;
    },
  },
  {
    weight: 35,
    build: (c) => {
      if (!c.activeOffer) return null;
      const ref = c.productName ? ` saw you on the ${c.productName}.` : '';
      return `Hey there, ${AGENT_NAME} at ${BUSINESS_NAME} —${ref} Quick one — ${c.activeOffer.shortPitch}. Want to hear about it?`;
    },
  },
  {
    weight: 22,
    build: (c) => {
      const ref = c.productName ? ` quick one about the ${c.productName} in your cart —` : '';
      return `Hey there, ${AGENT_NAME} from ${BUSINESS_NAME}.${ref} what's stopped you from wrapping it — the price, the fit, or just timing?`;
    },
  },
  {
    weight: 13,
    build: (c) => {
      const ref = c.productName ? ` checking in on the ${c.productName} you were looking at.` : '';
      return `Hey there, ${AGENT_NAME} here from ${BUSINESS_NAME} —${ref} want to wrap that up, or anything I can clear up first?`;
    },
  },
];

function buildFirstMessage(ctx: OpenerCtx): string {
  if (ctx.mode === 'INBOUND_PRESALES') {
    return `${BUSINESS_NAME}, this is ${AGENT_NAME} — how can I help?`;
  }
  const candidates = OUTBOUND_OPENERS.map((t) => ({
    weight: t.weight,
    text: t.build(ctx),
  })).filter((c): c is { weight: number; text: string } => c.text !== null);
  if (candidates.length === 0) {
    return `Hi, this is ${AGENT_NAME} from ${BUSINESS_NAME}.`;
  }
  const total = candidates.reduce((s, c) => s + c.weight, 0);
  let pick = Math.random() * total;
  for (const c of candidates) {
    pick -= c.weight;
    if (pick <= 0) return c.text;
  }
  return candidates[candidates.length - 1]!.text;
}

export function TalkButton({
  publicKey,
  assistantId,
  products,
  offersByProduct,
}: TalkButtonProps) {
  const vapiRef = useRef<Vapi | null>(null);
  const [status, setStatus] = useState<Status>('idle');
  const [callId, setCallId] = useState<string | null>(null);
  const [muted, setMuted] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const [mode, setMode] = useState<CallMode>('OUTBOUND_RECOVERY');
  const [productId, setProductId] = useState<string>(products[0]?.id ?? '');

  const [activeMode, setActiveMode] = useState<CallMode | null>(null);
  const [activeProductId, setActiveProductId] = useState<string | null>(null);

  const vapi = useMemo(() => {
    if (typeof window === 'undefined') return null;
    if (!vapiRef.current) {
      vapiRef.current = new Vapi(publicKey);
    }
    return vapiRef.current;
  }, [publicKey]);

  useEffect(() => {
    if (!vapi) return;

    const onStart = () => {
      setStatus('live');
      setErrorMsg(null);
    };
    const onEnd = () => {
      setStatus('idle');
      setCallId(null);
      setMuted(false);
      setActiveMode(null);
      setActiveProductId(null);
    };
    const onError = (err: unknown) => {
      setStatus('error');
      const msg =
        err instanceof Error
          ? err.message
          : typeof err === 'object' && err !== null && 'message' in err
            ? String((err as { message: unknown }).message)
            : 'Web call failed';
      setErrorMsg(msg);
    };

    vapi.on('call-start', onStart);
    vapi.on('call-end', onEnd);
    vapi.on('error', onError);

    return () => {
      vapi.removeListener('call-start', onStart);
      vapi.removeListener('call-end', onEnd);
      vapi.removeListener('error', onError);
      vapi.stop().catch(() => {});
    };
  }, [vapi]);

  const start = useCallback(async () => {
    if (!vapi) return;
    setStatus('connecting');
    setErrorMsg(null);
    setCallId(null);

    const effectiveProductId =
      mode === 'OUTBOUND_RECOVERY' ? productId : productId || products[0]?.id || '';
    const effectiveProduct = products.find((p) => p.id === effectiveProductId);
    setActiveMode(mode);
    setActiveProductId(effectiveProductId || null);

    try {
      const activeOffer = effectiveProductId ? offersByProduct[effectiveProductId] ?? null : null;

      const call = await vapi.start(assistantId, {
        firstMessage: buildFirstMessage({
          mode,
          productName: effectiveProduct?.name ?? null,
          activeOffer,
        }),
        firstMessageMode: 'assistant-speaks-first',
        metadata: {
          product_id: effectiveProductId,
          call_mode: mode,
        },
      });
      if (call?.id) setCallId(call.id);
    } catch (err) {
      setStatus('error');
      setErrorMsg(err instanceof Error ? err.message : 'Failed to start call');
      setActiveMode(null);
      setActiveProductId(null);
    }
  }, [vapi, assistantId, mode, productId, products, offersByProduct]);

  const stop = useCallback(async () => {
    if (!vapi) return;
    setStatus('ending');
    try {
      await vapi.stop();
    } catch {
      // call-end resets state
    }
  }, [vapi]);

  const toggleMute = useCallback(() => {
    if (!vapi) return;
    const next = !muted;
    vapi.setMuted(next);
    setMuted(next);
  }, [vapi, muted]);

  const live = status === 'live' || status === 'ending';
  const activeProduct = activeProductId ? products.find((p) => p.id === activeProductId) : null;

  if (live) {
    return (
      <div className="space-y-4">
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
        {callId ? (
          <LiveTail callId={callId} hideEndButton />
        ) : (
          <Card>
            <CardContent className="p-6 text-center text-sm text-muted-foreground">
              Waiting for Vapi to assign a call ID…
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
          {status === 'idle' && <Badge variant="outline">Ready</Badge>}
          {connecting && <Badge variant="outline">Connecting…</Badge>}
          {status === 'error' && <Badge variant="destructive">Error</Badge>}
          <p className="max-w-sm text-sm text-muted-foreground">
            {status === 'idle' && 'Tap to start talking to the agent in your browser.'}
            {connecting && 'Asking for mic permission and connecting…'}
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
