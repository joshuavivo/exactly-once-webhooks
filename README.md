# exactly-once-webhooks

Process a payment webhook **once**, even when the provider delivers it twice or
two copies arrive at the same moment.

A payment provider retries a webhook until it gets a `2xx`, so the same
`charge.succeeded` event can arrive two or three times. If each delivery credits
the customer, the customer is credited two or three times. Worse, two deliveries
can land at the same instant and race past a naive "have I seen this yet?" check.

This library ties the work to the event's own id and lets the storage layer
guarantee it runs once — with a Postgres store that holds up across many servers,
and an in-memory store for tests and single-process use.

```
npm install exactly-once-webhooks
```

No runtime dependencies. Node 22.18+ (it ships as TypeScript and compiled JS).

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

That test is in `test/memory-store.test.ts` and runs on every push.

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
  and return `duplicate`.
- If `effect` throws, nothing is stored and the error is re-thrown, so a later
  delivery can retry.

Use the event's own id as the key — the thing the provider guarantees is stable
across retries.

### `createMemoryStore()`

A store that lives in one process. Good for tests and single-process apps; it
does **not** share state across servers. The effect's context is `undefined`.

### `createPostgresStore(pool, options?)`

A store backed by Postgres and safe across processes. `pool` is anything with the
small `connect()` / `query()` shape `pg` provides. `options.table` defaults to
`"idempotency_keys"`. The effect's context is the transaction's client, so your
writes join the same transaction.

## What this is not

- Not a queue or a retry scheduler — it makes *your* handler safe to call more
  than once; your framework still receives and acks the webhook.
- Not a signature verifier — verify the provider's signature before calling
  `run`.
- Not a dependency to be scared of — it is a few hundred lines with no runtime
  dependencies, and you can read all of it.

## Development

```
npm install
npm test            # node --test, no database needed
npm run typecheck
DATABASE_URL=postgres://... npm test   # also runs the Postgres tests
```

## Credits

Architected and directed by [Joshua Vivo](https://github.com/joshuavivo) ([Shadow Vivo LLC](https://shadowvivo.com)), built with AI assistance (Claude). The design and the judgment are mine.

## License

MIT

