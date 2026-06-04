import { prisma } from '../lib/prisma.js';
import { getProductById } from './product.service.js';

const AGENT_NAME = 'Sera';
const BUSINESS_NAME = 'Serena';

export type CallMode = 'INBOUND_PRESALES' | 'OUTBOUND_RECOVERY';

interface ActiveOffer {
  discountPct: number;
  shortPitch: string;
}

interface OpenerContext {
  mode: CallMode;
  productName: string | null;
  activeOffer: ActiveOffer | null;
}

/**
 * Outbound opener templates. Weighted random selection — every option that
 * can render (returns non-null given the context) competes for selection.
 * Moved verbatim from `dashboard/src/components/talk-button-vapi.tsx` so
 * both providers (and the LLM endpoint's empty-utterance first turn) get
 * the same set instead of forking client-side variants.
 */
const OUTBOUND_OPENERS: Array<{
  weight: number;
  build: (c: OpenerContext) => string | null;
}> = [
  {
    weight: 30,
    build: (c) => {
      const ref = c.productName
        ? ` noticed you were eyeing the ${c.productName} earlier,`
        : '';
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
      const ref = c.productName
        ? ` quick one about the ${c.productName} in your cart —`
        : '';
      return `Hey there, ${AGENT_NAME} from ${BUSINESS_NAME}.${ref} what's stopped you from wrapping it — the price, the fit, or just timing?`;
    },
  },
  {
    weight: 13,
    build: (c) => {
      const ref = c.productName
        ? ` checking in on the ${c.productName} you were looking at.`
        : '';
      return `Hey there, ${AGENT_NAME} here from ${BUSINESS_NAME} —${ref} want to wrap that up, or anything I can clear up first?`;
    },
  },
];

function pickWeighted(ctx: OpenerContext): string {
  const candidates = OUTBOUND_OPENERS.map((t) => ({
    weight: t.weight,
    text: t.build(ctx),
  })).filter((c): c is { weight: number; text: string } => c.text !== null);
  if (candidates.length === 0) {
    return `Hi, this is ${AGENT_NAME} from ${BUSINESS_NAME}.`;
  }
  const total = candidates.reduce((sum, c) => sum + c.weight, 0);
  let pick = Math.random() * total;
  for (const c of candidates) {
    pick -= c.weight;
    if (pick <= 0) return c.text;
  }
  return candidates[candidates.length - 1]!.text;
}

async function loadActiveOfferForProduct(productId: string): Promise<ActiveOffer | null> {
  const now = new Date();
  const offer = await prisma.offer
    .findFirst({
      where: {
        productId,
        isActive: true,
        OR: [{ validUntil: null }, { validUntil: { gte: now } }],
      },
      orderBy: { discountPercent: 'desc' },
    })
    .catch(() => null);
  if (!offer) return null;
  return { discountPct: offer.discountPercent, shortPitch: offer.shortPitch };
}

export interface GenerateOpenerInput {
  mode: CallMode;
  /** Optional — when omitted, opener uses product-agnostic phrasing. */
  productId?: string | null;
}

/**
 * Authoritative opener generator. Inbound returns a fixed greet. Outbound
 * loads the live product + active offer from Postgres and renders one
 * weighted-random template from the pool above.
 */
export async function generateOpener(input: GenerateOpenerInput): Promise<string> {
  if (input.mode === 'INBOUND_PRESALES') {
    return `${BUSINESS_NAME}, this is ${AGENT_NAME} — how can I help?`;
  }
  const product = input.productId ? getProductById(input.productId) : null;
  const productName = product?.name ?? null;
  const activeOffer = input.productId ? await loadActiveOfferForProduct(input.productId) : null;
  return pickWeighted({ mode: input.mode, productName, activeOffer });
}
