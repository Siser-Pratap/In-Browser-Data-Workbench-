"""Exhaustive permission matrix.

Authorization is the most security-sensitive surface in the product, so every
(role x action) cell is asserted here against the documented matrix in
`services/permissions.py` — a change to the rules has to be a deliberate edit
to this table, not an accident.
"""

import datetime as dt
import uuid

import pytest

from app.db.models import User, Workspace, WorkspaceMember
from app.services.permissions import NotVisible, PermissionDenied, can, require, role_for

ACTIONS = ["read", "write", "delete", "share", "fork", "read_data"]

# role -> the actions it may perform. Mirrors the table in permissions.py.
EXPECTED = {
    "owner": {"read", "write", "delete", "share", "fork", "read_data"},
    "editor": {"read", "write", "fork", "read_data"},
    "viewer": {"read", "fork", "read_data"},
    "share_token": {"read", "fork"},
    "anonymous": set(),
}

TOKEN = "share-token-value"


def make_user() -> User:
    user = User(email=f"{uuid.uuid4().hex}@example.com")
    user.id = uuid.uuid4()
    return user


def make_workspace(owner: User, **kwargs) -> Workspace:
    workspace = Workspace(owner_id=owner.id, name="ws", settings={}, **kwargs)
    workspace.id = uuid.uuid4()
    workspace.is_public = kwargs.get("is_public", False)
    workspace.share_includes_data = kwargs.get("share_includes_data", False)
    workspace.deleted_at = None
    return workspace


def setup_role(role: str):
    """Build (workspace, user, share_token, members) putting the caller in `role`."""
    owner = make_user()
    workspace = make_workspace(owner)
    workspace.share_token = TOKEN

    if role == "owner":
        return workspace, owner, None, []
    if role in ("editor", "viewer"):
        member_user = make_user()
        member = WorkspaceMember(
            workspace_id=workspace.id, user_id=member_user.id, role=role
        )
        return workspace, member_user, None, [member]
    if role == "share_token":
        return workspace, None, TOKEN, []
    return workspace, None, None, []  # anonymous


@pytest.mark.parametrize("role", list(EXPECTED))
@pytest.mark.parametrize("action", ACTIONS)
def test_permission_matrix(role, action):
    workspace, user, token, members = setup_role(role)
    assert role_for(workspace, user, share_token=token, members=members) == role
    allowed = can(action, workspace, user, share_token=token, members=members)
    assert allowed is (action in EXPECTED[role]), (
        f"{role} should {'' if action in EXPECTED[role] else 'not '}be able to {action}"
    )


def test_share_token_reads_data_only_when_owner_opted_in():
    workspace, _, token, _ = setup_role("share_token")
    assert can("read_data", workspace, None, share_token=token) is False

    workspace.share_includes_data = True
    assert can("read_data", workspace, None, share_token=token) is True


def test_wrong_share_token_is_anonymous():
    workspace, _, _, _ = setup_role("share_token")
    assert role_for(workspace, None, share_token="not-the-token") == "anonymous"
    assert can("read", workspace, None, share_token="not-the-token") is False


def test_public_workspace_grants_read_without_a_token():
    owner = make_user()
    workspace = make_workspace(owner, is_public=True)
    assert can("read", workspace, None) is True
    assert can("write", workspace, None) is False


def test_owner_of_another_workspace_gets_nothing():
    workspace, _, _, _ = setup_role("anonymous")
    stranger = make_user()
    assert role_for(workspace, stranger) == "anonymous"
    assert can("read", workspace, stranger) is False


def test_soft_deleted_workspace_is_owner_only():
    workspace, owner, _, _ = setup_role("owner")
    workspace.deleted_at = dt.datetime.now(dt.UTC)
    assert can("read", workspace, owner) is True

    member_user = make_user()
    member = WorkspaceMember(workspace_id=workspace.id, user_id=member_user.id, role="viewer")
    assert can("read", workspace, member_user, members=[member]) is False


def test_require_raises_404_when_invisible_and_403_when_merely_forbidden():
    # A stranger must not learn the workspace exists.
    workspace, _, _, _ = setup_role("anonymous")
    stranger = make_user()
    with pytest.raises(NotVisible) as invisible:
        require("read", workspace, stranger)
    assert invisible.value.status_code == 404

    # A viewer can see it, so a refused write is an honest 403.
    workspace, viewer, _, members = setup_role("viewer")
    with pytest.raises(PermissionDenied) as forbidden:
        require("write", workspace, viewer, members=members)
    assert forbidden.value.status_code == 403


def test_require_returns_the_resolved_role():
    workspace, owner, _, _ = setup_role("owner")
    assert require("write", workspace, owner) == "owner"
