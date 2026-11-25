import type { IdempotencyStore, Outcome, RetryInfo } from "./types.ts";

// The library does not depend on the `pg` package. It asks only for the small
// slice of a pool/client it actually uses, so it works with `pg`, `pg-pool`, or
// any wrapper that can hand out a client and run parameterised queries.

export interface Queryable {
  query(sql: string, params?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
}

export interface PoolClient extends Queryable {
  /** pg's PoolClient: release(err) destroys the connection instead of reusing it. */
  release(err?: Error | boolean): void;
}

export interface Pool {
  connect(): Promise<PoolClient>;
}

export type PostgresStoreOptions = {
  /** Table that holds the idempotency keys. Default "idempotency_keys". */
  table?: string;
  /** Called when a waiter has to retry its claim. Optional, a no-op when absent;
   *  an exception from it is ignored so observability can never break the store.
   *  Note: on Postgres this is rare. A waiter's INSERT blocks on the holder's
   *  uncommitted row and claims the key directly if the holder rolls back, so a
   *  rollback does NOT cause a retry. It fires in two cases: a committed row
   *  vanishes between the INSERT and the read (e.g. pruned), or the connection
   *  runs at REPEATABLE READ or SERIALIZABLE, where each waiter takes one more
   *  pass to read the holder's committed result (DESIGN.md, limitation 8). On
   *  Redis it fires on every holder failure. */
  onRetry?: (info: RetryInfo) => void;
  /** How long a caller waits for ANOTHER caller's claim on the same key before
   *  giving up, in ms. Default 5000; 0 waits forever (the pre-0.9 behaviour).
   *  While it waits, the caller holds a pooled connection, so without a bound one
   *  slow effect on a hot key can starve the pool for unrelated keys (issue #11).
   *  It applies only to the claim and the wait, never to your effect's own
   *  statements. A timed-out caller throws; the provider's redelivery tries again. */
  lockTimeoutMs?: number;
};

/**
 * Postgres-backed store. Safe across many processes: the guarantee rests on the
 * UNIQUE constraint on the key. A second insert of the same key waits for the
 * first transaction to end, so two servers that receive the same event at the
 * same instant cannot both run the effect.
 *
 * The effect runs inside the same transaction as the idempotency record, and is
 * given that transaction's client as its context, so the effect's own writes and
 * the "this key is done" record commit together or not at all.
 *
 * Requires the schema in schema.sql (a table with a UNIQUE/PRIMARY KEY `key`).
 */
// Cap on claim passes. A holder that rolls back does NOT cause a retry: the
// waiter's INSERT is blocked on the holder's uncommitted row and simply claims the
// key when the rollback lands (issue #24). There are two ways back round the loop:
// a committed row that disappears between our INSERT and our read (a prune), and
// a serialization failure (40001) on the claim at REPEATABLE READ or SERIALIZABLE,
// which normally takes one more pass. The cap turns a case that keeps repeating
// into an error instead of an unbounded spin.
const MAX_CLAIM_ATTEMPTS = 50;

export function createPostgresStore(pool: Pool, options: PostgresStoreOptions = {}): IdempotencyStore<Queryable> {
  const table = options.table ?? "idempotency_keys";
  // The table name comes from the application, never from event data; it is not
  // a place for user input. Guard it anyway so a typo fails loudly.
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(table)) {
    throw new Error(`invalid table name: ${JSON.stringify(table)}`);
  }

  const lockTimeoutMs = options.lockTimeoutMs ?? 5000;
  if (!Number.isInteger(lockTimeoutMs) || lockTimeoutMs < 0) {
    throw new Error(`lockTimeoutMs must be a non-negative integer, got ${JSON.stringify(lockTimeoutMs)}`);
  }

  async function run<T>(key: string, effect: (ctx: Queryable) => Promise<T>): Promise<Outcome<T>> {
    // A loop, not recursion: each pass either resolves the key or goes round again
    // (see MAX_CLAIM_ATTEMPTS above for the two reasons). Bounded so a case that
    // keeps repeating raises a clear error instead of spinning without end.
    // Set when a pass ends in a serialization failure on the claim, cleared at the
    // start of the next: after the cap it says whether the last pass ended that way.
    let lastClaimError: unknown;
    for (let attempt = 1; attempt <= MAX_CLAIM_ATTEMPTS; attempt++) {
      lastClaimError = undefined;
      const client = await pool.connect();
      // Set only when ROLLBACK itself fails: the connection is in an unknown state,
      // so it is destroyed on release instead of going back to the pool.
      let broken: Error | undefined;
      // True once the effect has been called. A serialization failure before that
      // point came from the claim; one after it belongs to the caller's own work.
      let effectStarted = false;
      try {
        await client.query("BEGIN");
        // Bound the wait on another caller's claim (issue #11). SET LOCAL lasts
        // only for this transaction; it is dropped again before the effect runs.
        // set_config(name, value, is_local=true) is SET LOCAL with the value bound
        // as a parameter, so no number is ever spliced into the SQL text.
        await client.query("SELECT set_config('lock_timeout', $1, true)", [String(lockTimeoutMs)]);

        // Claim the key. If another transaction holds an uncommitted row for it,
        // this INSERT waits for it to end: zero rows on its COMMIT (at READ
        // COMMITTED; a 40001 at stricter levels, handled in the catch below), ours
        // on ROLLBACK.
        const claimed = await client.query(
          `INSERT INTO ${table} (key, status) VALUES ($1, 'pending')
           ON CONFLICT (key) DO NOTHING
           RETURNING key`,
          [key],
        );

        if (claimed.rows.length === 1) {
          // We hold the key. Drop our claim timeout so the effect's statements are
          // not bound by it. TO DEFAULT means the server/role default, NOT a value
          // the app SET on this connection: that one is back after COMMIT, but the
          // effect itself runs without it (DESIGN.md, limitation 6).
          await client.query("SET LOCAL lock_timeout TO DEFAULT");
          effectStarted = true;
          const result = await effect(client);
          await client.query(
            `UPDATE ${table} SET status = 'done', result = $2, completed_at = now() WHERE key = $1`,
            [key, JSON.stringify(result ?? null)],
          );
          await client.query("COMMIT");
          return { status: "processed", result };
        }

        // Someone else claimed the key first. Our INSERT already waited for their
        // transaction to end (had they rolled back, it would have claimed the key
        // instead), so the row we read now is committed and 'done', unless a prune
        // removed it in between (handled below).
        const seen = await client.query(
          `SELECT status, result FROM ${table} WHERE key = $1 FOR UPDATE`,
          [key],
        );
        await client.query("COMMIT");

        const row = seen.rows[0];
        if (row && row.status === "done") {
          return { status: "duplicate", result: row.result as T };
        }
        // No committed row. A committed row is always 'done', and a holder's
        // rollback would already have let our INSERT claim the key, so this is
        // reached only if a done row vanished between the INSERT and this read
        // (pruneExpiredKeys ran in between). Try again from the top.
        if (options.onRetry) {
          try { options.onRetry({ key, attempt }); } catch { /* observability must not break the store */ }
        }
      } catch (err) {
        await client.query("ROLLBACK").catch((rollbackErr: unknown) => {
          broken = rollbackErr instanceof Error ? rollbackErr : new Error(String(rollbackErr));
        });
        // At REPEATABLE READ or SERIALIZABLE the blocked INSERT does not return
        // zero rows when the holder commits: Postgres raises 40001, because the
        // row it conflicted with is not in this transaction's snapshot. The event
        // was handled by the holder, so look again in a new transaction, which
        // sees the committed row and returns it as a duplicate. Only before the
        // effect: a 40001 from the effect's own statements, or from the commit
        // after it, goes to the caller like any other failure.
        if ((err as { code?: string }).code === "40001" && !effectStarted && !broken) {
          lastClaimError = err;
          if (options.onRetry) {
            try { options.onRetry({ key, attempt }); } catch { /* observability must not break the store */ }
          }
          continue;
        }
        if ((err as { code?: string }).code === "55P03") {
          throw new Error(
            `timed out after ${lockTimeoutMs}ms waiting for key ${JSON.stringify(key)} ` +
              "(another caller holds it; the next delivery will retry)",
            { cause: err },
          );
        }
        throw err;
      } finally {
        client.release(broken);
      }
    }
    throw new Error(
      `could not claim key ${JSON.stringify(key)} after ${MAX_CLAIM_ATTEMPTS} attempts; ` +
        (lastClaimError
          ? "the claim was still failing with a serialization error (40001)"
          : "its row keeps disappearing between claim and read (a prune racing this key?)"),
      lastClaimError ? { cause: lastClaimError } : undefined,
    );
  }

  return { run };
}

/**
 * Delete processed keys older than `olderThanSeconds`, to keep the table from
 * growing forever. Run it on a schedule (a cron, a worker) with a window well
 * past your provider's retry window — a key pruned too early stops deduplicating a
 * still-possible redelivery. Returns the number of rows deleted.
 *
 * This is the retention job the Postgres store needs and the Redis store does not
 * (Redis expires keys by TTL on its own). It is intentionally a plain `DELETE`, so
 * you can run the SQL yourself instead:
 *
 *   DELETE FROM idempotency_keys
 *   WHERE completed_at IS NOT NULL AND completed_at < now() - interval '7 days';
 */
export async function pruneExpiredKeys(
  pool: Pool,
  options: { olderThanSeconds: number; table?: string },
): Promise<number> {
  const table = options.table ?? "idempotency_keys";
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(table)) {
    throw new Error(`invalid table name: ${JSON.stringify(table)}`);
  }
  if (!Number.isFinite(options.olderThanSeconds) || options.olderThanSeconds < 0) {
    throw new Error("olderThanSeconds must be a non-negative number");
  }
  const client = await pool.connect();
  try {
    // make_interval keeps the window a bound parameter, never string-concatenated SQL.
    const res = await client.query(
      `DELETE FROM ${table} WHERE completed_at IS NOT NULL AND completed_at < now() - make_interval(secs => $1)`,
      [options.olderThanSeconds],
    );
    return (res as { rowCount?: number | null }).rowCount ?? 0;
  } finally {
    client.release();
  }
}
