import type { IdempotencyStore, Outcome, RetryInfo } from "./types.ts";

// The library does not depend on the `pg` package. It asks only for the small
// slice of a pool/client it actually uses, so it works with `pg`, `pg-pool`, or
// any wrapper that can hand out a client and run parameterised queries.

export interface Queryable {
  query(sql: string, params?: unknown[]): Promise<{ rows: Array<Record<string, unknown>> }>;
}

export interface PoolClient extends Queryable {
  release(): void;
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
   *  rollback does NOT cause a retry; this fires only if a committed row vanishes
   *  between the INSERT and the read (e.g. pruned). On Redis it fires on every
   *  holder failure. */
  onRetry?: (info: RetryInfo) => void;
};

/**
 * Postgres-backed store. Safe across many processes: the guarantee rests on a
 * UNIQUE constraint on the key plus `SELECT ... FOR UPDATE`, so two servers that
 * receive the same event at the same instant cannot both run the effect.
 *
 * The effect runs inside the same transaction as the idempotency record, and is
 * given that transaction's client as its context, so the effect's own writes and
 * the "this key is done" record commit together or not at all.
 *
 * Requires the schema in schema.sql (a table with a UNIQUE/PRIMARY KEY `key`).
 */
// Cap on claim retries. A retry only happens when a holder rolled back, after
// which the next caller normally claims immediately — so reaching this many means
// an effect is failing deterministically, which should surface as an error, not an
// unbounded spin. Generous enough never to trip under healthy contention.
const MAX_CLAIM_ATTEMPTS = 50;

export function createPostgresStore(pool: Pool, options: PostgresStoreOptions = {}): IdempotencyStore<Queryable> {
  const table = options.table ?? "idempotency_keys";
  // The table name comes from the application, never from event data; it is not
  // a place for user input. Guard it anyway so a typo fails loudly.
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(table)) {
    throw new Error(`invalid table name: ${JSON.stringify(table)}`);
  }

  async function run<T>(key: string, effect: (ctx: Queryable) => Promise<T>): Promise<Outcome<T>> {
    // A loop, not recursion: each pass either resolves the key or retries because a
    // holder rolled back. Bounded so a key whose holder fails deterministically
    // raises a clear error instead of recursing/spinning without end.
    for (let attempt = 1; attempt <= MAX_CLAIM_ATTEMPTS; attempt++) {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");

        // Claim the key. ON CONFLICT DO NOTHING means only the first inserter gets
        // a row back; everyone else gets zero rows and knows to wait.
        const claimed = await client.query(
          `INSERT INTO ${table} (key, status) VALUES ($1, 'pending')
           ON CONFLICT (key) DO NOTHING
           RETURNING key`,
          [key],
        );

        if (claimed.rows.length === 1) {
          const result = await effect(client);
          await client.query(
            `UPDATE ${table} SET status = 'done', result = $2, completed_at = now() WHERE key = $1`,
            [key, JSON.stringify(result ?? null)],
          );
          await client.query("COMMIT");
          return { status: "processed", result };
        }

        // Someone else holds the key. FOR UPDATE blocks until their transaction
        // ends: on their COMMIT the row is 'done'; on their ROLLBACK (the effect
        // threw) no row is visible.
        const seen = await client.query(
          `SELECT status, result FROM ${table} WHERE key = $1 FOR UPDATE`,
          [key],
        );
        await client.query("COMMIT");

        const row = seen.rows[0];
        if (row && row.status === "done") {
          return { status: "duplicate", result: row.result as T };
        }
        // No committed row: a committed row is always 'done' (the 'pending' state
        // only exists inside the holder's uncommitted transaction), so an absent
        // row means the holder rolled back. Retry as the first caller next pass.
        if (options.onRetry) {
          try { options.onRetry({ key, attempt }); } catch { /* observability must not break the store */ }
        }
      } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        throw err;
      } finally {
        client.release();
      }
    }
    throw new Error(
      `could not claim key ${JSON.stringify(key)} after ${MAX_CLAIM_ATTEMPTS} attempts; ` +
        "its holder keeps rolling back (a deterministically failing effect?)",
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
