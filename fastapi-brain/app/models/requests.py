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
    discounts_already_offered: list[int] = []  # e.g. [] | [5] | [5, 10]
    # Agent identity for the proactive opener. The LLM uses these to introduce
    # itself naturally on the first turn ("Hi Sarah, this is Alex from ShopEase...").
    agent_name: str = "Alex"
    business_name: str = "ShopEase"
    # The discount the agent can offer up front on the opener as a
    # call-completion incentive. Defaults to 5%; absolute cap remains 10%.
    opening_offer_percent: int = 5
