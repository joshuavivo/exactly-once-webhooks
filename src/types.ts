// The one job of this library: run a side effect once per key, even when the same
// event is delivered several times or two copies arrive at the same moment. How
// strongly depends on the store (DESIGN.md, "The guarantee, stated precisely").
//
// A payment provider retries a webhook until it gets a 2xx, so the same "charge
// succeeded" event can land two or three times. If each delivery credits the
// customer, the customer is credited two or three times. The fix is to tie the
// effect to the event's own id and let the storage layer guarantee it runs once.

/**
 * Passed to an `onRetry` hook when a caller has to try to claim a key again:
 * because the holder it was waiting on failed (rolled back, or its claim
 * vanished), or, on Postgres at REPEATABLE READ or SERIALIZABLE, because the
 * holder committed and the waiter needs a new transaction to see the result.
 * `attempt` counts this caller's retries for this call: 1 on the first.
 * A steady trickle is normal contention; a key whose `attempt` keeps climbing has
 * an effect that is failing every time, and will error at the store's cap.
 */
export type RetryInfo = { key: string; attempt: number };

/** What happened on this call. */
export type Outcome<T> = {
  /**
   * "processed" — this call ran the effect; `result` is what it returned.
   * "duplicate" — the effect had already run for this key; `result` is the
   *               value the first run stored, returned without running again.
   *               Every store keeps it as JSON, so a duplicate gets the JSON copy:
   *               a Date comes back as its ISO string, undefined as null, and a
   *               class instance as a plain object. Return plain data.
   */
  status: "processed" | "duplicate";
  result: T;
  /**
   * Set only by the Redis store, only on "processed": this call ran the effect,
   * but its claim expired before the effect finished, so this result was not
   * recorded. Either another caller took the key over (the effect may have run
   * twice), or nobody did (the key is free, so the next delivery runs the effect
   * again). See DESIGN.md, limitation 4. Log or alert on it; if it happens, raise
   * `pendingTtlSeconds` above your slowest effect.
   */
  lostClaim?: true;
};

/**
 * A place that remembers which keys have been handled and serialises concurrent
 * calls for the same key. Three implementations ship with the library: in-memory
 * (tests and single-process use), Postgres (atomic with a DB effect, across
 * processes) and Redis (across processes, for idempotent effects). Any store that
 * honours the contract in test/contract.ts is a valid implementation — all three
 * ship implementations run it.
 */
export interface IdempotencyStore<Ctx = unknown> {
  /**
   * Run `effect` once for `key`, as strongly as the store allows: fully on Postgres
   * within the retention window, a lease on Redis (limitations 3 and 4), one process
   * and `maxEntries` in memory. See DESIGN.md, "The guarantee, stated precisely".
   *
   * - The first call for a key runs `effect`, stores its result, and returns
   *   `{ status: "processed" }`.
   * - Any later call for the same key returns the stored result with
   *   `{ status: "duplicate" }` and does NOT run `effect` again (within the
   *   store's limits above).
   * - If several calls for the same key run concurrently, one runs the effect;
   *   the others wait for it and return `{ status: "duplicate" }`. (Redis: while
   *   the holder's lease lasts; past it, two can run and the late one gets
   *   `lostClaim: true`.)
   * - If `effect` throws, nothing is stored for the key and the error is
   *   re-thrown, so a later delivery can retry it.
   *
   * `effect` receives a context value (a database transaction for the Postgres
   * store) so the effect and the idempotency record commit together.
   */
  run<T>(key: string, effect: (ctx: Ctx) => Promise<T>): Promise<Outcome<T>>;
}
