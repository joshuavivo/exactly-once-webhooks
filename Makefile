# Thin wrappers over the npm scripts, so `make test` / `make check` just work.
.PHONY: install test typecheck build check up down db-test example

install:        ## install dev dependencies
	npm install

test:           ## run the contract against the memory + fake stores (no services)
	npm test

typecheck:      ## strict typecheck
	npm run typecheck

build:          ## compile to dist/
	npm run build

check: typecheck test build   ## everything CI runs

up:             ## start Postgres + Redis for the real-server tests
	docker compose up -d

down:           ## stop them
	docker compose down

example:        ## the end-to-end payment path demo (no services)
	node examples/payment-path/demo.ts

db-test: up     ## run the full suite against real Postgres + Redis
	DATABASE_URL=postgres://eow:eow@localhost:5433/eow REDIS_URL=redis://localhost:6380 npm test
