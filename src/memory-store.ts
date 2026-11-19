import type { IdempotencyStore, Outcome } from "./types.ts";

type Entry = {
  status: "pending" | "done";
  result?: unknown;
  // Every caller for a key awaits this, so concurrent calls serialise behind the
  // first one instead of all running the effect.
  settled: Promise<void>;
};

export type MemoryStoreOptions = {
  /**
   * Cap on how many *completed* keys to remember. Once exceeded, the
   * least-recently-completed key is forgotten. A forgotten key is no longer
   * deduplicated — a later delivery of it runs the effect again — so set this
   * above the number of distinct events you expect inside the provider's retry
   * window. `undefined` (the default) keeps every key forever: safe only for a
   * short-lived process, because the map grows without bound otherwise.
   *
   * In-flight (pending) keys are never evicted; eviction would break the
   * serialisation guarantee for calls already waiting on them.
   */
  maxEntries?: number;
};

/**
 * In-memory store. Correct for a single process (tests, a CLI, one server with
 * no replicas). It does NOT share state across processes — for that use the
 * Postgres store. The context passed to the effect is `undefined`.
 */
export function createMemoryStore(options: MemoryStoreOptions = {}): IdempotencyStore<undefined> {
  const maxEntries = options.maxEntries;
  if (maxEntries !== undefined && (!Number.isInteger(maxEntries) || maxEntries < 1)) {
    throw new Error(`maxEntries must be a positive integer, got ${JSON.stringify(maxEntries)}`);
  }

  // Insertion order of a Map is iteration order. A completed key is re-inserted
  // at the end, so the front of the map is the least-recently-completed key —
  // the one to drop first when we are over the cap.
  const entries = new Map<string, Entry>();

  function evictIfNeeded(): void {
    if (maxEntries === undefined) return;
    let done = 0;
    for (const e of entries.values()) if (e.status === "done") done += 1;
    for (const [key, entry] of entries) {
      if (done <= maxEntries) break;
      if (entry.status === "done") {
        entries.delete(key);
        done -= 1;
      }
    }
  }

  async function run<T>(
    key: string,
    effect: (ctx: undefined) => Promise<T>,
  ): Promise<Outcome<T>> {
    // Wait out any in-flight attempt before claiming. This is a LOOP, not a single
    // re-check: when a holder's effect throws it frees the key and wakes every
    // waiter, and exactly one of them must re-claim while the rest wait on that NEW
    // holder. A single look (checking only for "done") would let every waiter fall
    // through and run the effect too — the concurrent double-run this store exists
    // to stop. Re-examining each pass keeps it to one.
    for (;;) {
      const existing = entries.get(key);
      if (!existing) break; // no holder: we are the one that claims, below
      if (existing.status === "done") {
        return { status: "duplicate", result: existing.result as T };
      }
      await existing.settled; // pending: wait, then look again (done / gone / a new holder)
    }

    // Claim the key. This block runs synchronously up to `await effect()`, so no
    // other call can claim the same key in between.
    let release!: () => void;
    const settled = new Promise<void>((resolve) => {
      release = resolve;
    });
    entries.set(key, { status: "pending", settled });

    try {
      const result = await effect(undefined);
      // Re-insert at the tail so the map's order is completion order (for LRU
      // eviction), then trim back to the cap.
      entries.delete(key);
      entries.set(key, { status: "done", result, settled });
      evictIfNeeded();
      return { status: "processed", result };
    } catch (err) {
      entries.delete(key); // allow a later delivery to retry
      throw err;
    } finally {
      release();
    }
  }

  return { run };
}
