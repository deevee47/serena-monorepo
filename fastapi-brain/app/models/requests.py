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
    """A line item in the customer's abandoned cart."""

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


class CustomerSegment(StrEnum):
    FIRST_TIME = "FIRST_TIME"
    RETURNING = "RETURNING"
    VIP = "VIP"
    LAPSED = "LAPSED"


class PastOrderSummary(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    product_id: str
    product_name: str
    price: float
    days_ago: int


class Sentiment(StrEnum):
    POSITIVE = "POSITIVE"
    NEGATIVE = "NEGATIVE"
    NEUTRAL = "NEUTRAL"


class RecentUserSignals(BaseModel):
    """Small snapshot of recent USER-turn behavior the prompt can adapt to.

    Sourced async (via the classify-analytics worker) on the gateway side and
    forwarded per turn. Missing values just degrade the signal — never block.
    """

    model_config = ConfigDict(populate_by_name=True)

    sentiments: list[Sentiment] = []  # oldest-first across the last 3 USER turns
    filler_density: float | None = None  # 0.0 – 1.0
    length_trend: float | None = None    # tokens-per-turn slope across recent turns
    repeated_objection: str | None = None  # objection_type repeated on consecutive turns
    # Explicit 1..5 persistence counter — set by the gateway from session
    # state so the prompt knows exactly which attempt the LLM is on instead of
    # inferring it from the transcript. Resets on FAST_TRACK confirmation or
    # a positive sentiment swing.
    push_attempt: int | None = None
    # Pre-response latency on the immediately prior USER turn, in ms. Very low
    # (<500) = visceral; high (>5000) = distracted/considering. Sourced from
    # provider webhook timestamps.
    response_latency_ms: int | None = None


class CustomerContext(BaseModel):
    """Everything the agent should know about who it's talking to before
    saying anything. Sourced from the Customer + Purchase + Call tables.

    All fields except phone are optional — first-time unknown callers will
    have only phone populated, and the prompt builder degrades gracefully."""

    model_config = ConfigDict(populate_by_name=True)

    phone: str
    name: str | None = None
    email: str | None = None
    segment: CustomerSegment = CustomerSegment.FIRST_TIME
    lifetime_value: float = 0.0
    prior_calls_count: int = 0
    timezone: str | None = None
    preferred_contact: str | None = None  # 'whatsapp' | 'email' | 'phone'
    past_orders: list[PastOrderSummary] = []  # most recent 5


class ClassifyObjectionRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    call_id: str
    utterance: str
    stage: ConversationStage
    score: int


class AlternativesRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    query: str
    exclude_id: str
    current_price: float | None = None
    top_k: int = 3
    # Soft category filter — restricts cheaper-alternative search to the
    # same product category. Stops $39 hoodies surfacing as alternatives
    # to $349 office chairs.
    category: str | None = None
    # Direction: 'cheaper' returns one alt below current_price (default
    # behavior). 'premium' returns one alt strictly ABOVE current_price —
    # used to anchor the current product as the right-sized choice.
    direction: str = "cheaper"


class ConverseRequest(BaseModel):
    """Single-call function-calling LLM converse request. The LLM gets the
    conversation history, the product/cart/customer facts, and the tool
    schemas — it decides whether to talk, call a tool, or both."""

    model_config = ConfigDict(populate_by_name=True)

    call_id: str
    utterance: str  # what the customer just said
    conversation_history: list[ConversationTurn] = []
    product_context: ProductContext | None = None
    alternative_product_context: ProductContext | None = None
    premium_product_context: ProductContext | None = None
    cart_context: CartContext | None = None
    customer_context: CustomerContext | None = None
    recent_user_signals: RecentUserSignals | None = None
    discounts_already_offered: list[int] = []  # e.g. [] | [5] | [5, 10]
    # Agent identity for the proactive opener. The LLM uses these to introduce
    # itself naturally on the first turn ("Hi Sarah, this is Serena from ShopEase...").
    # The agent is a woman; see _objective() in converse_prompt_builder for the
    # gender-grammar contract (matters in Hindi/Hinglish).
    agent_name: str = "Serena"
    business_name: str = "Muscleblaze"
    # The discount the agent can offer up front on the opener as a
    # call-completion incentive. Defaults to 5%; absolute cap remains 10%.
    opening_offer_percent: int = 5
