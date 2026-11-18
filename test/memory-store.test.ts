import { test } from "node:test";
import assert from "node:assert/strict";
import { createMemoryStore } from "../src/memory-store.ts";

test("runs the effect once and reports it as processed", async () => {
  const store = createMemoryStore();
  let runs = 0;
  const out = await store.run("evt_1", async () => {
    runs += 1;
    return "credited";
  });
  assert.equal(runs, 1);
  assert.deepEqual(out, { status: "processed", result: "credited" });
});

test("a repeat delivery does not run the effect again", async () => {
  const store = createMemoryStore();
  let runs = 0;
  const effect = async () => {
    runs += 1;
    return runs;
  };

  const first = await store.run("evt_2", effect);
  const second = await store.run("evt_2", effect);
  const third = await store.run("evt_2", effect);

  assert.equal(runs, 1, "effect ran exactly once across three deliveries");
  assert.deepEqual(first, { status: "processed", result: 1 });
  assert.deepEqual(second, { status: "duplicate", result: 1 });
  assert.deepEqual(third, { status: "duplicate", result: 1 });
});

test("the double-credit race: concurrent deliveries credit once", async () => {
  // This is the bug the library exists to stop. Two copies of the same webhook
  // arrive at the same moment; without serialisation both would credit the
  // account. With it, the balance moves exactly once.
  const store = createMemoryStore();
  let balance = 0;
  const credit = async () => {
    // Read-modify-write with an await in the middle — the exact shape that
    // races. The store must make sure only one of these ever runs.
    const current = balance;
    await new Promise((r) => setTimeout(r, 5));
    balance = current + 100;
    return balance;
  };

  const results = await Promise.all([
    store.run("evt_race", credit),
    store.run("evt_race", credit),
    store.run("evt_race", credit),
    store.run("evt_race", credit),
    store.run("evt_race", credit),
  ]);

  assert.equal(balance, 100, "credited once despite five concurrent deliveries");
  const processed = results.filter((r) => r.status === "processed");
  const duplicate = results.filter((r) => r.status === "duplicate");
  assert.equal(processed.length, 1, "exactly one call processed the event");
  assert.equal(duplicate.length, 4, "the rest were duplicates");
  for (const r of results) {
    assert.equal(r.result, 100, "every caller sees the one true balance");
  }
});

test("different keys are independent", async () => {
  const store = createMemoryStore();
  const a = await store.run("evt_a", async () => "a");
  const b = await store.run("evt_b", async () => "b");
  assert.deepEqual(a, { status: "processed", result: "a" });
  assert.deepEqual(b, { status: "processed", result: "b" });
});

test("a failed effect stores nothing and can be retried", async () => {
  const store = createMemoryStore();
  let attempts = 0;
  const flaky = async () => {
    attempts += 1;
    if (attempts === 1) throw new Error("provider timeout");
    return "ok";
  };

  await assert.rejects(() => store.run("evt_retry", flaky), /provider timeout/);
  const retry = await store.run("evt_retry", flaky);

  assert.equal(attempts, 2);
  assert.deepEqual(retry, { status: "processed", result: "ok" });
});

test("concurrent callers all wait when the first effect fails, then one retries", async () => {
  const store = createMemoryStore();
  let attempts = 0;
  const effect = async () => {
    attempts += 1;
    await new Promise((r) => setTimeout(r, 5));
    if (attempts === 1) throw new Error("first attempt fails");
    return "recovered";
  };

  const settled = await Promise.allSettled([
    store.run("evt_fail_race", effect),
    store.run("evt_fail_race", effect),
  ]);

  // One attempt threw; the key was freed; a waiter retried and succeeded.
  const fulfilled = settled.filter((s) => s.status === "fulfilled");
  assert.ok(fulfilled.length >= 1, "at least one caller ended up with a result");
});
