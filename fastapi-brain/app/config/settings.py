from typing import Literal

from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    port: int = 8000
    environment: Literal["development", "production", "test"] = "development"
    openai_api_key: str | None = None
    openai_model: str = "gpt-4o"
    openai_classifier_model: str = "gpt-4o-mini"
    database_url: str
    node_gateway_url: str = "http://127.0.0.1:3000"
    internal_service_secret: str
    log_level: str = "info"
    pinecone_api_key: str
    pinecone_index_name: str = "voice-agent-products"

    pinecone_objections_index_name: str = "voice-agent-objections"
    classifier_mode: Literal["pinecone", "llm", "shadow"] = "shadow"
    classifier_confidence_threshold: float = 0.78
    classifier_top1_strict_threshold: float = 0.85

    model_config = {"env_file": (".env", "../.env"), "case_sensitive": False, "extra": "ignore"}

    @property
    def llm_api_key(self) -> str:
        if self.openai_api_key:
            return self.openai_api_key
        raise ValueError("Set OPENAI_API_KEY for the FastAPI brain")


settings = Settings()
