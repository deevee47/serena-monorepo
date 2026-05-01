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


class CartItem(BaseModel):
    """A line item in the customer's abandoned cart. Demo-grade — real
    integrations should source this from the storefront's cart service."""

    model_config = ConfigDict(populate_by_name=True)

    product_id: str
    name: str
    price: float
    quantity: int = 1


class CartContext(BaseModel):
    """The customer's cart at the moment the agent picked up the call."""

    model_config = ConfigDict(populate_by_name=True)

    items: list[CartItem]
    total: float
    abandoned_minutes_ago: int | None = None


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


class ConverseRequest(BaseModel):
    """Single-call function-calling LLM converse request. The LLM gets the
    conversation history, the product/cart facts, and the tool schemas — it
    decides whether to talk, call a tool, or both."""

    model_config = ConfigDict(populate_by_name=True)

    call_id: str
    utterance: str  # what the customer just said
    conversation_history: list[ConversationTurn] = []
    product_context: ProductContext | None = None
    alternative_product_context: ProductContext | None = None
    cart_context: CartContext | None = None
    discounts_already_offered: list[int] = []  # e.g. [] | [5] | [5, 10]


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
    # Voice-channel signals (B-5). All optional — when missing, signal-driven
    # rules in decide() are skipped and behavior is identical to pre-B-5.
    utterance_length_trend: float | None = None
    filler_density: float | None = None
    response_latency_ms: int | None = None
    # When True, the rules engine will pick SEND_*_WHATSAPP tactics on close /
    # graceful-exit instead of pure verbal moves. Default False so existing
    # callers see no behavior change.
    whatsapp_available: bool = False
