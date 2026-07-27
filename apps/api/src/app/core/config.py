from functools import lru_cache

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    anthropic_api_key: str = ""

    ai_model: str = "claude-opus-4-8"
    ai_effort: str = "medium"
    ai_max_tokens: int = 2048
    # Phase 2 structured endpoints (clean/insights/charts) return larger JSON.
    ai_structured_max_tokens: int = 8192
    ai_daily_token_budget: int = 200_000

    # Schema context is capped before it reaches the prompt; see ai/serializer.py
    ai_schema_context_max_chars: int = 24_000

    # Phase 3 conversational analyst
    ai_chat_max_tokens: int = 4096
    ai_chat_max_turns: int = 40
    ai_chat_max_tool_calls_per_turn: int = 15
    ai_chat_session_token_budget: int = 150_000
    ai_chat_session_ttl_seconds: int = 3600
    ai_chat_tool_result_max_chars: int = 20_000

    cors_origins: str = "http://localhost:3000"

    @property
    def cors_origin_list(self) -> list[str]:
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]


@lru_cache
def get_settings() -> Settings:
    return Settings()
