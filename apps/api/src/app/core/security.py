"""Password hashing, access-token JWTs, and single-use signed tokens.

Access tokens are short-lived stateless JWTs. Refresh tokens are opaque random
strings stored hashed in the DB (rotation + reuse detection live in
auth_service). Email-verification and password-reset tokens are short-lived
signed JWTs scoped by `purpose`, so they need no table.
"""

import datetime as dt
import hashlib
import secrets

import jwt
from argon2 import PasswordHasher
from argon2.exceptions import VerifyMismatchError

_hasher = PasswordHasher()
_ALGO = "HS256"


# -- passwords ---------------------------------------------------------------


def hash_password(password: str) -> str:
    return _hasher.hash(password)


def verify_password(password: str, password_hash: str) -> bool:
    try:
        return _hasher.verify(password_hash, password)
    except VerifyMismatchError:
        return False


# -- access tokens -----------------------------------------------------------


def create_access_token(user_id: str, secret: str, ttl_seconds: int) -> str:
    now = dt.datetime.now(dt.UTC)
    payload = {
        "sub": user_id,
        "type": "access",
        "iat": now,
        "exp": now + dt.timedelta(seconds=ttl_seconds),
    }
    return jwt.encode(payload, secret, algorithm=_ALGO)


def decode_access_token(token: str, secret: str) -> dict | None:
    """Return claims for a valid access token, else None (never raises)."""
    try:
        claims = jwt.decode(token, secret, algorithms=[_ALGO])
    except jwt.PyJWTError:
        return None
    if claims.get("type") != "access":
        return None
    return claims


# -- purpose-scoped signed tokens (email verify, password reset) -------------


def create_signed_token(
    purpose: str, subject: str, secret: str, ttl_seconds: int, fingerprint: str | None = None
) -> str:
    now = dt.datetime.now(dt.UTC)
    payload = {
        "sub": subject,
        "purpose": purpose,
        "iat": now,
        "exp": now + dt.timedelta(seconds=ttl_seconds),
    }
    if fingerprint is not None:
        payload["fp"] = fingerprint
    return jwt.encode(payload, secret, algorithm=_ALGO)


def verify_signed_token(purpose: str, token: str, secret: str) -> dict | None:
    try:
        claims = jwt.decode(token, secret, algorithms=[_ALGO])
    except jwt.PyJWTError:
        return None
    if claims.get("purpose") != purpose:
        return None
    return claims


def password_fingerprint(password_hash: str | None) -> str:
    """Short digest binding a reset token to the password it was issued for, so
    the token stops working once the password changes."""
    return hashlib.sha256((password_hash or "").encode()).hexdigest()[:16]


# -- refresh tokens ----------------------------------------------------------


def new_refresh_token() -> tuple[str, str]:
    """Return (raw, sha256_hex). Store the hash; hand the raw to the client."""
    raw = secrets.token_urlsafe(48)
    return raw, hash_token(raw)


def hash_token(raw: str) -> str:
    return hashlib.sha256(raw.encode()).hexdigest()
