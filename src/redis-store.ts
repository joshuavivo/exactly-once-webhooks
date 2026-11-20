import { randomUUID } from "node:crypto";
import type { IdempotencyStore, Outcome } from "./types.ts";

// A Redis-backed store. Like the Postgres store it is safe across many processes,
// but it closes the race differently and trades away one guarantee the Postgres
// store has — see the note at the bottom of this file and DESIGN.md.
//
// The library does not depend on a Redis client. It asks only for the four
// operations it uses, so it works with node-redis, ioredis, or any wrapper. A
// ready-made adapter for node-redis v4+ is exported as `fromNodeRedis`.
//
// Every claim carries a random ownership token. The holder only finalizes or
// releases the key if it still holds THAT token, so a holder whose claim expired
// mid-effect can never overwrite or delete the claim of the caller who took over.

export interface RedisLike {
  /** SET key=value only if the key is absent (NX), with a TTL of `ttlMs` (PX).
   *  Returns true if this call set the key, false if it already existed. This is
   *  the atomic "only one caller wins the claim" primitive. */
  setClaim(key: string, value: string, ttlMs: number): Promise<boolean>;
  /** Compare-and-set: only if the key's current value is exactly `expected`, SET
   *  key=value with a TTL of `ttlMs`. Returns true if it wrote. Must be atomic (a
   *  Lua script on real Redis — see `fromNodeRedis`). */
  setIfValue(key: string, expected: string, value: string, ttlMs: number): Promise<boolean>;
  get(key: string): Promise<string | null>;
  /** Compare-and-delete: DEL the key only if its current value is exactly
   *  `expected`. Returns true if it deleted. Must be atomic, like `setIfValue`. */
  delIfValue(key: string, expected: string): Promise<boolean>;
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
   *  and another caller may run the effect too. The ownership token stops the
   *  late holder from clobbering the new holder's claim or result, but it cannot
   *  undo the second run. Default 30. */
  pendingTtlSeconds?: number;
  /** How often a waiting caller re-checks the holder, in ms. Default 25. */
  pollIntervalMs?: number;
  /** How long a waiting caller waits for the holder before giving up, in ms.
   *  Effects should be short; this guards against a wedged holder. Default 5000. */
  maxWaitMs?: number;
};

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
      // A fresh token per claim attempt: the pending value is unique to this
      // caller, so the compare-and-set / compare-and-delete below only ever act on
      // a claim this caller still owns.
      const pending = JSON.stringify({ s: "pending", t: randomUUID() });
      const claimed = await redis.setClaim(k, pending, pendingTtlMs);
      if (claimed) {
        let result: T;
        try {
          result = await effect(undefined);
        } catch (err) {
          // The effect threw: release the key so a later delivery retries,
          // mirroring the Postgres store's rollback — but only if the claim is
          // still ours. If it expired and someone else took it, leave theirs alone.
          await redis.delIfValue(k, pending).catch(() => {});
          throw err;
        }
        // The effect succeeded. Record the result under the full dedup window. If
        // THIS write fails, do NOT delete the claim — the effect already ran, so
        // freeing the key would re-run it. Leave the short-lived pending claim to
        // expire on its own and surface the error.
        //
        // The write is compare-and-set against our own pending token. If it does
        // not apply, our claim expired mid-effect and another caller now owns the
        // key (and may already have recorded its own result). We do not overwrite
        // that: the effect did run here, so we still report "processed", and the
        // other caller's record stands. (DESIGN.md, limitation 4.)
        await redis.setIfValue(k, pending, JSON.stringify({ s: "done", r: result ?? null }), ttlMs);
        return { status: "processed", result };
      }

      // Someone else holds the key. Poll until they write the result, or until the
      // key vanishes (holder failed / TTL lapsed) and we retry to reclaim it.
      const start = Date.now();
      for (;;) {
        const raw = await redis.get(k);
        if (raw === null) break; // holder gone → reclaim on the next attempt
        const parsed = JSON.parse(raw) as { s: "pending" | "done"; r?: unknown; t?: string };
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

// Compare-and-set / compare-and-delete as Lua, so the GET-compare and the write
// happen atomically inside Redis. Exported so other adapters (ioredis etc.) can
// reuse exactly the same scripts.
export const SET_IF_VALUE_LUA =
  "if redis.call('GET', KEYS[1]) == ARGV[1] then " +
  "redis.call('SET', KEYS[1], ARGV[2], 'PX', ARGV[3]) return 1 else return 0 end";
export const DEL_IF_VALUE_LUA =
  "if redis.call('GET', KEYS[1]) == ARGV[1] then " +
  "return redis.call('DEL', KEYS[1]) else return 0 end";

/**
 * Adapt a node-redis v4+ client to the small `RedisLike` shape this store needs.
 *
 *   import { createClient } from "redis";
 *   const client = createClient(); await client.connect();
 *   const store = createRedisStore(fromNodeRedis(client));
 *
 * For ioredis the calls differ slightly (`set(key, value, "PX", ms, "NX")`,
 * `eval(script, 1, key, ...args)`); write a four-method adapter the same way,
 * reusing `SET_IF_VALUE_LUA` and `DEL_IF_VALUE_LUA`.
 */
export function fromNodeRedis(client: {
  set(key: string, value: string, opts: { NX?: boolean; PX?: number }): Promise<string | null>;
  get(key: string): Promise<string | null>;
  eval(script: string, opts: { keys: string[]; arguments: string[] }): Promise<unknown>;
}): RedisLike {
  return {
    async setClaim(key, value, ttlMs) {
      return (await client.set(key, value, { NX: true, PX: Math.ceil(ttlMs) })) === "OK";
    },
    async setIfValue(key, expected, value, ttlMs) {
      const r = await client.eval(SET_IF_VALUE_LUA, { keys: [key], arguments: [expected, value, String(Math.ceil(ttlMs))] });
      return Number(r) === 1;
    },
    get(key) {
      return client.get(key);
    },
    async delIfValue(key, expected) {
      const r = await client.eval(DEL_IF_VALUE_LUA, { keys: [key], arguments: [expected] });
      return Number(r) === 1;
    },
  };
}
