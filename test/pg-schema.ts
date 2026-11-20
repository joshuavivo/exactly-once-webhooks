import { readFileSync } from "node:fs";
import type { Queryable } from "../src/index.ts";

// `node --test` runs test files in parallel, and more than one of them loads the
// schema into the same database at startup. `CREATE TABLE IF NOT EXISTS` is not
// safe under concurrency in Postgres: two sessions can both see "not exists" and
// the loser fails on the pg_type unique index. A session-level advisory lock
// makes the loads take turns. The lock id is arbitrary but fixed.
const SCHEMA_LOCK = 727_001;

export async function loadSchema(client: Queryable, files: URL[]): Promise<void> {
  await client.query("SELECT pg_advisory_lock($1)", [SCHEMA_LOCK]);
  try {
    for (const f of files) await client.query(readFileSync(f, "utf8"));
  } finally {
    await client.query("SELECT pg_advisory_unlock($1)", [SCHEMA_LOCK]);
  }
}
