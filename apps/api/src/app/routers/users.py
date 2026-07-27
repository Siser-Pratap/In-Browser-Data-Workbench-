from fastapi import APIRouter

from ..core.deps import Auth, CurrentUser, DbSession, Storage
from ..db.models import User
from ..schemas.auth import MessageResponse, UpdateUserRequest, UserResponse

router = APIRouter(prefix="/users", tags=["users"])


def to_user_response(user: User) -> UserResponse:
    return UserResponse(
        id=str(user.id),
        email=user.email,
        display_name=user.display_name,
        is_verified=user.is_verified,
        created_at=user.created_at,
    )


@router.get("/me", response_model=UserResponse, operation_id="getCurrentUser")
async def get_me(user: CurrentUser) -> UserResponse:
    return to_user_response(user)


@router.patch("/me", response_model=UserResponse, operation_id="updateCurrentUser")
async def update_me(
    body: UpdateUserRequest, user: CurrentUser, db: DbSession
) -> UserResponse:
    if body.display_name is not None:
        user.display_name = body.display_name
    await db.commit()
    await db.refresh(user)
    return to_user_response(user)


@router.delete("/me", response_model=MessageResponse, operation_id="deleteCurrentUser")
async def delete_me(
    user: CurrentUser, db: DbSession, auth: Auth, storage: Storage
) -> MessageResponse:
    await auth.delete_user(db, user, storage=storage)
    return MessageResponse(message="Your account and data have been deleted.")
