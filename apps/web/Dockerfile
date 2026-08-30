# The Next.js frontend.
#
# `dev` is what the root docker-compose.yml runs; `runner` is the production
# image. Both start from the same dependency layer so a `pnpm install` is not
# paid twice.

FROM node:22-bookworm-slim AS base
# Two instructions, not one: within a single ENV, PNPM_HOME is not yet in scope
# when PATH is expanded, so PATH would start with an empty entry (which means
# "current directory") and /pnpm would never be on it at all.
ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH
RUN corepack enable
WORKDIR /app


# Dependencies, cached until the lockfile changes.
FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile


# --- development -----------------------------------------------------------
#
# Source arrives via a bind mount, so nothing is COPYed. `node_modules` and
# `.next` live on named volumes (see the compose file) precisely so the host's
# copies don't shadow the container's — the host's are built for macOS or
# Windows, and Next's SWC binary is platform-specific.
#
# The entrypoint re-runs `pnpm install` on every start rather than trusting the
# image layer: the named volume outlives the image, so a lockfile change would
# otherwise leave the container running yesterday's dependencies with no signal.
# With a warm store this is a couple of seconds.
FROM base AS dev
COPY --from=deps /app/node_modules ./node_modules
COPY docker-entrypoint.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/docker-entrypoint.sh
EXPOSE 3000
# Absolute path, not a bare name: WORKDIR is /app, which the compose bind mount
# fills with the repo — including a copy of this very script. Resolving by name
# finds that one relative to the cwd, and the runtime refuses to exec it.
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]
CMD ["pnpm", "dev"]


# --- production ------------------------------------------------------------
FROM base AS builder
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# `prebuild` mirrors the DuckDB WASM bundle and its extensions into public/;
# this is the one step that reaches the network, and it degrades to a runtime
# CDN fetch if the mirror fails rather than failing the build.
RUN pnpm build


FROM base AS runner
ENV NODE_ENV=production
RUN useradd --create-home --uid 10001 app
COPY --from=builder --chown=app:app /app/.next ./.next
COPY --from=builder --chown=app:app /app/public ./public
COPY --from=builder --chown=app:app /app/node_modules ./node_modules
COPY --from=builder --chown=app:app /app/package.json ./package.json
COPY --from=builder --chown=app:app /app/next.config.ts ./next.config.ts
USER app
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --start-period=15s --retries=3 \
    CMD node -e "require('http').get('http://127.0.0.1:3000/',r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

CMD ["pnpm", "start"]
