# The whole payment path, in one place

Signature check → exactly-once → append-only ledger row → dead letter, wired
together and tested, so you can read the full path in five minutes instead of
across four repos.

```
node examples/payment-path/demo.ts    # the story, no services
npm test                              # every test, including these
make db-test                          # + the Postgres version against a real database
```

| Step | File | What it guarantees | Proven by |
|---|---|---|---|
| 1. Signature | `signature.ts` | Only the provider's requests, only recent ones. HMAC over the **raw** body, constant-time compare, timestamp tolerance, secret rotation. | tampered body, wrong secret, missing header, stale timestamp, rotated secret |
| 2. Exactly once | the library's store | One event id runs the ledger write once, even when copies race. | 20 concurrent copies → 1 row (memory **and** Postgres) |
| 3. Ledger | `ledger.ts`, `ledger.sql`, `pg-ledger.ts` | Append-only. Refunds are reversal rows. On Postgres a trigger rejects UPDATE/DELETE/TRUNCATE, `event_id` and `reverses` are UNIQUE, and the row commits **in the same transaction** as the idempotency key. | insert-then-crash leaves neither row nor key; UPDATE/DELETE/TRUNCATE rejected; second reversal refused by the schema |
| 4. Dead letter | `handler.ts` | A genuine event that can't be applied is parked for a person and acknowledged, so the provider stops retrying. Replay goes through the same exactly-once path. | 500, 500, then parked; replay after the fix writes once; a failed replay keeps the letter |

## The decisions, and why

- **Bad signature → 400, nothing stored.** It isn't from the provider, so it is
  never trusted, logged as an event, or dead-lettered.
- **Genuine but unappliable → dead letter + 200.** A malformed payload, or a write
  that has failed `maxAttempts` times, fails the same way every retry. Answering 500
  forever just burns the provider's retry budget and hides the problem. Parking it
  makes it a person's job, with the reason attached.
- **Transient failure → 500.** The store records nothing for a failed write, so the
  provider's next retry runs it again, cleanly.
- **Two guards, not one.** `idempotency_keys` stops the second run; `UNIQUE(event_id)`
  on the ledger stops a second row even if someone calls the ledger without the
  store. Defence that doesn't depend on every caller doing it right.

## What this example does not do

It is a teaching-size path, not a product:
- The failure counter and the dead letters live in memory. In production they are
  a table (or the provider's attempt header), so they survive a restart.
- One currency, integer cents, no FX, no partial refunds.
- No HTTP server: `handle(rawBody, signatureHeader)` is what your route calls with
  the unparsed body (in Express, `express.raw({ type: "application/json" })`).

---
Architected and directed by Joshua Vivo (Shadow Vivo LLC), built with AI assistance
(Claude). The design and the judgment are mine.
