import { test } from "node:test";
import assert from "node:assert/strict";
import { createPostgresStore, type Pool } from "../src/postgres-store.ts";

// No database needed: a fake pool whose ROLLBACK fails stands in for a connection
// that broke mid-transaction. Such a connection must be destroyed, not handed back
// to the pool for the next caller to trip over.
function fakePool(rollbackFails: boolean) {
  const released: unknown[] = [];
  const pool: Pool = {
    async connect() {
      return {
        async query(sql: string) {
          if (sql.startsWith("INSERT")) return { rows: [{ key: "k" }] };
          if (sql === "ROLLBACK" && rollbackFails) throw new Error("connection terminated");
          return { rows: [] };
        },
        release(err?: Error | boolean) { released.push(err); },
      };
    },
  };
  return { pool, released };
}

test("[postgres] a connection whose ROLLBACK failed is released with the error, so the pool drops it", async () => {
  const { pool, released } = fakePool(true);
  const store = createPostgresStore(pool);
  await assert.rejects(() => store.run("k", async () => { throw new Error("effect failed"); }), /effect failed/);
  assert.equal(released.length, 1);
  assert.ok(released[0] instanceof Error, "release() got the ROLLBACK error, so pg destroys the client");
});

test("[postgres] after a clean ROLLBACK the connection goes back to the pool as normal", async () => {
  const { pool, released } = fakePool(false);
  const store = createPostgresStore(pool);
  await assert.rejects(() => store.run("k", async () => { throw new Error("effect failed"); }), /effect failed/);
  assert.deepEqual(released, [undefined], "a healthy connection is reused, not destroyed");
});
