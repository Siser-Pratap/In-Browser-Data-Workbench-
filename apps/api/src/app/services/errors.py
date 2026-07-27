class AuthError(Exception):
    """Base for auth failures, carrying an HTTP status + stable error code."""

    status_code = 400
    code = "auth_error"

    def __init__(self, message: str | None = None) -> None:
        super().__init__(message or self.code)
        self.message = message or self.code


class EmailAlreadyRegistered(AuthError):
    status_code = 409
    code = "email_already_registered"


class InvalidCredentials(AuthError):
    status_code = 401
    code = "invalid_credentials"


class InvalidToken(AuthError):
    status_code = 401
    code = "invalid_token"


class TokenReused(AuthError):
    status_code = 401
    code = "token_reused"


class AccountInactive(AuthError):
    status_code = 403
    code = "account_inactive"
