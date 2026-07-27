"""Workspace persistence models (Backend Phase 2).

Roles and storage modes are plain `String` columns rather than native DB enums:
the same models run on PostgreSQL and on SQLite in tests, and native enums make
Alembic migrations painful to evolve. The allowed values live in the Pydantic
schemas, which are what actually guard the write path.
"""

import datetime as dt
import uuid

from sqlalchemy import (
    JSON,
    BigInteger,
    Boolean,
    DateTime,
    ForeignKey,
    Integer,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column, relationship

from ..base import Base, TimestampMixin, UUIDMixin

# JSONB on Postgres (indexable, compact), plain JSON on SQLite in tests.
JsonCol = JSON().with_variant(JSONB, "postgresql")


class Workspace(UUIDMixin, TimestampMixin, Base):
    __tablename__ = "workspaces"

    owner_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), index=True, nullable=False
    )
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    is_public: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    # Unguessable capability token; null until the owner shares the workspace.
    share_token: Mapped[str | None] = mapped_column(
        String(64), unique=True, index=True, nullable=True
    )
    # When true, a share link may also hand out download tokens for uploaded rows.
    share_includes_data: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    settings: Mapped[dict] = mapped_column(JsonCol, default=dict, nullable=False)
    # Soft delete with 30-day retention; the purge job lands in Phase 3.
    deleted_at: Mapped[dt.datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    datasets: Mapped[list["Dataset"]] = relationship(
        back_populates="workspace", cascade="all, delete-orphan", lazy="selectin"
    )
    queries: Mapped[list["Query"]] = relationship(
        back_populates="workspace", cascade="all, delete-orphan", lazy="selectin"
    )
    charts: Mapped[list["Chart"]] = relationship(
        back_populates="workspace", cascade="all, delete-orphan", lazy="selectin"
    )
    dashboards: Mapped[list["Dashboard"]] = relationship(
        back_populates="workspace", cascade="all, delete-orphan", lazy="selectin"
    )
    members: Mapped[list["WorkspaceMember"]] = relationship(
        back_populates="workspace", cascade="all, delete-orphan", lazy="selectin"
    )


class Dataset(UUIDMixin, TimestampMixin, Base):
    __tablename__ = "datasets"

    workspace_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("workspaces.id", ondelete="CASCADE"), index=True, nullable=False
    )
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    source_filename: Mapped[str | None] = mapped_column(String(500), nullable=True)
    format: Mapped[str | None] = mapped_column(String(20), nullable=True)
    # {"columns": [{"name": ..., "type": ...}, ...]} — rows are never stored here.
    schema_json: Mapped[dict] = mapped_column("schema", JsonCol, default=dict, nullable=False)
    row_count: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    byte_size: Mapped[int | None] = mapped_column(BigInteger, nullable=True)
    # "local_only" (default — metadata only) or "uploaded" (explicit opt-in).
    storage_mode: Mapped[str] = mapped_column(String(20), default="local_only", nullable=False)
    storage_key: Mapped[str | None] = mapped_column(String(500), nullable=True)
    checksum: Mapped[str | None] = mapped_column(String(128), nullable=True)

    workspace: Mapped[Workspace] = relationship(back_populates="datasets")


class Query(UUIDMixin, TimestampMixin, Base):
    __tablename__ = "queries"

    workspace_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("workspaces.id", ondelete="CASCADE"), index=True, nullable=False
    )
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    sql: Mapped[str] = mapped_column(Text, nullable=False)
    position: Mapped[int] = mapped_column(Integer, default=0, nullable=False)

    workspace: Mapped[Workspace] = relationship(back_populates="queries")


class Chart(UUIDMixin, TimestampMixin, Base):
    __tablename__ = "charts"

    workspace_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("workspaces.id", ondelete="CASCADE"), index=True, nullable=False
    )
    # Charts can be free-standing; deleting a query detaches rather than deletes.
    query_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("queries.id", ondelete="SET NULL"), nullable=True
    )
    # Frontend's versioned chart-spec JSON: opaque here, envelope validated.
    spec: Mapped[dict] = mapped_column(JsonCol, default=dict, nullable=False)

    workspace: Mapped[Workspace] = relationship(back_populates="charts")


class Dashboard(UUIDMixin, TimestampMixin, Base):
    __tablename__ = "dashboards"

    workspace_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("workspaces.id", ondelete="CASCADE"), index=True, nullable=False
    )
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    layout: Mapped[dict] = mapped_column(JsonCol, default=dict, nullable=False)

    workspace: Mapped[Workspace] = relationship(back_populates="dashboards")


class WorkspaceMember(UUIDMixin, TimestampMixin, Base):
    __tablename__ = "workspace_members"
    __table_args__ = (UniqueConstraint("workspace_id", "user_id", name="uq_member_workspace_user"),)

    workspace_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("workspaces.id", ondelete="CASCADE"), index=True, nullable=False
    )
    user_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("users.id", ondelete="CASCADE"), index=True, nullable=False
    )
    # "viewer" | "editor" — v1 only ever writes "viewer".
    role: Mapped[str] = mapped_column(String(20), default="viewer", nullable=False)

    workspace: Mapped[Workspace] = relationship(back_populates="members")


class ActivityLog(UUIDMixin, Base):
    __tablename__ = "activity_log"

    workspace_id: Mapped[uuid.UUID] = mapped_column(
        ForeignKey("workspaces.id", ondelete="CASCADE"), index=True, nullable=False
    )
    # Null for anonymous share-link visitors.
    user_id: Mapped[uuid.UUID | None] = mapped_column(
        ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    action: Mapped[str] = mapped_column(String(50), nullable=False)
    payload: Mapped[dict] = mapped_column(JsonCol, default=dict, nullable=False)
    created_at: Mapped[dt.datetime] = mapped_column(
        DateTime(timezone=True), default=lambda: dt.datetime.now(dt.UTC), nullable=False
    )
