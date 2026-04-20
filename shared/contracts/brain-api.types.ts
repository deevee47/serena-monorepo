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
}

export interface GenerateResponseResponse {
  text: string;
}
