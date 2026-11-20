import { test } from "node:test";
import assert from "node:assert/strict";
import { createMemoryStore } from "../../src/index.ts";
import { sign, verifySignature } from "./signature.ts";
import { Ledger } from "./ledger.ts";
import { applyToLedger, createPaymentHandler, type PaymentEvent } from "./handler.ts";

const SECRET = "whsec_test_only";
const NOW = 1_800_000_000;

function delivery(event: object, opts: { at?: number; secret?: string } = {}) {
  const body = JSON.stringify(event);
  return { body, sig: sign(body, opts.secret ?? SECRET, opts.at ?? NOW) };
}

const charge = (id: string, cents = 5000): PaymentEvent => ({
  id,
  type: "charge.succeeded",
  data: { charge: `ch_${id}`, account: "acct_1", amount_cents: cents },
});

type Apply = (e: PaymentEvent, l: Ledger) => Promise<void>;

function setup(extra: { apply?: Apply; maxAttempts?: number } = {}) {
  const ledger = new Ledger();
  const apply = extra.apply ?? applyToLedger;
  const h = createPaymentHandler({
    secret: SECRET,
    store: createMemoryStore(),
    apply: (e) => apply(e, ledger),
    maxAttempts: extra.maxAttempts,
    now: () => NOW,
  });
  return { ledger, h };
}

// --- 1. signature ---------------------------------------------------------

test("signature: a correctly signed body verifies", () => {
  const { body, sig } = delivery(charge("evt_1"));
  assert.deepEqual(verifySignature(body, sig, SECRET, NOW), { ok: true });
});

test("signature: a body changed after signing is rejected and writes nothing", async () => {
  const { ledger, h } = setup();
  const { sig } = delivery(charge("evt_1", 5000));
  const tampered = JSON.stringify(charge("evt_1", 500000)); // amount bumped
  const res = await h.handle(tampered, sig);
  assert.deepEqual(res, { status: 400, body: "signature mismatch" });
  assert.equal(ledger.rows().length, 0);
});

test("signature: wrong secret, missing header and stale timestamp are all rejected", async () => {
  const { h } = setup();
  const e = charge("evt_1");
  const wrong = delivery(e, { secret: "someone_else" });
  const stale = delivery(e, { at: NOW - 3600 });
  assert.equal((await h.handle(wrong.body, wrong.sig)).body, "signature mismatch");
  assert.equal((await h.handle(wrong.body, undefined)).body, "missing signature header");
  assert.equal((await h.handle(stale.body, stale.sig)).body, "timestamp outside tolerance");
});

test("signature: a rotated secret is accepted while either v1 matches", () => {
  const { body } = delivery(charge("evt_1"));
  const oldMac = sign(body, "old_secret", NOW).split("v1=")[1];
  const newMac = sign(body, SECRET, NOW).split("v1=")[1];
  assert.deepEqual(verifySignature(body, `t=${NOW},v1=${oldMac},v1=${newMac}`, SECRET, NOW), { ok: true });
});

// --- 2. exactly once ------------------------------------------------------

test("exactly once: 20 concurrent copies of one event credit the account once", async () => {
  const { ledger, h } = setup();
  const { body, sig } = delivery(charge("evt_1", 5000));
  const results = await Promise.all(Array.from({ length: 20 }, () => h.handle(body, sig)));
  assert.equal(results.filter((r) => r.body === "processed").length, 1);
  assert.equal(results.filter((r) => r.body === "duplicate").length, 19);
  assert.equal(ledger.balance("acct_1"), 5000);
  assert.equal(ledger.rows().length, 1);
});

test("exactly once: a late redelivery (the provider's retry) is a duplicate", async () => {
  const { ledger, h } = setup();
  const { body, sig } = delivery(charge("evt_1"));
  assert.equal((await h.handle(body, sig)).body, "processed");
  assert.equal((await h.handle(body, sig)).body, "duplicate");
  assert.equal(ledger.rows().length, 1);
});

// --- 3. append-only ledger -----------------------------------------------

test("ledger: a refund is a reversal row; the original row is untouched", async () => {
  const { ledger, h } = setup();
  const c = delivery(charge("evt_1", 5000));
  const refund = delivery({ id: "evt_2", type: "charge.refunded", data: { charge: "ch_evt_1", account: "acct_1", amount_cents: 5000 } });
  await h.handle(c.body, c.sig);
  const before = ledger.rows()[0];
  await h.handle(refund.body, refund.sig);
  await h.handle(refund.body, refund.sig); // refund webhook delivered twice

  const rows = ledger.rows();
  assert.equal(rows.length, 2, "one credit, one reversal, no second reversal");
  assert.deepEqual(rows[0], before);
  assert.equal(rows[1]!.reverses, rows[0]!.seq);
  assert.equal(ledger.balance("acct_1"), 0);
});

test("ledger: rows cannot be edited in place and there is no update or delete", () => {
  const ledger = new Ledger();
  const row = ledger.append({ account: "a", amountCents: 100, ref: "ch_1", eventId: "evt_1", memo: "x" });
  assert.throws(() => { (row as { amountCents: number }).amountCents = 1; }, TypeError);
  const api = Object.getOwnPropertyNames(Ledger.prototype);
  assert.ok(!api.some((m) => /update|delete|remove|edit|set/i.test(m)), `unexpected mutator in ${api.join(",")}`);
});

// --- 4. retries and the dead letter --------------------------------------

test("retry: a write that fails twice then works returns 500, 500, 200 and credits once", async () => {
  let calls = 0;
  const flaky = async (e: PaymentEvent, l: Ledger) => {
    calls += 1;
    if (calls <= 2) throw new Error("db unavailable");
    await applyToLedger(e, l);
  };
  const { ledger, h } = setup({ apply: flaky });
  const { body, sig } = delivery(charge("evt_1"));
  const statuses = [];
  for (let i = 0; i < 4; i++) statuses.push((await h.handle(body, sig)).status);
  assert.deepEqual(statuses, [500, 500, 200, 200]);
  assert.equal(ledger.rows().length, 1);
  assert.equal(h.deadLetters().length, 0);
});

test("dead letter: after maxAttempts failures the event is parked, acked, and replays once after a fix", async () => {
  let broken = true;
  const apply = async (e: PaymentEvent, l: Ledger) => {
    if (broken) throw new Error("account acct_1 is frozen");
    await applyToLedger(e, l);
  };
  const { ledger, h } = setup({ apply, maxAttempts: 3 });
  const { body, sig } = delivery(charge("evt_1"));

  const statuses = [];
  for (let i = 0; i < 3; i++) statuses.push((await h.handle(body, sig)).status);
  assert.deepEqual(statuses, [500, 500, 200], "third failure parks it and stops the retries");
  assert.equal(ledger.rows().length, 0);
  assert.deepEqual(h.deadLetters().map((d) => [d.eventId, d.reason, d.attempts]), [["evt_1", "account acct_1 is frozen", 3]]);
  assert.equal((await h.handle(body, sig)).body, "already dead-lettered");

  broken = false; // a person fixes the cause
  assert.equal((await h.replay("evt_1")).body, "processed");
  assert.equal((await h.replay("evt_1")).status, 400, "replaying twice writes once");
  assert.equal(ledger.balance("acct_1"), 5000);
  assert.equal(h.deadLetters().length, 0);
});

test("dead letter: a genuine but malformed event is parked at once, never written", async () => {
  const { ledger, h } = setup();
  const bad = delivery({ id: "evt_9", type: "charge.succeeded", data: { charge: "ch_9", account: "acct_1", amount_cents: -5 } });
  assert.deepEqual(await h.handle(bad.body, bad.sig), { status: 200, body: "dead-lettered" });
  assert.equal(h.deadLetters()[0]!.reason, "amount_cents must be a positive integer");
  assert.equal(ledger.rows().length, 0);
});

test("dead letter: a failed replay keeps the letter", async () => {
  const apply = async () => { throw new Error("still frozen"); };
  const { h } = setup({ apply, maxAttempts: 1 });
  const { body, sig } = delivery(charge("evt_1"));
  await h.handle(body, sig);
  await assert.rejects(() => h.replay("evt_1"), /still frozen/);
  assert.equal(h.deadLetters().length, 1);
});
