'use client';

import { TalkButtonVapi } from './talk-button-vapi';
import { TalkButtonTelnyx } from './talk-button-telnyx';

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

type CommonProps = {
  products: ProductOption[];
  offersByProduct: Record<string, OfferLite>;
};

export type TalkButtonProps = CommonProps &
  (
    | { provider: 'vapi'; publicKey: string; assistantId: string }
    | { provider: 'telnyx'; assistantId: string }
  );

/**
 * Picks the provider-specific component based on what the gateway returned.
 * Telnyx variant always runs anonymous WebRTC via @telnyx/ai-agent-lib; the
 * Vapi variant uses Vapi's own SDK with a public key.
 */
export function TalkButton(props: TalkButtonProps) {
  if (props.provider === 'telnyx') {
    return (
      <TalkButtonTelnyx
        assistantId={props.assistantId}
        products={props.products}
        offersByProduct={props.offersByProduct}
      />
    );
  }
  return (
    <TalkButtonVapi
      publicKey={props.publicKey}
      assistantId={props.assistantId}
      products={props.products}
    />
  );
}
