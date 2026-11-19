import { test } from "node:test";
import assert from "node:assert/strict";
import { createRedisStore, fromNodeRedis, type RedisLike } from "../src/redis-store.ts";
import { createFakeRedis } from "./fake-redis.ts";
import { runContract } from "./contract.ts";

// The Redis store is held to the exact same behavioural contract as the other two,
// against the in-process fake (no services). A short poll interval keeps the
// concurrent-race test quick.
runContract({
  label: "redis",
  makeStore: () => createRedisStore(createFakeRedis(), { pollIntervalMs: 2 }),
  makeKey: (name) => name, // a fresh fake per store, so names are already unique
});

// Redis-specific behaviour the other stores do not have.

test("a thrown effect deletes the key, leaving nothing to dedup against", async () => {
  const redis = createFakeRedis();
  const store = createRedisStore(redis);
  await assert.rejects(() => store.run("k", async () => { throw new Error("boom"); }), /boom/);
  assert.equal(redis._size(), 0, "the claim was released on failure");

  // And a later delivery runs cleanly as the first caller.
  const retry = await store.run("k", async () => "ok");
  assert.deepEqual(retry, { status: "processed", result: "ok" });
});

test("once the TTL lapses, the key is forgotten and a re-delivery runs again", async () => {
  const redis = createFakeRedis();
  const store = createRedisStore(redis);
  let runs = 0;
  const effect = async () => { runs += 1; return runs; };

  const first = await store.run("evt", effect);
  const dup = await store.run("evt", effect);
  assert.equal(first.status, "processed");
  assert.equal(dup.status, "duplicate");
  assert.equal(runs, 1);

  redis._flush(); // simulate the TTL window passing

  const afterTtl = await store.run("evt", effect);
  assert.equal(afterTtl.status, "processed", "a forgotten key runs again — the dedup window closed");
  assert.equal(runs, 2);
});

test("a waiter that times out throws rather than hanging forever", async () => {
  // A hand-built RedisLike that claims, but whose key stays 'pending' forever (the
  // holder never writes a result and never deletes). A second caller must give up.
  const held = new Map<string, string>();
  const stuck: RedisLike = {
    async setClaim(key, value) {
      if (held.has(key)) return false;
      held.set(key, value);
      return true;
    },
    async setValue() { /* the stuck holder never calls this */ },
    async get(key) { return held.get(key) ?? null; },
    async del(key) { held.delete(key); },
  };
  const store = createRedisStore(stuck, { pollIntervalMs: 1, maxWaitMs: 20 });

  // First caller claims and hangs inside the effect; don't await it.
  const holder = store.run("k", () => new Promise(() => {}));
  // A second caller finds the key pending and must time out.
  await assert.rejects(() => store.run("k", async () => "never"), /timed out/);
  void holder; // intentionally never resolves
});

test("a key that can never be claimed or read gives up with a bounded error", async () => {
  // Pathological: the claim is always lost (setClaim false) yet the key is never
  // readable (get null), so every pass reclaims. Before the bound this recursed
  // forever; now it must throw after MAX_CLAIM_ATTEMPTS.
  const stuck: RedisLike = {
    async setClaim() { return false; },
    async setValue() {},
    async get() { return null; },
    async del() {},
  };
  const store = createRedisStore(stuck, { pollIntervalMs: 0 });
  await assert.rejects(() => store.run("k", async () => "x"), /after \d+ attempts/);
});

test("fromNodeRedis maps the four operations onto a node-redis-shaped client", async () => {
  const data = new Map<string, string>();
  const client = {
    async set(key: string, value: string, opts: { NX?: boolean; PX?: number }) {
      if (opts.NX && data.has(key)) return null;
      data.set(key, value);
      return "OK";
    },
    async get(key: string) { return data.get(key) ?? null; },
    async del(key: string) { const had = data.delete(key); return had ? 1 : 0; },
  };
  const store = createRedisStore(fromNodeRedis(client));
  const a = await store.run("evt", async () => "credited");
  const b = await store.run("evt", async () => "credited again");
  assert.deepEqual(a, { status: "processed", result: "credited" });
  assert.deepEqual(b, { status: "duplicate", result: "credited" });
});
