# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project aims to
follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Changed
- **Package metadata:** `package.json` now names the repository, homepage, issue
  tracker and author, so an installed copy (`node_modules/exactly-once-webhooks/package.json`)
  and npm tooling link back to this repo.
- **README badges:** live test status for `main`, the latest release, the Node
  floor and the license, at the top of the README.
- **Docs: "exactly once" means the effect, not the delivery.** The README now says so
  up front: delivery stays at-least-once, and what runs once is the handler's work,
  as strongly as the store allows. DESIGN's statement of the guarantee is now scoped
  per store (Postgres fully, for writes made through the transaction; Redis a lease;
  memory one process), and no longer lists "calling the downstream API" as an effect
  the library makes happen once: an outside call isn't rolled back, which is what the
  outbox paragraph under "Alternatives" covers. The API docs (README and the
  `IdempotencyStore` comments in `types.ts`) no longer say "at most once" without
  the store's limits, and the concurrent-call line now notes the Redis lease.
- **Docs: the benchmark notes no longer point at #11 as open.** The Postgres waiter
  cost now says the wait has been bounded by `lockTimeoutMs` since 0.9.

## [0.10.0] - 2026-11-21

### Added
- **DESIGN: "Alternatives, and why this design doesn't use them".** Check-then-insert,
  a plain insert that catches the unique violation, advisory locks, `SERIALIZABLE`
  and retry, effect-then-record, Redlock, and the provider's idempotency key, each
  with the reason it falls short here, plus the outbox pattern for external API
  calls. The Postgres behaviour it cites (a failed insert aborts the transaction
  unless it's in a savepoint; `hashtext` is 32-bit; how a concurrent insert waits)
  was checked on Postgres 16. Written as reasoning, not as a history of what was
  tried.
- **Redis: a call whose claim expired mid-effect now says so.** It still returns
  `status: "processed"` (the effect did run), plus `lostClaim: true`, because its
  compare-and-set result write did not apply, so nothing was recorded. Either another
  caller had taken the key over (the effect may have run twice) or nobody had (the
  next delivery runs it again); DESIGN limitation 4. Before, the CAS outcome was
  ignored and the call looked like a normal first run. `Outcome<T>` gains the
  optional `lostClaim?: true`; the Postgres and memory stores never set it. Found in
  an external review.

### Changed
- **Postgres: the claim's `lock_timeout` is now a bound parameter**
  (`SELECT set_config('lock_timeout', $1, true)`, the parameterised form of
  `SET LOCAL`) instead of a number spliced into the SQL. It was safe before
  (`lockTimeoutMs` is validated as a non-negative integer), but it was the one
  statement in the store built by string interpolation. Same behaviour; the
  `lockTimeoutMs` test now also checks the bound value. Found in an external review.
- **Memory store: completing a key no longer scans the whole map.** With
  `maxEntries` set, every completion used to count all done entries before
  evicting; it now keeps a running count, so the bookkeeping is O(1) and eviction
  only walks past keys still in flight. Which key is evicted is unchanged, and a new
  test pins that order across a failed effect and re-delivered keys. Locally, 40k
  completions with a 20k cap went from ~1.0 s to ~0.08 s. Found in an external
  review.
- **Every store returns the same JSON copy for a duplicate.** The memory store
  used to hand a duplicate the first run's live object, while Postgres and Redis
  returned a JSON copy (a `Date` as its ISO string, `undefined` as `null`), so code
  tested against the memory store could behave differently in production. The
  memory store now keeps results as JSON too, so a result JSON can't hold (a
  `BigInt`, a cycle) fails in tests the way it fails in production. A function or
  `Symbol` result, which `JSON.stringify` drops, now comes back as `null` from
  every store, as it already did from Postgres; before, the memory store returned
  the live value and Redis returned `undefined`. A new contract test pins this for
  every store; DESIGN limitation 5 says what each store does. The call that ran
  the effect still gets its own value back. Found in an external review.

### Fixed
- **Redis: `pollIntervalMs` and `maxWaitMs` are validated when the store is
  created**, like the TTLs already were. Before, `maxWaitMs: NaN` made a waiter
  wait forever (`elapsed > NaN` is never true), a negative `maxWaitMs` gave up on
  the first look, and a negative or NaN `pollIntervalMs` was silently treated as
  ~1 ms. Now `pollIntervalMs` must be finite and non-negative, and `maxWaitMs`
  non-negative (0 and `Infinity` still allowed), or `createRedisStore` throws with
  the bad value in the message. Found in an external review.
- **Docs: what the effect's `lock_timeout` actually is.** The code comment said the
  effect gets "the session default"; `SET LOCAL lock_timeout TO DEFAULT` actually
  restores the server or role default, so a `lock_timeout` the app `SET` on the
  connection does not apply inside the effect (checked on Postgres 16: session
  `5s` reads `0` inside the effect, `5s` again after commit). Behaviour unchanged
  since 0.9.0; the comment is corrected and DESIGN limitation 6 says how to bound
  the effect's own lock waits. Found by an adversarial review of this release.
- **Example: replaying a dead letter that was parked as malformed is refused
  cleanly.** `replay()` cast the parse result to an event without checking it, so
  replaying a malformed letter threw a bare `TypeError` (`Cannot read properties of
  undefined`) from inside the ledger write. Nothing was written and the letter was
  kept, but the person replaying it got a crash, not a reason. It now returns
  `400 still malformed: <reason>`, never runs the write, and keeps the letter. Found
  in an external review.
- **Docs: where a losing caller waits on Postgres.** The README, DESIGN.md, the
  schema.sql header and four code comments said the loser waits in
  `SELECT ... FOR UPDATE`. It actually waits in its own
  `INSERT ... ON CONFLICT DO NOTHING`, which blocks until the winner's transaction
  ends; by the time it reads, the winner has finished. This is what limitation 7
  already said; the earlier text now agrees with it. No code change. Found by an
  adversarial review.
- **Postgres: a connection whose `ROLLBACK` failed is destroyed, not reused.** The
  store swallowed a failed `ROLLBACK` and called `release()` with no argument, so a
  connection left in an unknown state went back into the pool for the next caller.
  It now passes the error to `release(err)`, which tells `pg` to discard the
  connection; after a clean rollback the connection is reused as before.
  `PoolClient.release` accepts the optional error, as `pg`'s does. Found in an
  external review.

## [0.9.0] - 2026-11-20

### Added
- **`fromIoRedis(client)`** (closes #3): ioredis adapter using the same Lua
  scripts as `fromNodeRedis`. The full shared contract runs against it through an
  ioredis-shaped stub that checks the positional `SET` options and `eval` order.

### Changed
- **Postgres: waits on another caller's claim are bounded** (closes #11). New
  `lockTimeoutMs` option, default **5000** (before: no limit; set `0` to keep
  that). A transaction-local `lock_timeout` on the claim, reset before the effect
  runs, so effect statements are unaffected. A timed-out caller throws a clear
  error and frees its pooled connection; a real-Postgres test with a 2-connection
  pool shows an unrelated key served promptly while a slow holder runs.

### Fixed
- Postgres claim-loop comments, the cap's error message and DESIGN limitations 6–7
  described a "retry after the holder rolls back" that real Postgres never does:
  the waiter's blocked INSERT takes the key directly (closes #24). The loop now
  says what really sends it round (a prune racing the key), with a test.

## [0.8.0] - 2026-11-20

### Added
- **`onRetry({ key, attempt })`** on the Redis and Postgres stores (closes #7):
  fires when a waiter must retry because the holder failed, so contention and a
  deterministically failing key are visible before the retry cap. Optional and a
  no-op by default; a throwing hook is ignored. On Postgres a rollback hands the
  claim straight to the blocked waiter, so it rarely fires there (tested).
- **Benchmark** (`npm run bench`, `bench` workflow; closes #5): distinct-key
  throughput and p50/p99, and the hot-key case with an exactly-once assertion,
  on the memory store and real Postgres + Redis. Numbers in the README link the
  run that produced them.
- **`examples/payment-path`: the whole payment path in one place.** Signature
  verification (raw-body HMAC, constant-time, timestamp tolerance, rotation),
  exactly-once via the store, an append-only ledger, and a dead-letter path with
  replay. The Postgres version writes the ledger row in the same transaction as
  the idempotency key, and `ledger.sql` makes the table append-only with a trigger
  plus UNIQUE `event_id` and `reverses`. Tests for each step, on the memory store
  and (in CI) a real Postgres. `make example` runs the demo.

### Fixed
- Redis store: `ttlSeconds` / `pendingTtlSeconds` that are zero, negative or not
  finite are refused at construction. Before, Redis rejected `PX 0` on the result
  write, after the effect had run, so a redelivery ran it again. Milliseconds are
  rounded up in the store instead of in each adapter.
- payment-path example: a partial refund is dead-lettered instead of reversing the
  whole charge; a refund that arrives before its charge is retried, not parked;
  concurrent copies that fail together count as one failed delivery; a malformed
  event delivered twice makes one dead letter; the refund lookup is ordered.

### Changed
- README install line: the package is installed from the GitHub release tarball
  (it is not on the npm registry), and CI now installs that tarball into a fresh
  project and imports it on every change. Docs corrected where they overclaimed:
  Redis waiters time out after `maxWaitMs`; the Redis hot-key benchmark row uses a
  tuned poll interval; "secret rotation" is the provider's; the ledger trigger is
  a second line behind table grants. DESIGN's testing section now says Redis also
  runs the contract against a real server.

## [0.7.0]

### Changed (breaking for custom `RedisLike` adapters)
- **Redis claims carry an ownership token** (closes #10). The pending value now
  holds a random token, and `RedisLike` swaps `setValue`/`del` for
  `setIfValue(key, expected, value, ttlMs)` and `delIfValue(key, expected)`:
  atomic compare-and-set / compare-and-delete. `fromNodeRedis` implements them as
  Lua scripts, exported as `SET_IF_VALUE_LUA` / `DEL_IF_VALUE_LUA` so other
  adapters reuse the same ones. `fromNodeRedis` users need no change.

### Fixed
- A Redis holder whose claim expired mid-effect could overwrite the result of the
  caller that took over, or — if its effect then threw — delete that caller's
  live claim and let a third caller run the effect again. Both are now no-ops for
  a holder that no longer owns the claim. Two tests force the expiry and fail
  without the token.

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
