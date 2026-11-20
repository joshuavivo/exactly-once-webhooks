import { test } from "node:test";
import assert from "node:assert/strict";
import { createPostgresStore, pruneExpiredKeys, type Pool } from "../src/postgres-store.ts";
import { runContract } from "./contract.ts";
import { loadSchema } from "./pg-schema.ts";

// These tests run against a real Postgres only when DATABASE_URL is set (CI sets it
// via a service container); otherwise they skip, so a plain `npm test` needs no
// services. They connect through `pg` when it is available.
const url = process.env.DATABASE_URL;

async function loadPool(): Promise<Pool | null> {
  if (!url) return null;
  // Only a missing `pg` module means "can't run here". Any other failure (the
  // schema load, the connection) must surface with its real message, not be
  // swallowed into a vague "pg could not be loaded".
  let pg: { default: { Pool: new (cfg: { connectionString: string }) => unknown } };
  try {
    // Indirect specifier so the type-checker doesn't hard-resolve `pg`.
    const specifier = "pg";
    pg = (await import(specifier)) as typeof pg;
  } catch {
    return null;
  }
  const pool = new pg.default.Pool({ connectionString: url }) as unknown as Pool;
  // Ensure the table exists, so the CI run is self-contained (no psql step).
  const client = await pool.connect();
  try {
    await loadSchema(client, [new URL("../schema.sql", import.meta.url)]);
  } finally {
    client.release();
  }
  return pool;
}

// The Postgres store is held to the exact same behavioural contract as the memory
// store — when DATABASE_URL is set. The table is durable across runs, so keys are
// salted with a per-run id to avoid colliding with a previous suite.
if (url) {
  const runId = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  let shared: Pool | null = null;
  runContract({
    label: "postgres",
    makeStore: async () => {
      if (!shared) shared = await loadPool();
      if (!shared) throw new Error("DATABASE_URL set but pg could not be loaded");
      return createPostgresStore(shared);
    },
    makeKey: (name) => `evt_pg_${runId}_${name}`,
  });
  // Postgres hands a rolled-back claim straight to the waiter: the waiter's
  // INSERT ... ON CONFLICT DO NOTHING blocks on the holder's uncommitted row and,
  // when the holder rolls back, inserts and claims. No retry pass happens, so
  // onRetry stays silent. (CI showed this; the first version of this test assumed
  // a retry and failed. See the issue on the now-unreachable retry path.)
  test("[postgres] a rolled-back claim passes straight to the blocked waiter, with no retry", async () => {
    const pool = await loadPool();
    if (!pool) throw new Error("DATABASE_URL set but pg could not be loaded");
    const retries: Array<{ key: string; attempt: number }> = [];
    const store = createPostgresStore(pool, { onRetry: (i) => retries.push(i) });
    const key = `evt_pg_${runId}_onretry`;
    const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

    const holder = store.run(key, async () => { await pause(150); throw new Error("holder failed"); });
    await pause(40); // holder has inserted its pending row; the waiter blocks on FOR UPDATE
    const waiter = store.run(key, async () => "second try");
    await assert.rejects(holder, /holder failed/);

    assert.deepEqual(await waiter, { status: "processed", result: "second try" });
    assert.deepEqual(retries, [], "no retry pass: the blocked INSERT took over the claim");
    await (pool as unknown as { end(): Promise<void> }).end();
  });

  // Close the SHARED pool the contract used, or its open handles keep the process
  // alive and the CI job hangs. (Runs after the contract tests above.)
  test("close the postgres pool", async () => {
    const closable = shared as unknown as { end?: () => Promise<void> } | null;
    if (closable?.end) await closable.end();
  });
} else {
  test("postgres contract (skipped: set DATABASE_URL to run)", { skip: true }, () => {});
}

// A unit test that needs no database: the table-name guard.
test("createPostgresStore rejects an unsafe table name", () => {
  const fakePool = { async connect() { throw new Error("unused"); } } as unknown as Pool;
  assert.throws(
    () => createPostgresStore(fakePool, { table: "oops; drop table users" }),
    /invalid table name/,
  );
});

// pruneExpiredKeys, verified against a fake pool (no database): the DELETE is
// windowed with a bound parameter, and the deleted count is returned.
test("pruneExpiredKeys issues a windowed DELETE and returns the row count", async () => {
  const calls: Array<{ sql: string; params?: unknown[] }> = [];
  const fakeClient = {
    async query(sql: string, params?: unknown[]) {
      calls.push({ sql, params });
      return { rows: [], rowCount: 3 };
    },
    release() {},
  };
  const fakePool = { async connect() { return fakeClient; } } as unknown as Pool;

  const deleted = await pruneExpiredKeys(fakePool, { olderThanSeconds: 7 * 86_400 });

  assert.equal(deleted, 3);
  assert.match(calls[0]!.sql, /DELETE FROM idempotency_keys/);
  assert.match(calls[0]!.sql, /make_interval\(secs => \$1\)/);
  assert.deepEqual(calls[0]!.params, [604_800]);
});

test("a claim that never resolves gives up with a bounded error, not an infinite loop", async () => {
  // The INSERT always loses the claim (0 rows) and the SELECT always finds no
  // committed row (holder rolled back), so every pass retries. The loop is bounded.
  const fakeClient = {
    async query(sql: string) {
      void sql;
      return { rows: [] as Array<Record<string, unknown>> }; // BEGIN/INSERT/SELECT/COMMIT all empty
    },
    release() {},
  };
  const fakePool = { async connect() { return fakeClient; } } as unknown as Pool;
  await assert.rejects(
    () => createPostgresStore(fakePool).run("k", async () => "x"),
    /after \d+ attempts/,
  );
});

test("pruneExpiredKeys rejects a bad table name and a negative window", async () => {
  const fakePool = { async connect() { throw new Error("unused"); } } as unknown as Pool;
  await assert.rejects(() => pruneExpiredKeys(fakePool, { olderThanSeconds: 1, table: "t; drop" }), /invalid table name/);
  await assert.rejects(() => pruneExpiredKeys(fakePool, { olderThanSeconds: -1 }), /non-negative/);
});

