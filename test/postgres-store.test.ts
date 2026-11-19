import { test } from "node:test";
import assert from "node:assert/strict";
import { createPostgresStore, pruneExpiredKeys, type Pool } from "../src/postgres-store.ts";
import { runContract } from "./contract.ts";

// These tests run against a real Postgres only when DATABASE_URL is set, so CI
// stays green with no services. They connect through `pg` when it is available.
const url = process.env.DATABASE_URL;

async function loadPool(): Promise<Pool | null> {
  if (!url) return null;
  try {
    // Indirect specifier: `pg` is an optional peer, not a dependency, so this
    // must not be a hard import the type-checker tries to resolve.
    const specifier = "pg";
    const pg = (await import(specifier)) as { default: { Pool: new (cfg: { connectionString: string }) => unknown } };
    const pool = new pg.default.Pool({ connectionString: url });
    return pool as unknown as Pool;
  } catch {
    return null;
  }
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

test("pruneExpiredKeys rejects a bad table name and a negative window", async () => {
  const fakePool = { async connect() { throw new Error("unused"); } } as unknown as Pool;
  await assert.rejects(() => pruneExpiredKeys(fakePool, { olderThanSeconds: 1, table: "t; drop" }), /invalid table name/);
  await assert.rejects(() => pruneExpiredKeys(fakePool, { olderThanSeconds: -1 }), /non-negative/);
});

// Keep the pool from holding the process open after a DATABASE_URL run.
test("close the pool", { skip: url ? false : true }, async () => {
  const pool = await loadPool();
  const closable = pool as unknown as { end?: () => Promise<void> } | null;
  if (closable?.end) await closable.end();
});
