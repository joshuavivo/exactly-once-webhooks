import { test } from "node:test";
import assert from "node:assert/strict";
import { createPostgresStore, type Pool } from "../../src/index.ts";
import { sign } from "./signature.ts";
import { createPaymentHandler, type PaymentEvent } from "./handler.ts";
import { applyToPgLedger, pgBalance } from "./pg-ledger.ts";
import { loadSchema } from "../../test/pg-schema.ts";

// The same path against a real Postgres: the ledger row and the idempotency
// record in ONE transaction, and the database itself refusing edits. Runs when
// DATABASE_URL is set (CI provides a Postgres service); skips otherwise.

const url = process.env.DATABASE_URL;
const SECRET = "whsec_test_only";
const NOW = 1_800_000_000;
// Tables are durable across runs, so every id in this file carries a run prefix.
const run = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

async function connect(): Promise<Pool & { end(): Promise<void> }> {
  const specifier = "pg";
  const pg = (await import(specifier)) as { default: { Pool: new (c: { connectionString: string; max: number }) => unknown } };
  const pool = new pg.default.Pool({ connectionString: url!, max: 25 }) as Pool & { end(): Promise<void> };
  const c = await pool.connect();
  try {
    // Shared with the store tests, which load the schema in parallel: see pg-schema.ts.
    await loadSchema(c, [new URL("../../schema.sql", import.meta.url), new URL("./ledger.sql", import.meta.url)]);
  } finally {
    c.release();
  }
  return pool;
}

const event = (n: string, account: string, cents = 5000): PaymentEvent => ({
  id: `evt_${run}_${n}`,
  type: "charge.succeeded",
  data: { charge: `ch_${run}_${n}`, account, amount_cents: cents },
});
const signed = (e: object) => {
  const body = JSON.stringify(e);
  return { body, sig: sign(body, SECRET, NOW) };
};

if (!url) {
  test("payment path on Postgres (skipped: set DATABASE_URL to run)", { skip: true }, () => {});
} else {
  const poolP = connect();
  const db = async () => {
    const pool = await poolP;
    return { query: async (sql: string, p?: unknown[]) => { const c = await pool.connect(); try { return await c.query(sql, p); } finally { c.release(); } } };
  };

  test("pg: 20 concurrent copies of one event write exactly one ledger row", async () => {
    const pool = await poolP;
    const acct = `acct_${run}_race`;
    const h = createPaymentHandler({ secret: SECRET, store: createPostgresStore(pool), apply: applyToPgLedger, now: () => NOW });
    const { body, sig } = signed(event("race", acct));
    const res = await Promise.all(Array.from({ length: 20 }, () => h.handle(body, sig)));
    assert.equal(res.filter((r) => r.body === "processed").length, 1);
    assert.equal(res.filter((r) => r.body === "duplicate").length, 19);
    const { rows } = await (await db()).query("SELECT count(*)::int AS n FROM ledger_entries WHERE account = $1", [acct]);
    assert.equal(rows[0]!.n, 1);
    assert.equal(await pgBalance(await db(), acct), 5000);
  });

  test("pg: a write that fails after inserting rolls back the row AND the key together", async () => {
    const pool = await poolP;
    const acct = `acct_${run}_rollback`;
    let fail = true;
    // Insert the ledger row, THEN fail: proves the insert is inside the store's
    // transaction, because it disappears with the rollback.
    const apply = async (e: PaymentEvent, tx: Parameters<typeof applyToPgLedger>[1]) => {
      await applyToPgLedger(e, tx);
      if (fail) throw new Error("crash after the insert");
    };
    const h = createPaymentHandler({ secret: SECRET, store: createPostgresStore(pool), apply, now: () => NOW });
    const e = event("rollback", acct);
    const { body, sig } = signed(e);

    assert.equal((await h.handle(body, sig)).status, 500);
    const q = await db();
    assert.equal((await q.query("SELECT count(*)::int AS n FROM ledger_entries WHERE account = $1", [acct])).rows[0]!.n, 0, "no orphan ledger row");
    assert.equal((await q.query("SELECT count(*)::int AS n FROM idempotency_keys WHERE key = $1", [e.id])).rows[0]!.n, 0, "no key marked done");

    fail = false; // the provider retries
    assert.equal((await h.handle(body, sig)).body, "processed");
    assert.equal(await pgBalance(q, acct), 5000);
  });

  test("pg: the database itself refuses UPDATE, DELETE and TRUNCATE on the ledger", async () => {
    const pool = await poolP;
    const acct = `acct_${run}_immutable`;
    const h = createPaymentHandler({ secret: SECRET, store: createPostgresStore(pool), apply: applyToPgLedger, now: () => NOW });
    const { body, sig } = signed(event("immutable", acct));
    await h.handle(body, sig);
    const q = await db();
    await assert.rejects(() => q.query("UPDATE ledger_entries SET amount_cents = 1 WHERE account = $1", [acct]), /append-only: UPDATE/);
    await assert.rejects(() => q.query("DELETE FROM ledger_entries WHERE account = $1", [acct]), /append-only: DELETE/);
    await assert.rejects(() => q.query("TRUNCATE ledger_entries"), /append-only: TRUNCATE/);
    assert.equal(await pgBalance(q, acct), 5000);
  });

  test("pg: a refund is a reversal row; a second reversal is refused by the schema", async () => {
    const pool = await poolP;
    const acct = `acct_${run}_refund`;
    const h = createPaymentHandler({ secret: SECRET, store: createPostgresStore(pool), apply: applyToPgLedger, now: () => NOW, maxAttempts: 1 });
    const c = event("refund", acct);
    await h.handle(...Object.values(signed(c)) as [string, string]);
    const refund = (n: string) => signed({ id: `evt_${run}_${n}`, type: "charge.refunded", data: { charge: c.data.charge, account: acct, amount_cents: 5000 } });
    assert.equal((await h.handle(refund("r1").body, refund("r1").sig)).body, "processed");
    // A DIFFERENT refund event for the same charge (not a redelivery): the
    // idempotency key is new, so only the UNIQUE(reverses) constraint stops it.
    assert.equal((await h.handle(refund("r2").body, refund("r2").sig)).body, "dead-lettered");
    assert.equal(await pgBalance(await db(), acct), 0);
  });

  test("pg: a partial refund is dead-lettered, the charge stays whole", async () => {
    const pool = await poolP;
    const acct = `acct_${run}_partial`;
    const h = createPaymentHandler({ secret: SECRET, store: createPostgresStore(pool), apply: applyToPgLedger, now: () => NOW });
    const c = event("partial", acct);
    const cs = signed(c);
    await h.handle(cs.body, cs.sig);
    const r = signed({ id: `evt_${run}_partial_r`, type: "charge.refunded", data: { charge: c.data.charge, account: acct, amount_cents: 1000 } });
    assert.equal((await h.handle(r.body, r.sig)).body, "dead-lettered");
    assert.equal(await pgBalance(await db(), acct), 5000);
  });

  test("pg: close the pool", async () => {
    await (await poolP).end();
  });
}
