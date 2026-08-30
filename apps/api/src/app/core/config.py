from functools import lru_cache
from typing import Literal

from pydantic_settings import BaseSettings, SettingsConfigDict

Environment = Literal["production", "development"]


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", env_file_encoding="utf-8", extra="ignore")

    # Which deployment this is. Typed rather than a free string: it decides
    # which API key gets spent, so a typo should stop the app at startup rather
    # than quietly resolve to the wrong one.
    #
    # Defaults to production so a deployment that sets nothing uses the primary
    # key; the dev compose file opts in to `development` explicitly.
    environment: Environment = "production"

    # -- AI ------------------------------------------------------------------
    # Two keys, picked by `environment` — see `active_gemini_api_key`. Splitting
    # them keeps local experimentation off the production quota and makes spend
    # attributable per environment.
    gemini_api_key: str = ""
    gemini_api_key_dev: str = ""

    # An alias rather than a pinned id, on purpose: a pinned model eventually
    # returns "no longer available to new users" — a 404 at runtime for a
    # default that used to work. The alias tracks the current Flash model, and
    # a deployment that wants reproducibility pins AI_MODEL explicitly.
    ai_model: str = "gemini-flash-latest"
    # Maps to Gemini's thinking level: "low" | "medium" | "high".
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

    # -- Database ------------------------------------------------------------
    # asyncpg in prod; tests override with an aiosqlite URL.
    database_url: str = "postgresql+asyncpg://workbench:workbench@localhost:5432/workbench"
    # Create tables on startup instead of running Alembic (dev/test only).
    db_auto_create: bool = False
    db_echo: bool = False

    # -- Auth / security -----------------------------------------------------
    # Set a strong value in production; a random one is generated if unset so
    # dev never runs on a hardcoded key, but tokens won't survive a restart.
    jwt_secret: str = ""
    access_token_ttl_seconds: int = 15 * 60
    refresh_token_ttl_seconds: int = 30 * 24 * 60 * 60
    email_verification_ttl_seconds: int = 24 * 60 * 60
    password_reset_ttl_seconds: int = 60 * 60

    refresh_cookie_name: str = "workbench_refresh"
    # Secure cookies over HTTPS in production; tests/dev over http set False.
    cookie_secure: bool = True
    cookie_samesite: str = "lax"
    cookie_domain: str | None = None

    # -- Rate limiting -------------------------------------------------------
    rate_limit_auth_per_minute: int = 10
    rate_limit_default_per_minute: int = 120

    # -- OAuth (optional; wired only when a provider's client id is present) --
    google_client_id: str = ""
    google_client_secret: str = ""
    github_client_id: str = ""
    github_client_secret: str = ""
    oauth_redirect_base: str = "http://localhost:8000"

    # -- Object storage (opt-in raw dataset uploads) -------------------------
    # Empty bucket = storage disabled; the endpoints then return 503 and the
    # rest of the API is unaffected.
    s3_bucket: str = ""
    s3_endpoint_url: str | None = None  # MinIO in dev; unset for real S3
    s3_region: str = "us-east-1"
    s3_access_key: str = ""
    s3_secret_key: str = ""
    s3_presign_ttl_seconds: int = 15 * 60
    storage_quota_bytes: int = 1024**3  # 1 GB per user
    storage_max_file_bytes: int = 2 * 1024**3  # 2 GB per file

    # -- Jobs & server-side compute (Phase 3) --------------------------------
    # Empty => jobs run in-process (dev/test). Set it in production so the ARQ
    # worker pool picks work up instead of the API process.
    redis_url: str = ""
    compute_memory_limit: str = "2GB"
    compute_threads: int = 2
    compute_timeout_seconds: int = 60
    compute_max_rows: int = 1_000_000
    compute_max_concurrent_per_user: int = 2

    # -- Platform ------------------------------------------------------------
    cors_origins: str = "http://localhost:3000"
    frontend_base_url: str = "http://localhost:3000"
    cors_origins: str = "http://localhost:3000"

    @property
    def cors_origin_list(self) -> list[str]:
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]

    @property
    def is_development(self) -> bool:
        return self.environment == "development"

    @property
    def active_gemini_api_key(self) -> str:
        """The key this environment is allowed to spend.

        **There is deliberately no fallback to the production key.** If
        `ENVIRONMENT=development` and `GEMINI_API_KEY_DEV` is unset, the AI
        endpoints report themselves unconfigured — exactly as they already do
        when no key is set at all — rather than quietly billing production from
        a developer's laptop. That silent fallback is the precise accident this
        split exists to prevent, and it is the kind you only discover on an
        invoice. Recovering is a one-line change either way: provide the dev
        key, or set `ENVIRONMENT=production`.
        """
        return self.gemini_api_key_dev if self.is_development else self.gemini_api_key

    @property
    def ai_unconfigured_reason(self) -> str | None:
        """Why the AI endpoints are off, or None when they are on.

        Returned to the caller so "nothing happens" is never the whole story —
        a missing dev key and a missing production key are different mistakes
        with different fixes.
        """
        if self.active_gemini_api_key:
            return None
        if self.is_development:
            return (
                "AI is not configured for the development environment. Set GEMINI_API_KEY_DEV, "
                "or set ENVIRONMENT=production to use GEMINI_API_KEY."
            )
        return "AI is not configured on this server."


@lru_cache
def get_settings() -> Settings:
    return Settings()
