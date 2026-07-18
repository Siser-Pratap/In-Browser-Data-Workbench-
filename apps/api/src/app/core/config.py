from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    anthropic_api_key: str = ""

    ai_model: str = "claude-opus-4-8"
    ai_effort: str = "medium"
    ai_max_tokens: int = 2048
    ai_daily_token_budget: int = 200_000

    # Schema context is capped before it reaches the prompt; see ai/serializer.py
    ai_schema_context_max_chars: int = 24_000

    cors_origins: str = "http://localhost:3000"

    @property
    def cors_origin_list(self) -> list[str]:
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]


@lru_cache
def get_settings() -> Settings:
    return Settings()
