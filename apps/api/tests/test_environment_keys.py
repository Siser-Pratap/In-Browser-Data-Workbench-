"""The per-environment Gemini key switch.

This decides which API key gets spent, so the rules are pinned rather than
assumed — particularly the absence of a fallback, which is a deliberate choice
and exactly the kind of thing a later "helpful" change would undo.
"""

import pytest
from pydantic import ValidationError

from app.core.config import Settings


def settings(**overrides) -> Settings:
    # `_env_file=None` so a developer's own .env can't change the outcome.
    return Settings(_env_file=None, **overrides)


def test_defaults_to_production() -> None:
    # A deployment that sets nothing should use the primary key, not the dev one.
    assert settings().environment == "production"


def test_production_uses_the_production_key() -> None:
    config = settings(
        environment="production", gemini_api_key="prod-key", gemini_api_key_dev="dev-key"
    )
    assert config.active_gemini_api_key == "prod-key"
    assert config.ai_unconfigured_reason is None


def test_development_uses_the_dev_key() -> None:
    config = settings(
        environment="development", gemini_api_key="prod-key", gemini_api_key_dev="dev-key"
    )
    assert config.active_gemini_api_key == "dev-key"
    assert config.ai_unconfigured_reason is None


def test_development_never_falls_back_to_the_production_key() -> None:
    # The point of the split: a dev machine cannot quietly bill production.
    config = settings(environment="development", gemini_api_key="prod-key", gemini_api_key_dev="")
    assert config.active_gemini_api_key == ""
    assert config.ai_unconfigured_reason is not None


def test_production_never_falls_back_to_the_dev_key() -> None:
    # The mirror image, and the more surprising direction: a production deploy
    # that only had a dev key set should fail loudly, not run on it.
    config = settings(environment="production", gemini_api_key="", gemini_api_key_dev="dev-key")
    assert config.active_gemini_api_key == ""
    assert config.ai_unconfigured_reason is not None


def test_development_reason_names_the_variable_to_set() -> None:
    # "AI is not configured" with two keys in play is not actionable; the two
    # ways to fix it have to be in the message.
    reason = settings(environment="development").ai_unconfigured_reason
    assert reason is not None
    assert "GEMINI_API_KEY_DEV" in reason
    assert "ENVIRONMENT=production" in reason


def test_production_reason_is_the_plain_message() -> None:
    reason = settings(environment="production").ai_unconfigured_reason
    assert reason == "AI is not configured on this server."


def test_unknown_environment_is_rejected_at_startup() -> None:
    # Fail fast: a typo'd ENVIRONMENT decides which key is spent, so it must not
    # silently resolve to either branch.
    with pytest.raises(ValidationError):
        settings(environment="staging")


def test_is_development_flag_tracks_the_setting() -> None:
    assert settings(environment="development").is_development is True
    assert settings(environment="production").is_development is False
