# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project aims to
follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.3.0]

### Added
- **Redis store** — `createRedisStore(redis, options?)`, a third implementation
  that passes the same `test/contract.ts` as the memory and Postgres stores. The
  claim is an atomic `SET ... NX PX`; the TTL is both the dedup window and the
  retention policy, so there is nothing to prune. `fromNodeRedis(client)` adapts a
  node-redis v4+ client. Documented honestly: unlike Postgres it is **not**
  transactional with the effect, so it is for idempotent effects or when the dedup
  window suffices (see DESIGN.md).
- `test/fake-redis.ts`, an in-process stand-in modelling `SET NX PX` + TTL, so the
  Redis contract runs with no services.

## [0.2.0]

### Added
- **Shared behavioural contract** (`test/contract.ts`) that every store
  implementation runs — process-once, dedup across repeat deliveries, the
  concurrent double-credit race, independent keys, and retry after a thrown
  effect. The memory store runs it with no services; the Postgres store runs the
  same contract against a real database when `DATABASE_URL` is set. This makes the
  "any store that honours the contract is valid" claim executable rather than
  prose.
- **Bounded memory store** via `createMemoryStore({ maxEntries })`. Without it the
  in-memory store remembers every key forever (fine for a short-lived process,
  unbounded for a long-running one). With it, the least-recently-completed key is
  evicted once the cap is exceeded; in-flight keys are never evicted. Documented
  as a dedup *window*, with the trade-off stated.
- **`DESIGN.md`** — the precise guarantee, the two race conditions each store
  closes, handler-failure semantics, ordering, non-goals, and an honest
  known-limitations section.
- **`docker-compose.yml`** — a one-command Postgres so the database-backed tests
  can be run locally against a real server.

### Changed
- `types.ts` now points at the real `test/contract.ts` (previously referenced a
  file that did not exist).

## [0.1.0] — 2026-11-18

### Added
- Initial release: `createMemoryStore` and `createPostgresStore`, the
  `IdempotencyStore` contract, `schema.sql`, and the double-credit race test.
- No runtime dependencies. `pg` is an optional peer, reached through a small
  `Pool`/`Queryable` interface so the library does not depend on it.
