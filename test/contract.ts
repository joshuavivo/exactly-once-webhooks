import { test } from "node:test";
import assert from "node:assert/strict";
import type { IdempotencyStore, Outcome } from "../src/index.ts";

// The behavioural contract every IdempotencyStore must satisfy, written once and
// run against every implementation. This is what `types.ts` means by "any store
// that honours the contract is a valid implementation" — it is not a figure of
// speech, it is this file, and the in-memory, Postgres and Redis stores all run it.
//
// `makeStore` returns a store to test. `makeKey` returns a key that is unique
// across test runs — the in-memory store starts empty every time, but the
// Postgres store shares one durable table, so its keys must not collide with a
// previous run of the suite.

export type ContractHarness = {
  label: string;
  makeStore: () => IdempotencyStore<unknown> | Promise<IdempotencyStore<unknown>>;
  makeKey: (name: string) => string;
};

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function runContract({ label, makeStore, makeKey }: ContractHarness): void {
  test(`[${label}] runs the effect once and reports it as processed`, async () => {
    const store = await makeStore();
    let runs = 0;
    const out = await store.run(makeKey("processed"), async () => {
      runs += 1;
      return "credited";
    });
    assert.equal(runs, 1);
    assert.deepEqual(out, { status: "processed", result: "credited" });
  });

  test(`[${label}] a repeat delivery does not run the effect again`, async () => {
    const store = await makeStore();
    const key = makeKey("repeat");
    let runs = 0;
    const effect = async () => {
      runs += 1;
      return runs;
    };

    const first = await store.run(key, effect);
    const second = await store.run(key, effect);
    const third = await store.run(key, effect);

    assert.equal(runs, 1, "effect ran exactly once across three deliveries");
    assert.deepEqual(first, { status: "processed", result: 1 });
    assert.deepEqual(second, { status: "duplicate", result: 1 });
    assert.deepEqual(third, { status: "duplicate", result: 1 });
  });

  test(`[${label}] the double-credit race: concurrent deliveries credit once`, async () => {
    // The bug the library exists to stop. Several copies of one webhook arrive at
    // the same instant; without serialisation each would credit the account.
    const store = await makeStore();
    const key = makeKey("race");
    let balance = 0;
    const credit = async () => {
      // Read-modify-write with an await in the middle — the exact shape that
      // races. Exactly one of these may run.
      const current = balance;
      await wait(5);
      balance = current + 100;
      return balance;
    };

    const results = await Promise.all(
      Array.from({ length: 5 }, () => store.run(key, credit)),
    );

    assert.equal(balance, 100, "credited once despite five concurrent deliveries");
    const processed = results.filter((r) => r.status === "processed");
    assert.equal(processed.length, 1, "exactly one call processed the event");
    assert.equal(results.filter((r) => r.status === "duplicate").length, 4);
    for (const r of results) {
      assert.equal(r.result, 100, "every caller sees the one true balance");
    }
  });

  test(`[${label}] a duplicate gets the stored JSON copy of the first result, in every store`, async () => {
    // Postgres and Redis store the result as JSON, so a duplicate gets it back the
    // way JSON gives it: a Date as its ISO string, undefined as null. The memory
    // store must hand back the same shape, or code tested against it behaves
    // differently in production.
    const store = await makeStore();
    const key = makeKey("json-copy");
    const first = await store.run(key, async () => ({ at: new Date(0), n: 1 }));
    assert.ok(first.result instanceof Object && (first.result as { at: unknown }).at instanceof Date,
      "the run that executed the effect gets its own return value back, untouched");
    const again = await store.run(key, async () => ({ at: new Date(1), n: 2 }));
    assert.deepEqual(again, { status: "duplicate", result: { at: "1970-01-01T00:00:00.000Z", n: 1 } });

    const key2 = makeKey("json-undefined");
    await store.run(key2, async () => undefined);
    const again2 = await store.run(key2, async () => "never");
    assert.deepEqual(again2, { status: "duplicate", result: null });

    // A function is not JSON; JSON.stringify drops it. Every store reports null
    // for it, and later duplicates keep working.
    const key3 = makeKey("json-function");
    await store.run(key3, async () => () => 1);
    assert.deepEqual(await store.run(key3, async () => "never"), { status: "duplicate", result: null });
    assert.deepEqual(await store.run(key3, async () => "never"), { status: "duplicate", result: null });
  });

  test(`[${label}] different keys are independent`, async () => {
    const store = await makeStore();
    const a = await store.run(makeKey("ind_a"), async () => "a");
    const b = await store.run(makeKey("ind_b"), async () => "b");
    assert.deepEqual(a, { status: "processed", result: "a" });
    assert.deepEqual(b, { status: "processed", result: "b" });
  });

  test(`[${label}] a failed effect stores nothing and can be retried`, async () => {
    const store = await makeStore();
    const key = makeKey("retry");
    let attempts = 0;
    const flaky = async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("provider timeout");
      return "ok";
    };

    await assert.rejects(() => store.run(key, flaky), /provider timeout/);
    const retry = await store.run(key, flaky);

    assert.equal(attempts, 2);
    assert.deepEqual(retry, { status: "processed", result: "ok" });
  });

  test(`[${label}] when the first of several concurrent effects fails, the effect reruns exactly once`, async () => {
    const store = await makeStore();
    const key = makeKey("fail_race");
    let started = 0;
    let succeeded = 0;
    const effect = async () => {
      const mine = ++started;
      await wait(5);
      if (mine === 1) throw new Error("first attempt fails");
      succeeded += 1;
      return "recovered";
    };

    // Four concurrent deliveries; the first attempt throws. Exactly ONE of the
    // waiters may rerun the effect — not each of them. Three-plus waiters is what
    // exposes a post-failure re-check that is a single look instead of a loop.
    const settled = await Promise.allSettled([
      store.run(key, effect),
      store.run(key, effect),
      store.run(key, effect),
      store.run(key, effect),
    ]);

    assert.equal(started, 2, `the effect ran ${started} times; it must run twice (one failure, one rerun)`);
    assert.equal(succeeded, 1, `the effect succeeded ${succeeded} times; it must rerun exactly once`);
    const fulfilled = settled.filter((s) => s.status === "fulfilled");
    assert.equal(fulfilled.length, 3, "the three non-failing callers each get the one result");
    const processed = fulfilled.filter(
      (s) => (s as PromiseFulfilledResult<Outcome<unknown>>).value.status === "processed",
    );
    assert.equal(processed.length, 1, "exactly one caller processed the rerun; the rest are duplicates");
  });
}
