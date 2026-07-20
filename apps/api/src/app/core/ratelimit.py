"""Fixed-window rate limiting.

In-memory implementation for Phase 1 dev/test; the interface is small so a
Redis-backed limiter (shared across workers) drops in for production. Returns a
FastAPI dependency that raises 429 with a Retry-After header when exceeded.
"""

import time
from collections import defaultdict

from fastapi import Depends, HTTPException, Request

from .config import Settings


class RateLimiter:
    def __init__(self) -> None:
        self._hits: dict[str, tuple[int, int]] = defaultdict(lambda: (0, 0))

    def check(self, key: str, limit: int, window_seconds: int = 60) -> None:
        window = int(time.time()) // window_seconds
        count, current_window = self._hits[key]
        if current_window != window:
            count, current_window = 0, window
        count += 1
        self._hits[key] = (count, current_window)
        if count > limit:
            retry_after = window_seconds - int(time.time()) % window_seconds
            raise HTTPException(
                status_code=429,
                detail="Too many requests. Slow down.",
                headers={"Retry-After": str(retry_after)},
            )


def _client_key(request: Request) -> str:
    return request.client.host if request.client else "unknown"


def rate_limit(scope: str, auth: bool = False):
    """Build a dependency limiting `scope` per client IP per minute."""

    def dependency(request: Request) -> None:
        limiter: RateLimiter = request.app.state.rate_limiter
        settings: Settings = request.app.state.settings
        limit = (
            settings.rate_limit_auth_per_minute
            if auth
            else settings.rate_limit_default_per_minute
        )
        limiter.check(f"{scope}:{_client_key(request)}", limit)

    return Depends(dependency)
