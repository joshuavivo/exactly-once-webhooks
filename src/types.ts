// The one job of this library: run a side effect at most once per key, even when
// the same event is delivered several times or two copies arrive at the same moment.
//
// A payment provider retries a webhook until it gets a 2xx, so the same "charge
// succeeded" event can land two or three times. If each delivery credits the
// customer, the customer is credited two or three times. The fix is to tie the
// effect to the event's own id and let the storage layer guarantee it runs once.

/** What happened on this call. */
export type Outcome<T> = {
  /**
   * "processed" — this call ran the effect; `result` is what it returned.
   * "duplicate" — the effect had already run for this key; `result` is the
   *               value the first run stored, returned without running again.
   */
  status: "processed" | "duplicate";
  result: T;
};

/**
 * A place that remembers which keys have been handled and serialises concurrent
 * calls for the same key. Two implementations ship with the library: an
 * in-memory one (for tests and single-process use) and a Postgres one (for real,
 * multi-process deployments). Any store that honours the contract in
 * test/contract.test.ts is a valid implementation.
 */
export interface IdempotencyStore<Ctx = unknown> {
  /**
   * Run `effect` at most once for `key`.
   *
   * - The first call for a key runs `effect`, stores its result, and returns
   *   `{ status: "processed" }`.
   * - Any later call for the same key returns the stored result with
   *   `{ status: "duplicate" }` and does NOT run `effect` again.
   * - If several calls for the same key run concurrently, exactly one runs the
   *   effect; the others wait for it and return `{ status: "duplicate" }`.
   * - If `effect` throws, nothing is stored for the key and the error is
   *   re-thrown, so a later delivery can retry it.
   *
   * `effect` receives a context value (a database transaction for the Postgres
   * store) so the effect and the idempotency record commit together.
   */
  run<T>(key: string, effect: (ctx: Ctx) => Promise<T>): Promise<Outcome<T>>;
}
