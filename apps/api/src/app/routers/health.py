from fastapi import APIRouter, Request
from sqlalchemy import text

router = APIRouter(tags=["health"])


@router.get("/healthz", operation_id="healthz")
async def healthz() -> dict:
    """Liveness — the process is up."""
    return {"status": "ok"}


@router.get("/readyz", operation_id="readyz")
async def readyz(request: Request) -> dict:
    """Readiness — dependencies (the database) are reachable."""
    checks: dict[str, str] = {}
    ready = True
    try:
        async with request.app.state.db.sessionmaker() as session:
            await session.execute(text("SELECT 1"))
        checks["database"] = "ok"
    except Exception:  # noqa: BLE001 — readiness must report, not raise
        checks["database"] = "error"
        ready = False
    return {"status": "ready" if ready else "not_ready", "checks": checks}
