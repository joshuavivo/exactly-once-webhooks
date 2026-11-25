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
    await pause(40); // holder has inserted its pending row; the waiter's INSERT blocks on it
    const waiter = store.run(key, async () => "second try");
    await assert.rejects(holder, /holder failed/);

    assert.deepEqual(await waiter, { status: "processed", result: "second try" });
    assert.deepEqual(retries, [], "no retry pass: the blocked INSERT took over the claim");
    await (pool as unknown as { end(): Promise<void> }).end();
  });

  test("[postgres] lockTimeoutMs: a slow holder can't starve the pool for other keys (#11)", async () => {
    const specifier = "pg";
    const pg = (await import(specifier)) as { default: { Pool: new (c: object) => unknown } };
    // A deliberately tiny pool: the starvation case from the issue.
    const pool = new pg.default.Pool({ connectionString: url, max: 2 }) as unknown as Pool & { end(): Promise<void> };
    const store = createPostgresStore(pool, { lockTimeoutMs: 200 });
    const hot = `evt_pg_${runId}_hot`;
    const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const holder = store.run(hot, async () => { await gate; return "slow"; }); // connection 1, held
    await pause(50);
    const t0 = Date.now();
    // The waiter takes connection 2 and blocks on the holder's row. It must give
    // up after ~200 ms and hand its connection back...
    await assert.rejects(() => store.run(hot, async () => "never"), /timed out after 200ms waiting for key/);
    // ...so an unrelated key gets that connection promptly instead of queueing
    // behind a wait with no end.
    const other = await store.run(`evt_pg_${runId}_other`, async () => "ok");
    assert.deepEqual(other, { status: "processed", result: "ok" });
    assert.ok(Date.now() - t0 < 2000, `unrelated key waited ${Date.now() - t0} ms`);

    release();
    assert.deepEqual(await holder, { status: "processed", result: "slow" });
    await pool.end();
  });

  // A pool can default to a stricter isolation level than READ COMMITTED (a server
  // or role default, or `options: "-c default_transaction_isolation=..."`). There
  // a waiter's blocked INSERT does not come back with zero rows when the holder
  // commits: Postgres raises 40001, because the row it conflicted with is not in
  // the waiter's snapshot. The store has to turn that into a fresh look, not hand
  // a serialization error to a caller whose event was in fact handled.
  for (const level of ["repeatable read", "serializable"]) {
    test(`[postgres] at ${level}, concurrent deliveries still get one processed and the rest duplicate`, async () => {
      const specifier = "pg";
      const pg = (await import(specifier)) as { default: { Pool: new (c: object) => unknown } };
      const pool = new pg.default.Pool({
        connectionString: url,
        options: `-c default_transaction_isolation=${level.replace(" ", "\\ ")}`,
      }) as unknown as Pool & { end(): Promise<void> };
      const probe = await pool.connect();
      const shown = await probe.query("SHOW transaction_isolation");
      probe.release();
      assert.equal((shown.rows[0] as { transaction_isolation: string }).transaction_isolation, level, "the pool really runs at this level");

      const retries: Array<{ key: string; attempt: number }> = [];
      const store = createPostgresStore(pool, { onRetry: (i) => retries.push(i) });
      const key = `evt_pg_${runId}_iso_${level.replace(" ", "_")}`;
      const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));
      let runs = 0;
      const outcomes = await Promise.all(
        Array.from({ length: 5 }, () => store.run(key, async () => { runs += 1; await pause(20); return "credited"; })),
      );

      assert.equal(runs, 1, "the effect ran once");
      assert.equal(outcomes.filter((o) => o.status === "processed").length, 1);
      assert.equal(outcomes.filter((o) => o.status === "duplicate").length, 4);
      for (const o of outcomes) assert.equal(o.result, "credited");
      // Each of the four waiters takes exactly one extra pass, and the hook is told
      // which key and which attempt.
      assert.deepEqual(retries, Array.from({ length: 4 }, () => ({ key, attempt: 1 })));
      await pool.end();
    });
  }

  test("[postgres] a serialization failure raised by the effect itself is not retried by the store", async () => {
    // Only a 40001 on the claim, before the effect has started, is the store's to
    // absorb. One from the caller's own statements means their transaction lost a
    // conflict: it rolls back and the error goes to the caller, like any other.
    const pool = await loadPool();
    if (!pool) throw new Error("DATABASE_URL set but pg could not be loaded");
    const store = createPostgresStore(pool);
    const key = `evt_pg_${runId}_effect_40001`;
    let runs = 0;
    const failing = async () => {
      runs += 1;
      throw Object.assign(new Error("could not serialize access (from the effect)"), { code: "40001" });
    };
    await assert.rejects(() => store.run(key, failing), /from the effect/);
    assert.equal(runs, 1, "the store did not run the effect again on its own");
    assert.deepEqual(await store.run(key, async () => "ok"), { status: "processed", result: "ok" });
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

// The cap on claim passes, with a fake pool (no database): a claim that fails with
// 40001 every time must stop, release every connection, and say why.
test("a claim that keeps failing with 40001 stops at the cap and names the cause", async () => {
  let connects = 0;
  let releases = 0;
  let effectRuns = 0;
  const serialization = Object.assign(new Error("could not serialize access due to concurrent update"), { code: "40001" });
  const fakePool = {
    async connect() {
      connects += 1;
      return {
        async query(sql: string) {
          if (/INSERT INTO/.test(sql)) throw serialization;
          return { rows: [] };
        },
        release() { releases += 1; },
      };
    },
  } as unknown as Pool;

  const store = createPostgresStore(fakePool);
  await assert.rejects(
    () => store.run("evt_always_40001", async () => { effectRuns += 1; }),
    (err: Error) => {
      assert.match(err.message, /could not claim key "evt_always_40001" after 50 attempts/);
      assert.match(err.message, /still failing with a serialization error \(40001\)/);
      assert.equal(err.cause, serialization);
      return true;
    },
  );
  assert.equal(effectRuns, 0, "the effect never ran");
  assert.equal(connects, 50);
  assert.equal(releases, 50, "every connection went back");
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


// lockTimeoutMs, checked against a fake pool (no database).
function recordingPool(onQuery: (sql: string) => { rows: Array<Record<string, unknown>> } | Error) {
  const sqls: string[] = [];
  const params: unknown[][] = [];
  const client = {
    async query(sql: string, values: unknown[] = []) {
      sqls.push(sql.replace(/\s+/g, " ").trim());
      params.push(values);
      const r = onQuery(sql);
      if (r instanceof Error) throw r;
      return r;
    },
    release() {},
  };
  return { sqls, params, pool: { async connect() { return client; } } as unknown as Pool };
}

test("lockTimeoutMs is set for the claim and reset before the effect runs", async () => {
  const { sqls, params, pool } = recordingPool((sql) => (/INSERT/.test(sql) ? { rows: [{ key: "k" }] } : { rows: [] }));
  let seenBeforeEffect = 0;
  await createPostgresStore(pool, { lockTimeoutMs: 1234 }).run("k", async () => { seenBeforeEffect = sqls.length; return 1; });
  assert.deepEqual(sqls.slice(0, seenBeforeEffect), [
    "BEGIN",
    // set_config(..., true) is SET LOCAL with the value bound, not spliced into the SQL.
    "SELECT set_config('lock_timeout', $1, true)",
    "INSERT INTO idempotency_keys (key, status) VALUES ($1, 'pending') ON CONFLICT (key) DO NOTHING RETURNING key",
    "SET LOCAL lock_timeout TO DEFAULT",
  ]);
  assert.deepEqual(params[1], ["1234"], "the timeout travels as a bound parameter, in ms");
});

test("a lock timeout (55P03) becomes a clear error and the transaction is rolled back", async () => {
  const timeout = Object.assign(new Error("canceling statement due to lock timeout"), { code: "55P03" });
  const { sqls, pool } = recordingPool((sql) => (/INSERT/.test(sql) ? timeout : { rows: [] }));
  await assert.rejects(
    () => createPostgresStore(pool, { lockTimeoutMs: 50 }).run("k", async () => 1),
    (e: Error) => /timed out after 50ms waiting for key "k"/.test(e.message) && (e as Error & { cause?: unknown }).cause === timeout,
  );
  assert.equal(sqls.at(-1), "ROLLBACK");
});

test("lockTimeoutMs must be a non-negative integer", () => {
  const fakePool = { async connect() { throw new Error("unused"); } } as unknown as Pool;
  for (const bad of [-1, 1.5, Number.NaN]) {
    assert.throws(() => createPostgresStore(fakePool, { lockTimeoutMs: bad }), /lockTimeoutMs must be a non-negative integer/);
  }
  assert.doesNotThrow(() => createPostgresStore(fakePool, { lockTimeoutMs: 0 }));
});

test("the retry pass (a done row vanished before the read) reports onRetry and then claims (#24)", async () => {
  let inserts = 0;
  const retries: unknown[] = [];
  const { pool } = recordingPool((sql) => {
    if (/INSERT/.test(sql)) return { rows: inserts++ === 0 ? [] : [{ key: "k" }] }; // lost the first claim...
    return { rows: [] }; // ...and the row was gone by the SELECT (pruned)
  });
  const out = await createPostgresStore(pool, { onRetry: (i) => retries.push(i) }).run("k", async () => "ran");
  assert.deepEqual(out, { status: "processed", result: "ran" });
  assert.deepEqual(retries, [{ key: "k", attempt: 1 }]);
});
