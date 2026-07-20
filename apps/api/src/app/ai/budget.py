"""Per-user daily token budget.

In-memory for AI Phase 1 — moves to Redis when Backend Phase 1 lands so budgets
survive restarts and apply across workers.
"""

import datetime as dt
from dataclasses import dataclass, field


class BudgetExceededError(Exception):
    def __init__(self, limit: int) -> None:
        self.limit = limit
        super().__init__(
            f"Daily AI token budget of {limit} tokens exhausted. Resets at midnight UTC."
        )


@dataclass
class TokenBudget:
    daily_limit: int
    _usage: dict[str, tuple[dt.date, int]] = field(default_factory=dict)

    def _today(self) -> dt.date:
        return dt.datetime.now(dt.UTC).date()

    def used(self, user_id: str) -> int:
        day, tokens = self._usage.get(user_id, (self._today(), 0))
        return tokens if day == self._today() else 0

    def check(self, user_id: str) -> None:
        if self.used(user_id) >= self.daily_limit:
            raise BudgetExceededError(self.daily_limit)

    def record(self, user_id: str, tokens: int) -> None:
        self._usage[user_id] = (self._today(), self.used(user_id) + tokens)
