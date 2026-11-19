import { test } from "node:test";
import assert from "node:assert/strict";
import { createPostgresStore, type Pool } from "../src/postgres-store.ts";
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

// Keep the pool from holding the process open after a DATABASE_URL run.
test("close the pool", { skip: url ? false : true }, async () => {
  const pool = await loadPool();
  const closable = pool as unknown as { end?: () => Promise<void> } | null;
  if (closable?.end) await closable.end();
});
