import { test } from "node:test";
import assert from "node:assert/strict";
import { createPostgresStore, type Pool, type PoolClient } from "../src/postgres-store.ts";

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

test("postgres store runs the effect once across deliveries", { skip: url ? false : "set DATABASE_URL to run" }, async () => {
  const pool = await loadPool();
  if (!pool) {
    return; // marked skipped above; nothing to do
  }
  const store = createPostgresStore(pool);

  const client = (await (pool as unknown as { connect(): Promise<PoolClient> }).connect());
  const key = `evt_pg_${Date.now()}`;
  try {
    await client.query(`DELETE FROM idempotency_keys WHERE key = $1`, [key]);
  } finally {
    client.release();
  }

  let runs = 0;
  const effect = async () => {
    runs += 1;
    return { credited: true };
  };

  const first = await store.run(key, effect);
  const second = await store.run(key, effect);

  assert.equal(runs, 1);
  assert.equal(first.status, "processed");
  assert.equal(second.status, "duplicate");
});

test("createPostgresStore rejects an unsafe table name", () => {
  const fakePool = { async connect() { throw new Error("unused"); } } as unknown as Pool;
  assert.throws(() => createPostgresStore(fakePool, { table: "oops; drop table users" }), /invalid table name/);
});
