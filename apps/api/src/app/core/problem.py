"""RFC 7807 problem+json error responses."""

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from starlette.exceptions import HTTPException as StarletteHTTPException
from starlette.responses import JSONResponse

from ..compute.engine import ComputeError, QueryTimeout, SQLRejected
from ..services.errors import AuthError
from ..services.permissions import PermissionDenied
from .logging import request_id_var

# Compute failures are the user's fault (bad SQL) or their query's fault
# (too slow) — never a 500.
_COMPUTE_STATUS = {SQLRejected: 400, QueryTimeout: 504}

_MEDIA_TYPE = "application/problem+json"


def _problem(status: int, title: str, detail: str, code: str | None = None) -> JSONResponse:
    body = {
        "type": "about:blank",
        "title": title,
        "status": status,
        "detail": detail,
        "request_id": request_id_var.get(),
    }
    if code:
        body["code"] = code
    return JSONResponse(status_code=status, content=body, media_type=_MEDIA_TYPE)


def install_problem_handlers(app: FastAPI) -> None:
    @app.exception_handler(AuthError)
    async def _auth(_: Request, exc: AuthError) -> JSONResponse:
        return _problem(exc.status_code, exc.code, exc.message, code=exc.code)

    @app.exception_handler(PermissionDenied)
    async def _permission(_: Request, exc: PermissionDenied) -> JSONResponse:
        return _problem(exc.status_code, exc.code, exc.message, code=exc.code)

    @app.exception_handler(ComputeError)
    async def _compute(_: Request, exc: ComputeError) -> JSONResponse:
        status = _COMPUTE_STATUS.get(type(exc), 422)
        return _problem(status, exc.code, exc.message, code=exc.code)

    @app.exception_handler(StarletteHTTPException)
    async def _http(_: Request, exc: StarletteHTTPException) -> JSONResponse:
        detail = exc.detail if isinstance(exc.detail, str) else "error"
        response = _problem(exc.status_code, detail, detail)
        if exc.headers:
            response.headers.update(exc.headers)
        return response

    @app.exception_handler(RequestValidationError)
    async def _validation(_: Request, exc: RequestValidationError) -> JSONResponse:
        response = _problem(422, "validation_error", "Request validation failed")
        response.body = response.render(
            {**_json(response), "errors": _safe_errors(exc.errors())}
        )
        response.headers["content-length"] = str(len(response.body))
        return response


def _json(response: JSONResponse) -> dict:
    import json

    return json.loads(response.body)


def _safe_errors(errors: list) -> list:
    # Drop the non-serializable `ctx`/exception objects Pydantic can include.
    return [{k: v for k, v in e.items() if k in ("type", "loc", "msg", "input")} for e in errors]
