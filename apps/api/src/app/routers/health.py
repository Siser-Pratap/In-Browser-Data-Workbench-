from fastapi import APIRouter, Request
from sqlalchemy import text
from starlette.responses import Response

from ..core import metrics

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

    # The broker is reported but does not gate readiness: an unreachable Redis
    # degrades to running jobs in-process, which is worth alerting on but isn't
    # a reason to pull the instance out of the load balancer. Without this the
    # fallback is invisible — a 60s compute query silently ties up an HTTP
    # worker and nothing says why.
    checks["jobs"] = _queue_mode(request)
    return {"status": "ready" if ready else "not_ready", "checks": checks}


def _queue_mode(request: Request) -> str:
    queue = getattr(request.app.state, "job_queue", None)
    if queue is None:
        return "unavailable"
    kind = type(queue).__name__
    if kind == "ArqQueue":
        return "redis"
    # Configured for Redis but running inline means the broker was unreachable.
    return "inline_fallback" if request.app.state.settings.redis_url else "inline"


@router.get("/metrics", operation_id="metrics", include_in_schema=False)
async def prometheus_metrics(request: Request) -> Response:
    """Prometheus scrape endpoint.

    Queue depth is read live rather than tracked incrementally — an API process
    that restarts would otherwise report a counter that never matches reality.
    """
    try:
        async with request.app.state.db.sessionmaker() as session:
            depth = await request.app.state.job_service.queue_depth(session)
        for status in ("queued", "running"):
            metrics.JOB_QUEUE_DEPTH.labels(status=status).set(depth.get(status, 0))
    except Exception:  # noqa: BLE001 — a scrape must never fail the endpoint
        pass
    return metrics.render()
