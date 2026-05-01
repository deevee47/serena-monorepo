from typing import Literal

from pydantic import BaseModel, ConfigDict

from app.models.requests import ObjectionType, ProductContext


class ClassifyObjectionResponse(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    objection_type: ObjectionType
    confidence: float  # 0.0 to 1.0
    sentiment: Literal['POSITIVE', 'NEGATIVE', 'NEUTRAL']
    # B-2: fine-grained sub-type within the objection. Pinecone path returns it;
    # LLM fallback leaves it null. Examples: PRICE -> 'too_expensive' |
    # 'found_cheaper' | 'budget' | 'bad_value' | 'wants_discount' | 'sticker_shock'.
    subtype: str | None = None


class GenerateResponseResponse(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    text: str


class AlternativesResponse(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    alternatives: list[ProductContext]
