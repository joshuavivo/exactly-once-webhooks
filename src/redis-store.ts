import { randomUUID } from "node:crypto";
import type { IdempotencyStore, Outcome, RetryInfo } from "./types.ts";

// A Redis-backed store. Like the Postgres store it is safe across many processes,
// but it closes the race differently and trades away one guarantee the Postgres
// store has — see the note at the bottom of this file and DESIGN.md.
//
// The library does not depend on a Redis client. It asks only for the four
// operations it uses, so it works with node-redis, ioredis, or any wrapper. A
// ready-made adapter for node-redis 4, 5 and 6 is exported as `fromNodeRedis`.
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
  /** Called when a waiter has to retry because the holder's claim vanished (its
   *  effect threw, or its lease lapsed). Optional, a no-op when absent; an
   *  exception from it is ignored. `key` is the caller's key, without the prefix. */
  onRetry?: (info: RetryInfo) => void;
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
  // Validate up front. A zero, negative or NaN TTL becomes `PX 0`/`PX NaN`, which
  // Redis rejects on the result write: AFTER the effect has run, so the error
  // surfaces and a redelivery runs the effect again. Fail at construction instead.
  // Milliseconds are rounded up here, not left to each adapter (Redis PX takes an
  // integer).
  const positive = (name: string, v: number) => {
    if (!Number.isFinite(v) || v <= 0) throw new Error(`${name} must be a positive number of seconds, got ${JSON.stringify(v)}`);
    return Math.ceil(v * 1000);
  };
  const ttlMs = positive("ttlSeconds", options.ttlSeconds ?? 86_400);
  const pendingTtlMs = positive("pendingTtlSeconds", options.pendingTtlSeconds ?? 30);
  // The wait settings too: unchecked, maxWaitMs NaN never times out (`elapsed > NaN`
  // is always false), a negative one gives up on the first look, and a NaN or
  // negative poll interval is silently treated as ~1 ms. 0 is allowed: re-check
  // as fast as the event loop allows. maxWaitMs may be Infinity (wait for as long
  // as the holder's claim lives); a poll interval may not (setTimeout treats
  // Infinity as ~1 ms).
  const pollIntervalMs = options.pollIntervalMs ?? 25;
  if (!Number.isFinite(pollIntervalMs) || pollIntervalMs < 0) {
    throw new Error(`pollIntervalMs must be a finite, non-negative number of ms, got ${String(pollIntervalMs)}`);
  }
  const maxWaitMs = options.maxWaitMs ?? 5000;
  if (Number.isNaN(maxWaitMs) || maxWaitMs < 0) {
    throw new Error(`maxWaitMs must be a non-negative number of ms, got ${String(maxWaitMs)}`);
  }

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
        // not apply, our claim expired mid-effect: another caller may now own the
        // key (and may already have recorded its own result), or nobody does. We
        // never overwrite: the effect did run here, so we still report
        // "processed", and any other caller's record stands. We do flag it
        // (`lostClaim`): nothing of ours was recorded, so the effect may have run
        // twice or will run again on redelivery, and only this caller can know.
        // (DESIGN.md, limitation 4.)
        const recorded = await redis.setIfValue(k, pending, JSON.stringify({ s: "done", r: result ?? null }), ttlMs);
        return recorded ? { status: "processed", result } : { status: "processed", result, lostClaim: true };
      }

      // Someone else holds the key. Poll until they write the result, or until the
      // key vanishes (holder failed / TTL lapsed) and we retry to reclaim it.
      const start = Date.now();
      for (;;) {
        const raw = await redis.get(k);
        if (raw === null) {
          // holder gone → reclaim on the next attempt
          if (options.onRetry) {
            try { options.onRetry({ key, attempt }); } catch { /* observability must not break the store */ }
          }
          break;
        }
        const parsed = JSON.parse(raw) as { s: "pending" | "done"; r?: unknown; t?: string };
        if (parsed.s === "done") {
          // `?? null`: a function or Symbol result was dropped by JSON.stringify,
          // so `r` is missing; report null, as the Postgres and memory stores do.
          return { status: "duplicate", result: (parsed.r ?? null) as T };
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
 * Adapt a node-redis client (4, 5 or 6) to the small `RedisLike` shape this store needs.
 *
 *   import { createClient } from "redis";
 *   const client = createClient(); await client.connect();
 *   const store = createRedisStore(fromNodeRedis(client));
 *
 * For ioredis, use `fromIoRedis`.
 */
export function fromNodeRedis(client: {
  set(key: string, value: string, opts: { NX: true; PX: number }): Promise<string | null>;
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

/**
 * Adapt an ioredis client to the small `RedisLike` shape this store needs.
 *
 *   import Redis from "ioredis";
 *   const store = createRedisStore(fromIoRedis(new Redis()));
 *
 * ioredis takes SET options positionally (`"PX", ms, "NX"`) and `eval` as
 * `(script, numKeys, ...keysThenArgs)`; the Lua is the same as `fromNodeRedis`.
 */
export function fromIoRedis(client: {
  set(key: string, value: string, px: "PX", ms: number, nx?: "NX"): Promise<string | null>;
  get(key: string): Promise<string | null>;
  eval(script: string, numKeys: number, ...keysAndArgs: string[]): Promise<unknown>;
}): RedisLike {
  return {
    async setClaim(key, value, ttlMs) {
      return (await client.set(key, value, "PX", Math.ceil(ttlMs), "NX")) === "OK";
    },
    async setIfValue(key, expected, value, ttlMs) {
      return Number(await client.eval(SET_IF_VALUE_LUA, 1, key, expected, value, String(Math.ceil(ttlMs)))) === 1;
    },
    get(key) {
      return client.get(key);
    },
    async delIfValue(key, expected) {
      return Number(await client.eval(DEL_IF_VALUE_LUA, 1, key, expected)) === 1;
    },
  };
}
