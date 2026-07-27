"""Central authorization for workspace resources.

Every workspace router goes through `require()`. Keeping the matrix in one
place — rather than scattering ownership checks across handlers — is what makes
it possible to test exhaustively (see tests/test_permissions.py), and this is
the most security-sensitive surface in the product.

The permission matrix (role x action):

| action        | owner | editor | viewer | share_token | anonymous |
|---------------|-------|--------|--------|-------------|-----------|
| read          |  yes  |  yes   |  yes   |     yes     |    no     |
| write         |  yes  |  yes   |  no    |     no      |    no     |
| delete        |  yes  |  no    |  no    |     no      |    no     |
| share         |  yes  |  no    |  no    |     no      |    no     |
| fork          |  yes  |  yes   |  yes   |     yes     |    no     |
| read_data     |  yes  |  yes   |  yes   |  only if share_includes_data | no |

`share_token` is the capability granted by holding a valid share link, and
`anonymous` covers everyone else. A public workspace (`is_public`) grants any
caller — signed in or not — the `share_token` role.
"""

from __future__ import annotations

import hmac
import uuid
from typing import Literal

from ..db.models import User, Workspace, WorkspaceMember

Action = Literal["read", "write", "delete", "share", "fork", "read_data"]
Role = Literal["owner", "editor", "viewer", "share_token", "anonymous"]

_MATRIX: dict[Role, frozenset[str]] = {
    "owner": frozenset({"read", "write", "delete", "share", "fork", "read_data"}),
    "editor": frozenset({"read", "write", "fork", "read_data"}),
    "viewer": frozenset({"read", "fork", "read_data"}),
    # read_data is granted conditionally in `can()`, not from this row.
    "share_token": frozenset({"read", "fork"}),
    "anonymous": frozenset(),
}


class PermissionDenied(Exception):
    """Base for authorization failures; carries an HTTP status + stable code."""

    status_code = 403
    code = "permission_denied"

    def __init__(self, message: str | None = None) -> None:
        super().__init__(message or self.code)
        self.message = message or self.code


class NotVisible(PermissionDenied):
    """The caller cannot even read the resource.

    404, not 403: a caller with no read access must not learn the workspace
    exists.
    """

    status_code = 404
    code = "not_found"

    def __init__(self, message: str = "Workspace not found") -> None:
        super().__init__(message)


def role_for(
    workspace: Workspace,
    user: User | None,
    *,
    share_token: str | None = None,
    members: list[WorkspaceMember] | None = None,
) -> Role:
    """Resolve the caller's strongest role on this workspace."""
    if user is not None and workspace.owner_id == user.id:
        return "owner"

    if user is not None:
        for member in members if members is not None else workspace.members:
            if member.user_id == user.id and member.role in ("editor", "viewer"):
                return member.role  # type: ignore[return-value]

    if workspace.is_public:
        return "share_token"
    if share_token and workspace.share_token and _token_eq(share_token, workspace.share_token):
        return "share_token"

    return "anonymous"


def can(
    action: Action,
    workspace: Workspace,
    user: User | None,
    *,
    share_token: str | None = None,
    members: list[WorkspaceMember] | None = None,
) -> bool:
    # A soft-deleted workspace is readable only by its owner (so they can
    # restore it); to everyone else it no longer exists.
    role = role_for(workspace, user, share_token=share_token, members=members)
    if workspace.deleted_at is not None and role != "owner":
        return False

    if action == "read_data" and role == "share_token":
        return bool(workspace.share_includes_data)

    return action in _MATRIX[role]


def require(
    action: Action,
    workspace: Workspace,
    user: User | None,
    *,
    share_token: str | None = None,
    members: list[WorkspaceMember] | None = None,
) -> Role:
    """Authorize or raise. Returns the resolved role for callers that need it."""
    role = role_for(workspace, user, share_token=share_token, members=members)
    if not can(action, workspace, user, share_token=share_token, members=members):
        # Distinguish "you can't see this at all" from "you can read it but not
        # do this" — otherwise a viewer's failed write looks like a 404 and the
        # frontend can't tell them why.
        if can("read", workspace, user, share_token=share_token, members=members):
            raise PermissionDenied(f"You do not have permission to {action} this workspace")
        raise NotVisible()
    return role


def _token_eq(a: str, b: str) -> bool:
    return hmac.compare_digest(a, b)


def owns(workspace: Workspace, user_id: uuid.UUID) -> bool:
    return workspace.owner_id == user_id
