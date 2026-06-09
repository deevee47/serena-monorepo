import { prisma } from '../lib/prisma.js';
import { getProductById } from './product.service.js';

const AGENT_NAME = 'Sera';
const BUSINESS_NAME = 'Serena';

export type CallMode = 'INBOUND_PRESALES' | 'OUTBOUND_RECOVERY';
/** Language the agent OPENS in. Runtime turns still follow the customer's own
 *  language (the brain's LANGUAGE_RULES) — this only sets the first message. */
export type OpenerLanguage = 'en' | 'hi';

interface ActiveOffer {
  discountPct: number;
  shortPitch: string;
}

interface OpenerContext {
  mode: CallMode;
  productName: string | null;
  activeOffer: ActiveOffer | null;
}

interface OpenerTemplate {
  weight: number;
  build: (c: OpenerContext) => string | null;
}

/**
 * Outbound opener templates. Weighted random selection — every option that
 * can render (returns non-null given the context) competes for selection.
 * Moved verbatim from `dashboard/src/components/talk-button-vapi.tsx` so
 * both providers (and the LLM endpoint's empty-utterance first turn) get
 * the same set instead of forking client-side variants.
 */
const OUTBOUND_OPENERS_EN: OpenerTemplate[] = [
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

/**
 * Hindi/Hinglish counterparts — same intents and weights as the English pool
 * so a Hindi-selected call opens in Hindi from the very first message. Sera's
 * persona is feminine Hinglish ("bol rahi hoon", "bataiye"); an active offer's
 * `shortPitch` stays as authored (it may be English) — natural for Hinglish.
 */
const OUTBOUND_OPENERS_HI: OpenerTemplate[] = [
  {
    weight: 30,
    build: (c) => {
      const ref = c.productName ? ` dekha aap ${c.productName} dekh rahe the,` : '';
      return `Hello, main ${AGENT_NAME} bol rahi hoon ${BUSINESS_NAME} se —${ref} bataiye kya chal raha hai aapke mann mein?`;
    },
  },
  {
    weight: 35,
    build: (c) => {
      if (!c.activeOffer) return null;
      const ref = c.productName ? ` aap ${c.productName} dekh rahe the.` : '';
      return `Hello, ${AGENT_NAME} yahan ${BUSINESS_NAME} se —${ref} ek quick baat — ${c.activeOffer.shortPitch}. sunna chahenge?`;
    },
  },
  {
    weight: 22,
    build: (c) => {
      const ref = c.productName
        ? ` aapke cart mein ${c.productName} ke baare mein —`
        : '';
      return `Hello, main ${AGENT_NAME} ${BUSINESS_NAME} se.${ref} bataiye, kya rok raha hai — price, fit, ya bas timing?`;
    },
  },
  {
    weight: 13,
    build: (c) => {
      const ref = c.productName
        ? ` ${c.productName} ke baare mein check kar rahi thi jo aap dekh rahe the.`
        : '';
      return `Hello, ${AGENT_NAME} bol rahi hoon ${BUSINESS_NAME} se —${ref} use complete karna chahenge, ya kuch clear karna ho toh bataiye?`;
    },
  },
];

function pickWeighted(ctx: OpenerContext, templates: OpenerTemplate[], fallback: string): string {
  const candidates = templates
    .map((t) => ({ weight: t.weight, text: t.build(ctx) }))
    .filter((c): c is { weight: number; text: string } => c.text !== null);
  if (candidates.length === 0) {
    return fallback;
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
  /** Language the agent opens in. Defaults to English. Runtime turns still
   *  adapt to the customer's own language regardless of this. */
  language?: OpenerLanguage;
}

/**
 * Authoritative opener generator. Inbound returns a fixed greet. Outbound
 * loads the live product + active offer from Postgres and renders one
 * weighted-random template from the pool for the chosen language.
 */
export async function generateOpener(input: GenerateOpenerInput): Promise<string> {
  const language: OpenerLanguage = input.language === 'hi' ? 'hi' : 'en';

  if (input.mode === 'INBOUND_PRESALES') {
    return language === 'hi'
      ? `${BUSINESS_NAME} se ${AGENT_NAME} bol rahi hoon — kaise help kar sakti hoon?`
      : `${BUSINESS_NAME}, this is ${AGENT_NAME} — how can I help?`;
  }

  const product = input.productId ? getProductById(input.productId) : null;
  const productName = product?.name ?? null;
  const activeOffer = input.productId ? await loadActiveOfferForProduct(input.productId) : null;

  const templates = language === 'hi' ? OUTBOUND_OPENERS_HI : OUTBOUND_OPENERS_EN;
  const fallback =
    language === 'hi'
      ? `Hello, main ${AGENT_NAME} bol rahi hoon ${BUSINESS_NAME} se.`
      : `Hi, this is ${AGENT_NAME} from ${BUSINESS_NAME}.`;
  return pickWeighted({ mode: input.mode, productName, activeOffer }, templates, fallback);
}
