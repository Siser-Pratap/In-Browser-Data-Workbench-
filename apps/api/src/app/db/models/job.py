"""Background job records (Backend Phase 3).

Every asynchronous unit of work — compute queries, exports, purges, cleanup —
gets a row here. The queue (ARQ/Redis) is the transport; this table is the
durable record the API reads for status, so job history survives a Redis flush.
"""

import datetime as dt
import uuid

from sqlalchemy import (
    BigInteger,
    Date,
    DateTime,
    ForeignKey,
    Integer,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.orm import Mapped, mapped_column

from ..base import Base, TimestampMixin, UUIDMixin
from .workspace import JsonCol

# Status transitions: queued -> running -> succeeded | failed | cancelled.
# `failed` is terminal only once attempts are exhausted; a retryable failure
# goes back to `queued`.
STATUSES = ("queued", "running", "succeeded", "failed", "cancelled")
TERMINAL_STATUSES = ("succeeded", "failed", "cancelled")


class Job(UUIDMixin, TimestampMixin, Base):
    __tablename__ = "jobs"

    # Null for system jobs (purge, cleanup) that no user asked for.
    user_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), index=True, nullable=True
    )
    workspace_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("workspaces.id", ondelete="CASCADE"), index=True, nullable=True
    )
    kind: Mapped[str] = mapped_column(String(50), index=True, nullable=False)
    status: Mapped[str] = mapped_column(String(20), default="queued", index=True, nullable=False)
    progress: Mapped[int] = mapped_column(Integer, default=0, nullable=False)

    # What the worker needs to run, and what it produced.
    params: Mapped[dict] = mapped_column(JsonCol, default=dict, nullable=False)
    result: Mapped[dict] = mapped_column(JsonCol, default=dict, nullable=False)

    error: Mapped[str | None] = mapped_column(Text, nullable=True)
    attempts: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    max_attempts: Mapped[int] = mapped_column(Integer, default=3, nullable=False)

    started_at: Mapped[dt.datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    finished_at: Mapped[dt.datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    # Set when a job exhausts its attempts; the dead-letter record for on-call.
    dead_lettered_at: Mapped[dt.datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )


class UsageDaily(UUIDMixin, TimestampMixin, Base):
    """One row per user per day: what they used, rolled up.

    Derived data — it could be recomputed from `jobs` and `datasets` — but those
    are pruned (jobs after a week), so without a rollup the history is gone.
    Billing and capacity questions need the series to outlive its sources.
    """

    __tablename__ = "usage_daily"
    __table_args__ = (UniqueConstraint("user_id", "day", name="uq_usage_user_day"),)

    user_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), index=True, nullable=False
    )
    day: Mapped[dt.date] = mapped_column(Date, index=True, nullable=False)

    compute_jobs: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    compute_seconds: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    compute_rows: Mapped[int] = mapped_column(BigInteger, default=0, nullable=False)
    compute_result_bytes: Mapped[int] = mapped_column(BigInteger, default=0, nullable=False)
    jobs_failed: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    # Point-in-time, not a sum: how much was stored at the end of that day.
    storage_bytes: Mapped[int] = mapped_column(BigInteger, default=0, nullable=False)
