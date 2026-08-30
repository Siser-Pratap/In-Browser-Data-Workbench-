# Multi-stage build using uv. Non-root runtime.
FROM ghcr.io/astral-sh/uv:python3.12-bookworm-slim AS build

WORKDIR /app
ENV UV_COMPILE_BYTECODE=1 UV_LINK_MODE=copy

# Install dependencies first (cached until the lockfile changes).
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-install-project --no-dev

COPY . .
RUN uv sync --frozen --no-dev


# The image the root docker-compose.yml runs for local development.
#
# Two differences from `runtime` below, both consequences of the source being
# bind-mounted from the host rather than baked in:
#
#   1. The virtualenv lives at /opt/venv, *outside* /app. A bind mount over
#      /app would otherwise hide a venv installed into it, and the container
#      would start with no dependencies at all.
#   2. Dev dependencies are installed, so `pytest` and `ruff` can be run inside
#      the container without a second image.
#
# No source is COPYed — compose provides it, so a code change needs no rebuild.
FROM ghcr.io/astral-sh/uv:python3.12-bookworm-slim AS dev

WORKDIR /app
ENV UV_COMPILE_BYTECODE=1 \
    UV_LINK_MODE=copy \
    UV_PROJECT_ENVIRONMENT=/opt/venv \
    PATH="/opt/venv/bin:$PATH" \
    PYTHONPATH=/app/src \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1

COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-install-project

EXPOSE 8000

# Runs as root: dev containers write to bind-mounted source (Alembic revisions,
# __pycache__), and a uid mismatch with the host makes those files unwritable.
# The `runtime` stage below is the one that ships, and it is non-root.
CMD ["uvicorn", "app.main:app", "--app-dir", "src", "--host", "0.0.0.0", "--port", "8000", "--reload"]


FROM python:3.12-slim-bookworm AS runtime

RUN useradd --create-home --uid 10001 app
WORKDIR /app

COPY --from=build --chown=app:app /app /app
ENV PATH="/app/.venv/bin:$PATH" \
    # The project isn't installed as a package; the worker entry point
    # (`arq app.workers.worker.WorkerSettings`) needs the source root on the
    # path, and unlike uvicorn it has no `--app-dir` equivalent.
    PYTHONPATH=/app/src \
    PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1

USER app
EXPOSE 8000

# Liveness only — /readyz touches the database, and a database blip should not
# make the orchestrator kill an otherwise healthy container.
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
    CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8000/healthz', timeout=2).status == 200 else 1)"

# One uvicorn worker per container; scale by running more containers so the
# platform, not the process, owns replica count and rollout. Override
# WEB_CONCURRENCY to fan out within a container instead.
CMD ["sh", "-c", "uvicorn app.main:app --app-dir src --host 0.0.0.0 --port 8000 --workers ${WEB_CONCURRENCY:-1} --proxy-headers --forwarded-allow-ips '*'"]
