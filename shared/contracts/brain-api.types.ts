export enum ObjectionType {
  PRICE = 'PRICE',
  TRUST = 'TRUST',
  CONFUSION = 'CONFUSION',
  TIMING = 'TIMING',
  POSITIVE_SIGNAL = 'POSITIVE_SIGNAL',
  NEUTRAL = 'NEUTRAL',
}

export enum ConversationStage {
  INTRO = 'INTRO',
  PITCH = 'PITCH',
  OBJECTION = 'OBJECTION',
  NEGOTIATION = 'NEGOTIATION',
  CLOSE = 'CLOSE',
  END = 'END',
}

export interface ConversationTurn {
  speaker: 'USER' | 'AGENT';
  utterance: string;
  timestamp: string; // ISO 8601
}

export interface ProductContext {
  product_id: string;
  name: string;
  price: number;
  description: string;
  key_features: string[];
}

export interface ClassifyObjectionRequest {
  call_id: string;
  utterance: string;
  stage: ConversationStage;
  score: number;
}

export interface ClassifyObjectionResponse {
  objection_type: ObjectionType;
  confidence: number; // 0.0 to 1.0
  sentiment: 'POSITIVE' | 'NEGATIVE' | 'NEUTRAL';
  // B-2: fine-grained sub-type — populated by the Pinecone classifier path,
  // null on LLM fallback. Examples per objection_type:
  //   PRICE: 'too_expensive' | 'found_cheaper' | 'budget' | 'bad_value'
  //          | 'wants_discount' | 'sticker_shock' | 'high_intent' | ...
  //   TRUST: 'brand_unknown' | 'quality_doubt' | 'reviews_concern'
  //          | 'refund_policy' | 'warranty' | 'scam_fear' | ...
  //   TIMING: 'not_now' | 'spouse_decision' | 'wait_for_sale'
  //           | 'comparison_shopping' | 'busy' | 'season_wrong' | 'ready_now'
  //   CONFUSION: 'feature_unclear' | 'how_works' | 'comparison_unclear' | 'fit_size'
  //   POSITIVE_SIGNAL: 'interested' | 'ready_to_buy' | 'asking_logistics'
  //                    | 'compliment' | 'agreement'
  //   NEUTRAL: 'backchannel' | 'acknowledgment'
  subtype?: string | null;
}

export interface GenerateResponseRequest {
  call_id: string;
  utterance: string;
  stage: ConversationStage;
  score: number;
  discount_available: number;
  objection_type: ObjectionType | null;
  conversation_history: ConversationTurn[]; // last 4 turns only
  product_context: ProductContext | null;
  alternative_product_context?: ProductContext | null;
}

export interface GenerateResponseResponse {
  text: string;
}
