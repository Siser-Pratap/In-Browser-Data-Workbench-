# Shortcuts for the Docker development stack. Everything here is a thin wrapper
# over `docker compose` — nothing is hidden, and you can always run the compose
# command directly.

COMPOSE ?= docker compose

.DEFAULT_GOAL := help

.PHONY: help up down restart logs ps build rebuild \
        web api worker db shell-web shell-api \
        test test-web test-api e2e lint migrate revision clean

help: ## Show this help
	@grep -hE '^[a-z-]+:.*?## ' $(MAKEFILE_LIST) \
		| awk 'BEGIN{FS=":.*?## "}{printf "  \033[36m%-14s\033[0m %s\n", $$1, $$2}'

# --- the whole stack --------------------------------------------------------

up: ## Start everything (web + api + worker + db + redis + minio)
	@test -f .env || cp .env.example .env
	$(COMPOSE) up

up-d: ## Start everything in the background
	@test -f .env || cp .env.example .env
	$(COMPOSE) up -d

down: ## Stop everything (volumes are kept)
	$(COMPOSE) down

restart: ## Recreate every container
	$(COMPOSE) up -d --force-recreate

build: ## Build the images
	$(COMPOSE) build

rebuild: ## Rebuild the images from scratch
	$(COMPOSE) build --no-cache

ps: ## Show what's running
	$(COMPOSE) ps

logs: ## Tail every service's logs
	$(COMPOSE) logs -f

# --- one service at a time --------------------------------------------------

web: ## Tail the frontend logs
	$(COMPOSE) logs -f web

api: ## Tail the backend logs (includes the AI endpoints)
	$(COMPOSE) logs -f api

worker: ## Tail the background worker logs
	$(COMPOSE) logs -f worker

shell-web: ## Shell into the frontend container
	$(COMPOSE) exec web sh

shell-api: ## Shell into the backend container
	$(COMPOSE) exec api bash

db: ## psql into the database
	$(COMPOSE) exec db psql -U workbench -d workbench

# --- checks -----------------------------------------------------------------

test: test-api test-web ## Run both test suites

test-api: ## Backend tests (pytest)
	$(COMPOSE) exec api pytest

test-web: ## Frontend unit tests (vitest)
	$(COMPOSE) exec web pnpm test

e2e: ## Frontend end-to-end tests (playwright, runs on the host)
	cd apps/web && pnpm test:e2e

lint: ## Lint both apps
	$(COMPOSE) exec api ruff check .
	$(COMPOSE) exec web pnpm lint

# --- database ---------------------------------------------------------------

migrate: ## Apply migrations
	$(COMPOSE) exec api alembic upgrade head

revision: ## Autogenerate a migration: make revision m="add widgets"
	$(COMPOSE) exec api alembic revision --autogenerate -m "$(m)"

# --- cleanup ----------------------------------------------------------------

clean: ## Stop everything and delete the volumes (database, uploads, node_modules)
	$(COMPOSE) down -v
