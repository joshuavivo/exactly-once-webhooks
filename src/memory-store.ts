import type { IdempotencyStore, Outcome } from "./types.ts";

type Entry = {
  status: "pending" | "done";
  result?: unknown;
  // Every caller for a key awaits this, so concurrent calls serialise behind the
  // first one instead of all running the effect.
  settled: Promise<void>;
};

/**
 * In-memory store. Correct for a single process (tests, a CLI, one server with
 * no replicas). It does NOT share state across processes — for that use the
 * Postgres store. The context passed to the effect is `undefined`.
 */
export function createMemoryStore(): IdempotencyStore<undefined> {
  const entries = new Map<string, Entry>();

  async function run<T>(
    key: string,
    effect: (ctx: undefined) => Promise<T>,
  ): Promise<Outcome<T>> {
    const existing = entries.get(key);
    if (existing) {
      // Wait for the in-flight (or finished) attempt to settle, then look again.
      await existing.settled;
      const after = entries.get(key);
      if (after && after.status === "done") {
        return { status: "duplicate", result: after.result as T };
      }
      // The earlier attempt threw and removed itself; fall through and retry as
      // if we were the first caller.
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
      entries.set(key, { status: "done", result, settled });
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
