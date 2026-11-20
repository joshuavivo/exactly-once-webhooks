# exactly-once-webhooks

Process a payment webhook **once**, even when the provider delivers it twice or
two copies arrive at the same moment.

A payment provider retries a webhook until it gets a `2xx`, so the same
`charge.succeeded` event can arrive two or three times. If each delivery credits
the customer, the customer is credited two or three times. Worse, two deliveries
can land at the same instant and race past a naive "have I seen this yet?" check.

This library ties the work to the event's own id and lets the storage layer
guarantee it runs once — with a Postgres store that holds up across many servers, a
Redis store for when the effect is idempotent, and an in-memory store for tests and
single-process use.

Not on the npm registry yet. Install the packed release from GitHub (CI installs
this exact tarball into a fresh project and imports it on every change):

```
npm install https://github.com/joshuavivo/exactly-once-webhooks/releases/download/v0.7.0/exactly-once-webhooks-0.7.0.tgz
```

No runtime dependencies. Node 22.18+ (it ships as TypeScript and compiled JS).

**The whole payment path in one place:** [`examples/payment-path`](examples/payment-path)
verifies the signature, credits exactly once, writes an append-only ledger row in
the same Postgres transaction, and dead-letters what it can't apply, with a test
for each step. `node examples/payment-path/demo.ts` runs it with no services.

## The problem, in one test

```ts
let balance = 0;
const credit = async () => { const b = balance; await wait(5); balance = b + 100; return balance; };

// Five copies of the same event arrive together.
await Promise.all([
  store.run("evt_123", credit),
  store.run("evt_123", credit),
  store.run("evt_123", credit),
  store.run("evt_123", credit),
  store.run("evt_123", credit),
]);

balance; // 100 — credited once, not five times
```

That test is the shared contract in `test/contract.ts` that every store runs, and it runs on every push.

## Using it on a webhook endpoint

```ts
import { createPostgresStore } from "exactly-once-webhooks";
import { Pool } from "pg";

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const store = createPostgresStore(pool);

app.post("/webhooks/stripe", async (req, res) => {
  const event = verifyAndParse(req); // your signature check

  const { status } = await store.run(event.id, async (tx) => {
    // `tx` is the SAME database transaction the idempotency record commits in,
    // so your write and "this event is handled" either both land or neither does.
    await tx.query(
      "UPDATE accounts SET balance = balance + $1 WHERE id = $2",
      [event.amount, event.accountId],
    );
    return { creditedCents: event.amount };
  });

  // status is "processed" the first time, "duplicate" on every retry.
  res.sendStatus(200);
});
```

Run `schema.sql` once to create the table it needs.

## Why it is safe across many servers

The Postgres store rests on two guarantees, not on application logic:

1. **A `PRIMARY KEY` on the event id.** The first delivery inserts the row; a
   second delivery's insert does nothing (`ON CONFLICT DO NOTHING`). Only one
   delivery is ever "the first".
2. **`SELECT ... FOR UPDATE` on the row.** A concurrent second delivery blocks
   until the first delivery's transaction commits, then reads the stored result
   instead of running the effect again. If the first effect threw, its
   transaction rolled back, the row is gone, and the second delivery retries.

Because the effect runs inside that transaction, your write to `accounts` and the
"handled" record commit together. There is no window where one landed and the
other didn't.

## API

### `store.run(key, effect)`

Runs `effect` at most once for `key`.

- First call for a key: runs `effect`, stores the result, returns
  `{ status: "processed", result }`.
- Later calls for the same key: return `{ status: "duplicate", result }` without
  running `effect` again.
- Concurrent calls for the same key: exactly one runs the effect; the rest wait
  and return `duplicate`. (Redis waiters give up after `maxWaitMs`, default 5 s,
  and throw. If a holder crashed, its claim blocks the key until `pendingTtl`,
  default 30 s, lapses, so redeliveries in that window fail and are retried by
  the provider.)
- If `effect` throws, nothing is stored and the error is re-thrown, so a later
  delivery can retry.

Use the event's own id as the key — the thing the provider guarantees is stable
across retries.

### `createMemoryStore(options?)`

A store that lives in one process. Good for tests and single-process apps; it
does **not** share state across servers. The effect's context is `undefined`.

Pass `{ maxEntries }` to bound its memory: once more than `maxEntries` keys have
completed, the least-recently-completed one is forgotten. A forgotten key is no
longer deduplicated, so set the cap above the number of distinct events you expect
inside the provider's retry window. Without it the store keeps every key forever —
fine for a short-lived process, unbounded for a long-running one. In-flight keys
are never evicted.

### `createPostgresStore(pool, options?)`

A store backed by Postgres and safe across processes. `pool` is anything with the
small `connect()` / `query()` shape `pg` provides. `options.table` defaults to
`"idempotency_keys"`. The effect's context is the transaction's client, so your
writes join the same transaction.

Keep the table from growing forever with `pruneExpiredKeys(pool, { olderThanSeconds })`
on a schedule — it deletes processed keys older than a window you choose (set it
past your provider's retry window). The Redis store needs no pruning; its TTL
expires keys on its own.

Both the Postgres and Redis stores take an optional `onRetry({ key, attempt })`
hook, called when a waiter has to retry because the holder failed. Point it at a
log line or a counter to see contention, and a key whose effect fails every time,
before it reaches the retry cap.

### `createRedisStore(redis, options?)`

A store backed by Redis and safe across processes. The claim is an atomic
`SET ... NX PX`; the TTL (`options.ttlSeconds`, default one day) is both the dedup
window and the retention policy, so there is nothing to prune. `redis` is a small
four-method shape (`setClaim`/`setIfValue`/`get`/`delIfValue`); `fromNodeRedis(client)`
adapts a node-redis v4+ client to it. Each claim carries a random ownership token,
and the result write and the release are compare-and-set / compare-and-delete Lua
scripts (exported as `SET_IF_VALUE_LUA` / `DEL_IF_VALUE_LUA` for other adapters), so
a holder whose claim expired can never clobber the caller who took over:

```ts
import { createClient } from "redis";
import { createRedisStore, fromNodeRedis } from "exactly-once-webhooks";

const client = createClient(); await client.connect();
const store = createRedisStore(fromNodeRedis(client));
```

The claim is written with a short `pendingTtlSeconds` (default 30) so a crashed
holder frees the key in seconds, not for the whole dedup window; `pendingTtlSeconds`
must exceed your effect's worst-case duration. Unlike the Postgres store, the Redis
store is **not** transactional with your effect — the effect runs, then the result
is written. Use it when the effect is itself idempotent, or when the dedup window is
the whole requirement; use Postgres when your write must be atomic with the
"handled" record. [`DESIGN.md`](DESIGN.md) spells out the trade-offs.

## Measured, not claimed

From [this run](https://github.com/joshuavivo/exactly-once-webhooks/actions/runs/44756603468) on a
GitHub-hosted runner (Node 22, linux/x64) against real Postgres 16 and Redis 7.
Reproduce with `npm run bench` (add `DATABASE_URL` / `REDIS_URL` for the servers).

| store | distinct keys, calls/s | p50 | p99 | 100 copies of one event → effect runs | all 100 answered in |
|---|---:|---:|---:|---:|---:|
| memory | 494,325 | 0.06 ms | 0.23 ms | 1 | 19.7 ms |
| postgres | 1,902 | 8.9 ms | 120 ms | 1 | 150 ms |
| redis | 43,220 | 0.66 ms | 3.4 ms | 1 | 22.6 ms |

How to read it:
- **The column that matters is "effect runs": 1 every time.** The benchmark fails
  the run if it is ever more.
- **Postgres pays for its guarantee.** Each call is a transaction with a row lock,
  so it's ~2k calls/s here with 32 in flight, and a p99 of 120 ms. In return, the
  effect commits atomically with the record. A shared CI runner is noisy, so treat
  the tail as an upper bound, not a promise.
- **Hot key ≈ the effect's own time.** With a 20 ms effect, the 99 waiters get their
  answer about when the one real run finishes: memory and Redis add ~0–3 ms. The
  Redis row uses `pollIntervalMs: 2` (bench.ts); at the default of 25 a waiter can
  add up to ~25 ms, the cost of polling instead of blocking.
  Postgres adds more, because each waiter blocks on `FOR UPDATE` holding a
  connection (DESIGN limitation 6, issue #11).

## What this is not

- Not a queue or a retry scheduler — it makes *your* handler safe to call more
  than once; your framework still receives and acks the webhook.
- Not a signature verifier — verify the provider's signature before calling
  `run`.
- Not a dependency to be scared of — it is a few hundred lines with no runtime
  dependencies, and you can read all of it.

## Design and limitations

[`DESIGN.md`](DESIGN.md) states the guarantee precisely (exactly-once *processing*
on an at-least-once *delivery* channel), walks through the two race conditions each
store closes, and — importantly — lists what this library does **not** do: table
growth needs a retention job, the memory store only dedups within its window, slow
effects hold a lock, and stored results must be JSON-serialisable. Read it before
putting real money through this.

## Development

```
npm install
npm test            # node --test, runs the full contract against the memory store
npm run typecheck

# Run the same contract against a real Postgres:
docker compose up -d
DATABASE_URL=postgres://eow:eow@localhost:5433/eow npm test
docker compose down
```

All three stores are held to the one shared contract in [`test/contract.ts`](test/contract.ts).

## Credits

Architected and directed by [Joshua Vivo](https://github.com/joshuavivo) ([Shadow Vivo LLC](https://shadowvivo.com)), built with AI assistance (Claude). The design and the judgment are mine.

## License

MIT

