# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project aims to
follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [0.6.0]

### Added
- **Real-server test coverage.** The shared contract now runs against a live
  Postgres *and* a live Redis in CI (service containers), not just the memory store
  and a Redis fake. `REDIS_URL` is now actually read — it was documented and ignored
  before, so the Redis store had never been tested against real Redis. Added `pg`
  and `redis` as dev dependencies and a self-contained schema load (no `psql` step).
- **`pendingTtlSeconds`** on the Redis store (default 30): the in-flight claim now
  carries a short lease, so a holder that crashes mid-effect frees the key in
  seconds instead of for the whole dedup window; the key is rewritten with the full
  `ttlSeconds` only on success.

### Changed
- Redis: a failed *result* write (after the effect already succeeded) no longer
  deletes the claim — deleting it would re-run an effect that ran. The short pending
  claim is left to expire and the error surfaces. Only a thrown *effect* releases
  the claim.

### Fixed
- Corrected stale/false docs a review caught: `package.json`, `types.ts`, `DESIGN`
  and `README` said "two stores" / "In-memory and Postgres" (there are three);
  `README` pointed the race test at `memory-store.test.ts` (it is the shared
  `contract.ts`); the "tested against real servers via `REDIS_URL`" claim is now
  true rather than aspirational. DESIGN limitations renumbered and expanded with the
  Redis ownership-token gap and the Postgres multi-waiter pool-starvation note.
- The failure-race contract test now also asserts the effect *ran* exactly twice
  (not only that it succeeded once).

## [0.5.1]

### Fixed
- **Concurrent double-run in the memory store.** When a holder's effect threw while
  three or more callers waited on the same key, the post-failure re-check looked for
  a `done` entry exactly once, so every waiter fell through and ran the effect — the
  concurrent-duplicate bug this library exists to stop. Measured: four deliveries
  with the first failing ran the effect four times. The re-check is now a loop:
  exactly one waiter re-claims and the rest wait on it. (Found by an adversarial
  code review; the Postgres and Redis stores were never affected — their claim is
  atomic in the database / via `SET NX`.)
- The contract's failure-race test was too weak to catch the above (two callers, a
  `>= 1` assertion). It now runs four concurrent callers and asserts the effect
  reruns *exactly once* with exactly one `processed` result. It fails on the old
  memory store and passes on the fix.

## [0.5.0]

### Changed
- **Claim retries are now a bounded loop, not unbounded recursion.** When a holder's
  effect throws, the next caller retries to claim the key; the Postgres and Redis
  stores did this by recursing (`return run(...)`) with no cap. They now loop up to
  `MAX_CLAIM_ATTEMPTS` (50) and raise a clear error if a holder keeps rolling back
  (a deterministically failing effect), instead of recursing/spinning forever. No
  change under healthy contention, where one delivery wins immediately. Each store
  has a test proving the bound fires. (Raised by an external code review.)
- Corrected a misleading comment in the Postgres store: a committed row is always
  `done` (the `pending` state only exists inside the holder's uncommitted
  transaction), so an absent row means the holder rolled back.

### Fixed
- `DESIGN.md` limitations renumbered (dropped the stray `2a`); the retry limitation
  now describes the bounded loop instead of unbounded recursion.

## [0.4.0]

### Added
- `pruneExpiredKeys(pool, { olderThanSeconds, table? })` — the retention job the
  Postgres store's "table grows forever" limitation points to. A windowed `DELETE`
  with a bound parameter; returns the number of rows removed. Tested against a fake
  pool (no database).
- `SECURITY.md` (private disclosure), a `Makefile` (`make check`, `make db-test`),
  and a Mermaid flow diagram in `DESIGN.md`.

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
