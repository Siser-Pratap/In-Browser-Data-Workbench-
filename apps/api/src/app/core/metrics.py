"""Prometheus metrics.

Deliberately small: request latency, job outcomes and queue depth, and LLM token
usage. Anything an alert or a capacity question needs, nothing else — every
series here costs cardinality forever.

Route labels use the *path template* (`/api/v1/workspaces/{workspace_id}`), never
the concrete path, or every workspace id would become its own time series.
"""

from __future__ import annotations

import time

from prometheus_client import CONTENT_TYPE_LATEST, Counter, Gauge, Histogram, generate_latest
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import Response

REQUEST_DURATION = Histogram(
    "http_request_duration_seconds",
    "Request latency",
    labelnames=("method", "route", "status"),
    buckets=(0.005, 0.025, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0, 10.0),
)

JOBS_TOTAL = Counter(
    "jobs_total",
    "Jobs by kind and terminal status",
    labelnames=("kind", "status"),
)

JOB_DURATION = Histogram(
    "job_duration_seconds",
    "Job execution time",
    labelnames=("kind",),
    buckets=(0.1, 1.0, 5.0, 15.0, 60.0, 300.0, 900.0),
)

JOB_QUEUE_DEPTH = Gauge(
    "job_queue_depth",
    "Jobs currently in a non-terminal state",
    labelnames=("status",),
)

COMPUTE_RESULT_BYTES = Histogram(
    "compute_result_bytes",
    "Size of server-compute results",
    buckets=(1e3, 1e4, 1e5, 1e6, 1e7, 1e8),
)

LLM_TOKENS = Counter(
    "llm_tokens_total",
    "Tokens consumed by the AI endpoints",
    labelnames=("model", "kind"),
)


class MetricsMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        start = time.perf_counter()
        response = await call_next(request)
        REQUEST_DURATION.labels(
            method=request.method,
            route=_route_of(request),
            status=str(response.status_code),
        ).observe(time.perf_counter() - start)
        return response


def _route_of(request: Request) -> str:
    route = request.scope.get("route")
    # Unmatched requests (404s, probes) collapse into one series rather than
    # minting one per URL an scanner tries.
    return getattr(route, "path", "unmatched")


def render() -> Response:
    return Response(generate_latest(), media_type=CONTENT_TYPE_LATEST)
