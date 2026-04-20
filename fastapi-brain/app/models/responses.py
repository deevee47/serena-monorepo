from pydantic import BaseModel, ConfigDict

from app.models.requests import ObjectionType


class ClassifyObjectionResponse(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    objection_type: ObjectionType
    confidence: float  # 0.0 to 1.0


class GenerateResponseResponse(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    text: str
