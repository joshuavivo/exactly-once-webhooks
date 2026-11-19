import type { RedisLike } from "../src/redis-store.ts";

// An in-process stand-in for Redis that models exactly the semantics the store
// relies on: SET NX (only the first setter wins), PX (a TTL after which the key is
// gone), GET, and DEL. The check-and-set in setClaim is synchronous, so it is
// atomic under the single-threaded event loop — which is the whole point of using
// NX for the claim. The redis-store contract runs against this with no services;
// the same store also runs against a real Redis when REDIS_URL is set.

export type FakeRedis = RedisLike & {
  /** Keys currently held (expired ones excluded). */
  _size(): number;
  /** Drop everything — simulates every key's TTL lapsing at once. */
  _flush(): void;
};

export function createFakeRedis(): FakeRedis {
  const store = new Map<string, { value: string; expiresAt: number }>();

  function live(key: string): string | null {
    const e = store.get(key);
    if (!e) return null;
    if (e.expiresAt <= Date.now()) {
      store.delete(key);
      return null;
    }
    return e.value;
  }

  return {
    async setClaim(key, value, ttlMs) {
      if (live(key) !== null) return false;
      store.set(key, { value, expiresAt: Date.now() + ttlMs });
      return true;
    },
    async setValue(key, value, ttlMs) {
      store.set(key, { value, expiresAt: Date.now() + ttlMs });
    },
    async get(key) {
      return live(key);
    },
    async del(key) {
      store.delete(key);
    },
    _size() {
      let n = 0;
      for (const key of store.keys()) if (live(key) !== null) n += 1;
      return n;
    },
    _flush() {
      store.clear();
    },
  };
}
