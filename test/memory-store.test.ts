import { test } from "node:test";
import assert from "node:assert/strict";
import { createMemoryStore } from "../src/memory-store.ts";
import { runContract } from "./contract.ts";

// The in-memory store must satisfy the shared behavioural contract (process once,
// dedup, the concurrent double-credit race, independent keys, retry on failure).
runContract({
  label: "memory",
  makeStore: () => createMemoryStore(),
  // A fresh store each time, so a plain name is already unique within the store.
  makeKey: (name) => name,
});

// Tests specific to the in-memory implementation — the bounded-memory behaviour
// the Postgres store does not have.

test("maxEntries bounds memory: the oldest completed key is forgotten", async () => {
  const store = createMemoryStore({ maxEntries: 2 });
  const runsFor = new Map<string, number>();
  const effect = (key: string) => async () => {
    runsFor.set(key, (runsFor.get(key) ?? 0) + 1);
    return key;
  };

  await store.run("a", effect("a"));
  await store.run("b", effect("b"));
  await store.run("c", effect("c")); // now over the cap of 2 -> "a" is evicted

  // "b" and "c" are still remembered: re-delivering them does not re-run.
  const bAgain = await store.run("b", effect("b"));
  const cAgain = await store.run("c", effect("c"));
  assert.equal(bAgain.status, "duplicate");
  assert.equal(cAgain.status, "duplicate");
  assert.equal(runsFor.get("b"), 1);
  assert.equal(runsFor.get("c"), 1);

  // "a" was evicted: re-delivering it runs the effect a second time. This is the
  // documented trade-off — a bounded store only dedups inside its window.
  const aAgain = await store.run("a", effect("a"));
  assert.equal(aAgain.status, "processed");
  assert.equal(runsFor.get("a"), 2);
});

test("maxEntries eviction order holds across a failed effect and re-delivered keys", async () => {
  // Pins which key is forgotten, step by step, so the bookkeeping behind eviction
  // can change without changing the behaviour. A failed effect leaves nothing
  // behind, so it must not count toward the cap; a re-delivered evicted key is new
  // again and becomes the most recent.
  const store = createMemoryStore({ maxEntries: 2 });
  const runsFor = new Map<string, number>();
  const effect = (key: string) => async () => {
    runsFor.set(key, (runsFor.get(key) ?? 0) + 1);
    return key;
  };

  await store.run("a", effect("a"));
  await store.run("b", effect("b"));
  await assert.rejects(store.run("x", async () => { throw new Error("boom"); }), /boom/);
  await store.run("c", effect("c")); // a, b, c done: over the cap -> "a" goes

  assert.equal((await store.run("c", effect("c"))).status, "duplicate");
  assert.equal((await store.run("a", effect("a"))).status, "processed", "a was forgotten"); // b goes
  assert.equal((await store.run("c", effect("c"))).status, "duplicate");
  assert.equal((await store.run("a", effect("a"))).status, "duplicate");
  assert.equal((await store.run("b", effect("b"))).status, "processed", "b was forgotten next");

  assert.deepEqual(Object.fromEntries(runsFor), { a: 2, b: 2, c: 1 });
});

test("maxEntries never evicts an in-flight key under contention", async () => {
  // Fill the cap, then start a slow effect on a new key while hammering other
  // keys. The slow key is pending, so it must not be evicted out from under the
  // callers waiting on it — all concurrent deliveries still collapse to one run.
  const store = createMemoryStore({ maxEntries: 1 });
  await store.run("warm", async () => "warm");

  let runs = 0;
  const slow = async () => {
    runs += 1;
    await new Promise((r) => setTimeout(r, 20));
    return "slow";
  };

  const results = await Promise.all([
    store.run("slow", slow),
    store.run("slow", slow),
    store.run("slow", slow),
  ]);

  assert.equal(runs, 1, "the pending key ran exactly once despite the tight cap");
  assert.equal(results.filter((r) => r.status === "processed").length, 1);
});

test("maxEntries: an in-flight key older than every completed key is skipped by eviction", async () => {
  // The case the test above does not reach: the in-flight key is the OLDEST entry,
  // so it is the first one eviction looks at when other keys complete and push the
  // store over its cap. If eviction dropped it, a second delivery arriving while
  // the first is still running would find no entry and run the effect again.
  // (Found by mutation testing: replacing eviction's "is this key done?" check
  // with `true` passed every other test.)
  const store = createMemoryStore({ maxEntries: 1 });
  let slowRuns = 0;
  let finish!: () => void;
  const gate = new Promise<void>((r) => { finish = r; });
  const slow = async () => {
    slowRuns += 1;
    await gate;
    return "slow";
  };

  const first = store.run("slow", slow); // pending, and the oldest entry in the store
  await store.run("a", async () => "a");
  await store.run("b", async () => "b"); // two completed keys: over the cap of 1, eviction runs
  const second = store.run("slow", slow); // must wait on the pending entry, not start a new run
  finish();

  assert.deepEqual(await first, { status: "processed", result: "slow" });
  assert.deepEqual(await second, { status: "duplicate", result: "slow" });
  assert.equal(slowRuns, 1, "the in-flight key was not evicted, so its effect ran once");
  // With a cap of 1 the store now remembers only the most recently completed key,
  // which is "slow" itself.
  assert.deepEqual(await store.run("slow", slow), { status: "duplicate", result: "slow" });
  assert.equal(slowRuns, 1);
});

test("maxEntries rejects a non-positive or non-integer value", () => {
  assert.throws(() => createMemoryStore({ maxEntries: 0 }), /positive integer/);
  assert.throws(() => createMemoryStore({ maxEntries: -3 }), /positive integer/);
  assert.throws(() => createMemoryStore({ maxEntries: 2.5 }), /positive integer/);
});

test("a result JSON can't hold fails here, in tests, the way it would in production", async () => {
  // Postgres would roll the whole transaction back and Redis would leave the claim
  // to expire; either way the run fails. The memory store used to keep the raw
  // value, so a BigInt result passed every test and only failed in production.
  const store = createMemoryStore();
  await assert.rejects(() => store.run("big", async () => 10n), /BigInt/);
  // The run failed, so the key is free and a corrected effect can run.
  const ok = await store.run("big", async () => "10");
  assert.deepEqual(ok, { status: "processed", result: "10" });
});
