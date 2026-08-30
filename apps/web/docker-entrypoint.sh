#!/bin/sh
set -e

# `node_modules` is a named volume that outlives the image, so the dependencies
# baked into the image layer are not necessarily what's mounted here. Syncing on
# every start keeps the container honest after a lockfile change or a fresh
# volume; with a warm pnpm store and nothing to do it costs a couple of seconds.
if [ -f pnpm-lock.yaml ]; then
  echo "› syncing dependencies…"
  pnpm install --frozen-lockfile --prefer-offline
fi

exec "$@"
