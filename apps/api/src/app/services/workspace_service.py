"""Workspace persistence: CRUD, snapshot sync, sharing and forking."""

from __future__ import annotations

import datetime as dt
import hashlib
import secrets
import uuid
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from ..db.models import (
    ActivityLog,
    Chart,
    Dashboard,
    Dataset,
    Query,
    User,
    Workspace,
)
from ..schemas.workspace import (
    ChartIn,
    DashboardIn,
    DatasetIn,
    QueryIn,
    SnapshotIn,
    WorkspaceCreate,
    WorkspaceUpdate,
)
from .errors import AuthError
from .permissions import NotVisible


class VersionConflict(AuthError):
    """The client's `If-Match` didn't match the stored version."""

    status_code = 409
    code = "version_conflict"


class QuotaExceeded(AuthError):
    status_code = 413
    code = "quota_exceeded"


def version_of(workspace: Workspace) -> str:
    """Opaque ETag derived from the row's last write.

    A hash rather than the raw timestamp so clients can't infer anything from
    it and can't hand-craft a matching value.
    """
    stamp = workspace.updated_at.isoformat() if workspace.updated_at else "new"
    return hashlib.sha256(f"{workspace.id}:{stamp}".encode()).hexdigest()[:32]


def touch(workspace: Workspace) -> None:
    """Bump the version stamp.

    SQLAlchemy's `onupdate` only fires when a mapped column actually changed; a
    save that only touched child rows must still invalidate the client's ETag.
    """
    workspace.updated_at = dt.datetime.now(dt.UTC)


def _uuid_or_none(value: str | None) -> uuid.UUID | None:
    if not value:
        return None
    try:
        return uuid.UUID(value)
    except (ValueError, TypeError):
        return None


class WorkspaceService:
    def __init__(self, share_base_url: str = "", storage_quota_bytes: int = 1024**3) -> None:
        self.share_base_url = share_base_url.rstrip("/")
        self.storage_quota_bytes = storage_quota_bytes

    # -- lookups -------------------------------------------------------------

    async def get(self, db: AsyncSession, workspace_id: str) -> Workspace:
        """Fetch by id. Soft-deleted rows are returned too — `permissions.can`
        decides whether this caller (the owner, restoring it) may see one."""
        wid = _uuid_or_none(workspace_id)
        if wid is None:
            raise NotVisible()
        workspace = (
            await db.execute(select(Workspace).where(Workspace.id == wid))
        ).scalar_one_or_none()
        if workspace is None:
            raise NotVisible()
        return workspace

    async def get_by_share_token(self, db: AsyncSession, token: str) -> Workspace:
        workspace = (
            await db.execute(select(Workspace).where(Workspace.share_token == token))
        ).scalar_one_or_none()
        if workspace is None or workspace.deleted_at is not None:
            raise NotVisible()
        return workspace

    async def list_for_user(
        self, db: AsyncSession, user: User, *, limit: int = 50, offset: int = 0
    ) -> tuple[list[Workspace], int]:
        base = select(Workspace).where(
            Workspace.owner_id == user.id, Workspace.deleted_at.is_(None)
        )
        total = (
            await db.execute(
                select(func.count()).select_from(base.subquery())
            )
        ).scalar_one()
        rows = (
            await db.execute(
                base.order_by(Workspace.updated_at.desc()).limit(limit).offset(offset)
            )
        ).scalars()
        return list(rows), int(total)

    # -- CRUD ----------------------------------------------------------------

    async def create(self, db: AsyncSession, user: User, body: WorkspaceCreate) -> Workspace:
        workspace = Workspace(
            owner_id=user.id,
            name=body.name,
            description=body.description,
            settings=body.settings,
        )
        db.add(workspace)
        await db.commit()
        await db.refresh(workspace)
        return workspace

    async def update(
        self, db: AsyncSession, workspace: Workspace, body: WorkspaceUpdate
    ) -> Workspace:
        if body.name is not None:
            workspace.name = body.name
        if body.description is not None:
            workspace.description = body.description
        if body.settings is not None:
            workspace.settings = body.settings
        touch(workspace)
        await db.commit()
        await db.refresh(workspace)
        return workspace

    async def soft_delete(self, db: AsyncSession, workspace: Workspace) -> None:
        """Soft delete with 30-day retention; the purge job runs in Phase 3."""
        workspace.deleted_at = dt.datetime.now(dt.UTC)
        # A deleted workspace must stop being reachable by its share link.
        workspace.share_token = None
        workspace.is_public = False
        await db.commit()

    # -- snapshot sync -------------------------------------------------------

    async def load_snapshot(self, db: AsyncSession, workspace: Workspace) -> dict[str, Any]:
        async def children(model):
            return list(
                (
                    await db.execute(select(model).where(model.workspace_id == workspace.id))
                ).scalars()
            )

        queries = sorted(await children(Query), key=lambda q: (q.position, q.created_at))
        return {
            "workspace": workspace,
            "datasets": await children(Dataset),
            "queries": queries,
            "charts": await children(Chart),
            "dashboards": await children(Dashboard),
        }

    async def save_snapshot(
        self,
        db: AsyncSession,
        workspace: Workspace,
        body: SnapshotIn,
        *,
        if_match: str | None = None,
    ) -> dict[str, Any]:
        """Upsert the whole workspace document in one transaction.

        Rows the client didn't send are deleted — the snapshot is the complete
        desired state, which is what makes the local-first save story simple.
        """
        if if_match is not None and if_match.strip('"') != version_of(workspace):
            raise VersionConflict("Workspace was modified by another session")

        if body.name is not None:
            workspace.name = body.name
        if body.description is not None:
            workspace.description = body.description
        if body.settings is not None:
            workspace.settings = body.settings

        await self._sync_datasets(db, workspace, body.datasets)
        query_ids = await self._sync_queries(db, workspace, body.queries)
        await self._sync_charts(db, workspace, body.charts, query_ids)
        await self._sync_dashboards(db, workspace, body.dashboards)

        touch(workspace)
        await db.commit()
        await db.refresh(workspace)
        return await self.load_snapshot(db, workspace)

    async def _existing(self, db: AsyncSession, model, workspace: Workspace) -> dict:
        rows = (
            await db.execute(select(model).where(model.workspace_id == workspace.id))
        ).scalars()
        return {row.id: row for row in rows}

    async def _sync_datasets(
        self, db: AsyncSession, workspace: Workspace, incoming: list[DatasetIn]
    ) -> None:
        existing = await self._existing(db, Dataset, workspace)
        seen: set[uuid.UUID] = set()
        for item in incoming:
            row = existing.get(_uuid_or_none(item.id))
            if row is None:
                row = Dataset(workspace_id=workspace.id, id=_uuid_or_none(item.id) or uuid.uuid4())
                db.add(row)
            row.name = item.name
            row.source_filename = item.source_filename
            row.format = item.format
            row.schema_json = item.dataset_schema
            row.row_count = item.row_count
            row.byte_size = item.byte_size
            seen.add(row.id)
        for row_id, row in existing.items():
            # Never drop an uploaded dataset from a snapshot save: the client may
            # be a session that never saw it, and the S3 object would be orphaned.
            if row_id not in seen and row.storage_mode != "uploaded":
                await db.delete(row)

    async def _sync_queries(
        self, db: AsyncSession, workspace: Workspace, incoming: list[QueryIn]
    ) -> dict[str, uuid.UUID]:
        existing = await self._existing(db, Query, workspace)
        seen: set[uuid.UUID] = set()
        # Charts reference queries by the client's id; map it to the stored one.
        id_map: dict[str, uuid.UUID] = {}
        for position, item in enumerate(incoming):
            row = existing.get(_uuid_or_none(item.id))
            if row is None:
                row = Query(workspace_id=workspace.id, id=_uuid_or_none(item.id) or uuid.uuid4())
                db.add(row)
            row.name = item.name
            row.sql = item.sql
            row.position = item.position if item.position else position
            seen.add(row.id)
            if item.id:
                id_map[item.id] = row.id
        for row_id, row in existing.items():
            if row_id not in seen:
                await db.delete(row)
        return id_map

    async def _sync_charts(
        self,
        db: AsyncSession,
        workspace: Workspace,
        incoming: list[ChartIn],
        query_ids: dict[str, uuid.UUID],
    ) -> None:
        existing = await self._existing(db, Chart, workspace)
        seen: set[uuid.UUID] = set()
        for item in incoming:
            row = existing.get(_uuid_or_none(item.id))
            if row is None:
                row = Chart(workspace_id=workspace.id, id=_uuid_or_none(item.id) or uuid.uuid4())
                db.add(row)
            row.spec = item.spec
            row.query_id = query_ids.get(item.query_id or "") or _uuid_or_none(item.query_id)
            seen.add(row.id)
        for row_id, row in existing.items():
            if row_id not in seen:
                await db.delete(row)

    async def _sync_dashboards(
        self, db: AsyncSession, workspace: Workspace, incoming: list[DashboardIn]
    ) -> None:
        existing = await self._existing(db, Dashboard, workspace)
        seen: set[uuid.UUID] = set()
        for item in incoming:
            row = existing.get(_uuid_or_none(item.id))
            if row is None:
                row = Dashboard(
                    workspace_id=workspace.id, id=_uuid_or_none(item.id) or uuid.uuid4()
                )
                db.add(row)
            row.name = item.name
            row.layout = item.layout
            seen.add(row.id)
        for row_id, row in existing.items():
            if row_id not in seen:
                await db.delete(row)

    # -- sharing -------------------------------------------------------------

    async def share(
        self, db: AsyncSession, workspace: Workspace, *, include_data: bool
    ) -> Workspace:
        """Generate or rotate the share token. Rotating invalidates old links."""
        workspace.share_token = secrets.token_urlsafe(32)
        workspace.share_includes_data = include_data
        touch(workspace)
        await db.commit()
        await db.refresh(workspace)
        return workspace

    async def unshare(self, db: AsyncSession, workspace: Workspace) -> None:
        workspace.share_token = None
        workspace.share_includes_data = False
        workspace.is_public = False
        touch(workspace)
        await db.commit()

    def share_url(self, workspace: Workspace) -> str:
        return f"{self.share_base_url}/shared/{workspace.share_token}"

    async def fork(self, db: AsyncSession, source: Workspace, user: User) -> Workspace:
        """Copy a workspace into the caller's account.

        Metadata and specs only — uploaded raw files are not duplicated; the
        copy's datasets fall back to `local_only`.
        """
        snapshot = await self.load_snapshot(db, source)
        copy = Workspace(
            owner_id=user.id,
            name=f"{source.name} (copy)",
            description=source.description,
            settings=dict(source.settings or {}),
        )
        db.add(copy)
        await db.flush()

        query_map: dict[uuid.UUID, uuid.UUID] = {}
        for row in snapshot["datasets"]:
            db.add(
                Dataset(
                    workspace_id=copy.id,
                    name=row.name,
                    source_filename=row.source_filename,
                    format=row.format,
                    schema_json=row.schema_json,
                    row_count=row.row_count,
                    byte_size=row.byte_size,
                    storage_mode="local_only",
                )
            )
        for row in snapshot["queries"]:
            new_id = uuid.uuid4()
            query_map[row.id] = new_id
            db.add(
                Query(
                    id=new_id,
                    workspace_id=copy.id,
                    name=row.name,
                    sql=row.sql,
                    position=row.position,
                )
            )
        for row in snapshot["charts"]:
            db.add(
                Chart(
                    workspace_id=copy.id,
                    query_id=query_map.get(row.query_id) if row.query_id else None,
                    spec=dict(row.spec or {}),
                )
            )
        for row in snapshot["dashboards"]:
            db.add(
                Dashboard(workspace_id=copy.id, name=row.name, layout=dict(row.layout or {}))
            )

        await db.commit()
        await db.refresh(copy)
        return copy

    # -- activity ------------------------------------------------------------

    async def log(
        self,
        db: AsyncSession,
        workspace: Workspace,
        action: str,
        *,
        user: User | None = None,
        payload: dict[str, Any] | None = None,
    ) -> None:
        db.add(
            ActivityLog(
                workspace_id=workspace.id,
                user_id=user.id if user else None,
                action=action,
                payload=payload or {},
            )
        )
        await db.commit()

    # -- storage accounting --------------------------------------------------

    async def used_bytes(self, db: AsyncSession, user: User) -> tuple[int, int]:
        """(bytes stored, number of uploaded datasets) across the user's workspaces."""
        stmt = (
            select(func.coalesce(func.sum(Dataset.byte_size), 0), func.count(Dataset.id))
            .join(Workspace, Dataset.workspace_id == Workspace.id)
            .where(
                Workspace.owner_id == user.id,
                Workspace.deleted_at.is_(None),
                Dataset.storage_mode == "uploaded",
            )
        )
        used, count = (await db.execute(stmt)).one()
        return int(used or 0), int(count or 0)

    async def check_quota(self, db: AsyncSession, user: User, additional_bytes: int) -> None:
        used, _ = await self.used_bytes(db, user)
        if used + additional_bytes > self.storage_quota_bytes:
            raise QuotaExceeded(
                f"Upload would exceed your {self.storage_quota_bytes} byte storage quota"
            )

