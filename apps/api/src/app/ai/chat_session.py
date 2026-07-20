"""In-memory chat session store.

Holds conversation state, known tables, per-session token accounting, and the
pending-tool bookkeeping needed to pause the agent loop for browser tool
execution and resume it. Moves to Redis (with TTL) alongside the rest of the
budget/state plumbing in Backend Phase 3; the interface is deliberately small so
that swap is contained.
"""

import datetime as dt
import secrets
from dataclasses import dataclass, field

from .schemas import TableSchema


class SessionNotFoundError(Exception):
    pass


class NotAwaitingToolsError(Exception):
    """The session is not paused waiting for tool results (or the ids mismatch)."""


@dataclass
class ChatSession:
    id: str
    user_id: str
    known_tables: list[str]
    title: str | None = None
    messages: list[dict] = field(default_factory=list)
    tokens_used: int = 0
    turns: int = 0
    tool_calls_this_turn: int = 0
    # Set while paused: the tool_use ids the browser must return, plus the
    # server-resolved results (invalid SQL) to merge with the client's.
    pending_ids: list[str] = field(default_factory=list)
    partial_results: list[dict] = field(default_factory=list)
    last_activity: dt.datetime = field(default_factory=lambda: dt.datetime.now(dt.UTC))

    @property
    def awaiting_tools(self) -> bool:
        return bool(self.pending_ids)

    def touch(self) -> None:
        self.last_activity = dt.datetime.now(dt.UTC)


class ChatSessionStore:
    def __init__(self, ttl_seconds: int) -> None:
        self.ttl = dt.timedelta(seconds=ttl_seconds)
        self._sessions: dict[str, ChatSession] = {}

    def create(self, user_id: str, tables: list[TableSchema], title: str | None) -> ChatSession:
        self._evict_expired()
        session = ChatSession(
            id="chat_" + secrets.token_urlsafe(12),
            user_id=user_id,
            known_tables=[t.name for t in tables],
            title=title,
        )
        self._sessions[session.id] = session
        return session

    def get(self, session_id: str, user_id: str) -> ChatSession:
        self._evict_expired()
        session = self._sessions.get(session_id)
        # Same "not found" for missing and cross-user access — never confirm existence.
        if session is None or session.user_id != user_id:
            raise SessionNotFoundError(session_id)
        session.touch()
        return session

    def _evict_expired(self) -> None:
        now = dt.datetime.now(dt.UTC)
        expired = [sid for sid, s in self._sessions.items() if now - s.last_activity > self.ttl]
        for sid in expired:
            del self._sessions[sid]
