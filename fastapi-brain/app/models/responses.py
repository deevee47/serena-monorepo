from typing import Any, Literal

from pydantic import BaseModel, ConfigDict

from app.models.requests import ObjectionType, ProductContext


class ClassifyObjectionResponse(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    objection_type: ObjectionType
    confidence: float  # 0.0 to 1.0
    sentiment: Literal['POSITIVE', 'NEGATIVE', 'NEUTRAL']
    # Fine-grained sub-type within the objection. Pinecone path returns it;
    # LLM fallback leaves it null. Examples: PRICE -> 'too_expensive' |
    # 'found_cheaper' | 'budget' | 'bad_value' | 'wants_discount' | 'sticker_shock'.
    subtype: str | None = None


class GenerateResponseResponse(BaseModel):
    """Plain-text response. Used by both legacy /generate (until removed)
    and the converse blocking endpoint when the LLM emits no tool call."""

    model_config = ConfigDict(populate_by_name=True)

    text: str


class AlternativesResponse(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    alternatives: list[ProductContext]


class ConverseToolCall(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    name: str
    args: dict[str, Any]


class ConverseResponse(BaseModel):
    """Non-streaming converse result. The LLM may have spoken, called a tool,
    or both. Streaming clients should use POST /converse/stream instead."""

    model_config = ConfigDict(populate_by_name=True)

    text: str  # may be empty if the LLM only called a tool
    tool_call: ConverseToolCall | None = None
    finish_reason: str | None = None
