from typing import Literal

from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    port: int = 8000
    environment: Literal["development", "production", "test"] = "development"
    openai_api_key: str
    openai_model: str = "gpt-4o"
    database_url: str
    node_gateway_url: str
    internal_service_secret: str
    log_level: str = "info"
    pinecone_api_key: str | None = None
    pinecone_index_name: str = "voice-agent-products"

    model_config = {"env_file": (".env", "../.env"), "case_sensitive": False, "extra": "ignore"}


settings = Settings()
