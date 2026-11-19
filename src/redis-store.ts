import type { IdempotencyStore, Outcome } from "./types.ts";

// A Redis-backed store. Like the Postgres store it is safe across many processes,
// but it closes the race differently and trades away one guarantee the Postgres
// store has — see the note at the bottom of this file and DESIGN.md.
//
// The library does not depend on a Redis client. It asks only for the four
// operations it uses, so it works with node-redis, ioredis, or any wrapper. A
// ready-made adapter for node-redis v4+ is exported as `fromNodeRedis`.

export interface RedisLike {
  /** SET key=value only if the key is absent (NX), with a TTL of `ttlMs` (PX).
   *  Returns true if this call set the key, false if it already existed. This is
   *  the atomic "only one caller wins the claim" primitive. */
  setClaim(key: string, value: string, ttlMs: number): Promise<boolean>;
  /** SET key=value with a TTL of `ttlMs`, overwriting any current value. */
  setValue(key: string, value: string, ttlMs: number): Promise<void>;
  get(key: string): Promise<string | null>;
  del(key: string): Promise<void>;
}

export type RedisStoreOptions = {
  /** Prefix for every key written, so this store shares a Redis safely. Default "eow:". */
  keyPrefix?: string;
  /** How long a *completed* key is remembered, in seconds — the dedup and
   *  retention window in one. After it a key is forgotten and a re-delivery runs
   *  again, so set it above the provider's retry window. Default 86400 (1 day). */
  ttlSeconds?: number;
  /** How long an in-flight (`pending`) claim lives before it expires, in seconds.
   *  Kept short so a holder that crashes mid-effect frees the key in seconds, not
   *  for the whole `ttlSeconds` window. Must exceed the effect's worst-case
   *  duration: if the effect runs longer than this, the claim expires mid-flight
   *  and another caller may run it too (there is no ownership token yet). Default 30. */
  pendingTtlSeconds?: number;
  /** How often a waiting caller re-checks the holder, in ms. Default 25. */
  pollIntervalMs?: number;
  /** How long a waiting caller waits for the holder before giving up, in ms.
   *  Effects should be short; this guards against a wedged holder. Default 5000. */
  maxWaitMs?: number;
};

const PENDING = JSON.stringify({ s: "pending" });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Cap on claim retries (a retry only happens when the holder's key vanished). High
// enough never to trip under healthy contention; reaching it means an effect is
// failing deterministically, which should error rather than spin forever.
const MAX_CLAIM_ATTEMPTS = 50;

/**
 * Redis-backed store, safe across processes.
 *
 * The claim is a single atomic `SET key ... NX PX` — exactly one concurrent
 * caller sets the key and runs the effect; the rest see the key already there and
 * poll until it holds the result. The claim is written with a short `pendingTtl`,
 * so a holder that crashes mid-effect frees the key in seconds; on success the key
 * is rewritten with the full `ttlSeconds` window. If the effect throws, the key is
 * deleted so a later delivery can retry. The TTL doubles as the retention window,
 * so unlike the Postgres store there is no table to prune.
 *
 * The effect's context is `undefined`: Redis gives no transaction, so the effect
 * and the "done" record do NOT commit atomically. Use this store when the effect
 * is itself idempotent, or when the dedup window alone is enough. When the effect
 * must be atomic with a database write, use the Postgres store. (See DESIGN.md.)
 */
export function createRedisStore(redis: RedisLike, options: RedisStoreOptions = {}): IdempotencyStore<undefined> {
  const prefix = options.keyPrefix ?? "eow:";
  const ttlMs = (options.ttlSeconds ?? 86_400) * 1000;
  const pendingTtlMs = (options.pendingTtlSeconds ?? 30) * 1000;
  const pollIntervalMs = options.pollIntervalMs ?? 25;
  const maxWaitMs = options.maxWaitMs ?? 5000;

  async function run<T>(key: string, effect: (ctx: undefined) => Promise<T>): Promise<Outcome<T>> {
    const k = prefix + key;

    // A bounded loop, not recursion: each pass either claims the key, reads the
    // holder's result, or retries because the key vanished (holder failed / TTL
    // lapsed). The cap turns a deterministically failing effect into a clear error
    // instead of an unbounded retry.
    for (let attempt = 1; attempt <= MAX_CLAIM_ATTEMPTS; attempt++) {
      const claimed = await redis.setClaim(k, PENDING, pendingTtlMs);
      if (claimed) {
        let result: T;
        try {
          result = await effect(undefined);
        } catch (err) {
          // The effect threw: release the key so a later delivery retries,
          // mirroring the Postgres store's rollback.
          await redis.del(k).catch(() => {});
          throw err;
        }
        // The effect succeeded. Record the result under the full dedup window. If
        // THIS write fails, do NOT delete the claim — the effect already ran, so
        // freeing the key would re-run it. Leave the short-lived pending claim to
        // expire on its own and surface the error.
        await redis.setValue(k, JSON.stringify({ s: "done", r: result ?? null }), ttlMs);
        return { status: "processed", result };
      }

      // Someone else holds the key. Poll until they write the result, or until the
      // key vanishes (holder failed / TTL lapsed) and we retry to reclaim it.
      const start = Date.now();
      for (;;) {
        const raw = await redis.get(k);
        if (raw === null) break; // holder gone → reclaim on the next attempt
        const parsed = JSON.parse(raw) as { s: "pending" | "done"; r?: unknown };
        if (parsed.s === "done") {
          return { status: "duplicate", result: parsed.r as T };
        }
        if (Date.now() - start > maxWaitMs) {
          throw new Error(`timed out after ${maxWaitMs}ms waiting for key ${JSON.stringify(key)}`);
        }
        await sleep(pollIntervalMs);
      }
    }
    throw new Error(
      `could not claim key ${JSON.stringify(key)} after ${MAX_CLAIM_ATTEMPTS} attempts; ` +
        "its holder keeps failing (a deterministically failing effect?)",
    );
  }

  return { run };
}

/**
 * Adapt a node-redis v4+ client to the small `RedisLike` shape this store needs.
 *
 *   import { createClient } from "redis";
 *   const client = createClient(); await client.connect();
 *   const store = createRedisStore(fromNodeRedis(client));
 *
 * For ioredis the calls differ slightly (`set(key, value, "PX", ms, "NX")`); write
 * a four-method adapter the same way.
 */
export function fromNodeRedis(client: {
  set(key: string, value: string, opts: { NX?: boolean; PX?: number }): Promise<string | null>;
  get(key: string): Promise<string | null>;
  del(key: string): Promise<number>;
}): RedisLike {
  return {
    async setClaim(key, value, ttlMs) {
      return (await client.set(key, value, { NX: true, PX: ttlMs })) === "OK";
    },
    async setValue(key, value, ttlMs) {
      await client.set(key, value, { PX: ttlMs });
    },
    get(key) {
      return client.get(key);
    },
    async del(key) {
      await client.del(key);
    },
  };
}
