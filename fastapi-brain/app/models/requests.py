from enum import StrEnum

from pydantic import BaseModel, ConfigDict


class ObjectionType(StrEnum):
    PRICE = "PRICE"
    TRUST = "TRUST"
    CONFUSION = "CONFUSION"
    TIMING = "TIMING"
    POSITIVE_SIGNAL = "POSITIVE_SIGNAL"
    NEUTRAL = "NEUTRAL"


class ConversationStage(StrEnum):
    INTRO = "INTRO"
    PITCH = "PITCH"
    OBJECTION = "OBJECTION"
    NEGOTIATION = "NEGOTIATION"
    CLOSE = "CLOSE"
    END = "END"


class ConversationTurn(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    speaker: str  # 'USER' | 'AGENT'
    utterance: str
    timestamp: str  # ISO 8601


class ProductContext(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    product_id: str
    name: str
    price: float
    description: str
    key_features: list[str]


class ClassifyObjectionRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    call_id: str
    utterance: str
    stage: ConversationStage
    score: int


class GenerateResponseRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    call_id: str
    utterance: str
    stage: ConversationStage
    score: int
    discount_available: int
    objection_type: ObjectionType | None = None
    conversation_history: list[ConversationTurn]
    product_context: ProductContext | None = None
    alternative_product_context: ProductContext | None = None


class AlternativesRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    query: str
    exclude_id: str
    current_price: float | None = None
    top_k: int = 3


class GenerateTacticRequest(BaseModel):
    """Tactic-driven generation. Caller has already run /classify and /decide
    (or chosen a tactic some other way) and is now asking the brain to express
    that tactic as natural voice speech."""

    model_config = ConfigDict(populate_by_name=True)

    call_id: str
    utterance: str  # what the customer just said
    tactic: str  # one of services/tactics.py Tactic values
    micro_guidance: str  # the per-tactic guidance from services/tactics.py
    conversation_history: list[ConversationTurn] = []
    product_context: ProductContext | None = None
    alternative_product_context: ProductContext | None = None
    discount_available: int = 0


class DecideRequest(BaseModel):
    """Inputs the rules engine needs to pick a tactic. Built by node-gateway
    from live session state + the latest classifier output."""

    model_config = ConfigDict(populate_by_name=True)

    call_id: str
    objection_type: ObjectionType | None = None
    objection_subtype: str | None = None
    sentiment: str | None = None  # 'POSITIVE' | 'NEGATIVE' | 'NEUTRAL'
    stage: ConversationStage
    score: int
    turn_count: int = 0
    prior_objection_types: list[ObjectionType] = []
    discounts_offered: list[int] = []
    has_alternative_product: bool = False
