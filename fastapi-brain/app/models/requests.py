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


class AlternativesRequest(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    query: str
    exclude_id: str
    current_price: float | None = None
    top_k: int = 3
