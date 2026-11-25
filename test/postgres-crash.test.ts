import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createPostgresStore, type Pool } from "../src/postgres-store.ts";
import { loadSchema } from "./pg-schema.ts";

// What happens when the process handling a webhook dies. Each test starts a real
// handler in a child process (crash-child.ts), kills it with SIGKILL at a chosen
// point, and then delivers the same event again from this process, the way a
// provider redelivers after it gets no 2xx. The "credit" is a row in a scratch
// table written through the store's transaction, so the count of rows for a key
// is the number of times the customer was credited.
//
// Needs a real Postgres (DATABASE_URL); a crash can't be faked in one process.
const url = process.env.DATABASE_URL;
const childPath = fileURLToPath(new URL("./crash-child.ts", import.meta.url));

if (url) {
  const runId = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const specifier = "pg";
  const pg = (await import(specifier)) as { default: { Pool: new (c: object) => unknown } };
  const pool = new pg.default.Pool({ connectionString: url }) as unknown as Pool & { end(): Promise<void> };
  const store = createPostgresStore(pool);

  const setup = await pool.connect();
  try {
    await loadSchema(setup, [new URL("../schema.sql", import.meta.url)]);
    await setup.query("CREATE TABLE IF NOT EXISTS eow_crash_credits (key text NOT NULL, at timestamptz NOT NULL DEFAULT now())");
  } finally {
    setup.release();
  }

  const credits = async (key: string): Promise<number> => {
    const c = await pool.connect();
    try {
      const r = await c.query("SELECT count(*)::int AS n FROM eow_crash_credits WHERE key = $1", [key]);
      return (r.rows[0] as { n: number }).n;
    } finally {
      c.release();
    }
  };

  // Every handler started here is killed when the file ends, pass or fail: a
  // failed assertion must not leave a child process holding the run open.
  const started: ChildProcess[] = [];
  after(() => {
    for (const child of started) child.kill("SIGKILL");
  });
  // `after` does not run if the test runner is killed outright, and this process
  // can then be left waiting on a handler that is waiting on it. So watch for the
  // runner going away (this process gets a new parent), and stop everything.
  const runner = process.ppid;
  setInterval(() => {
    if (process.ppid !== runner) {
      for (const child of started) child.kill("SIGKILL");
      process.exit(1);
    }
  }, 200).unref();

  // Start the handler and resolve once it prints `marker`.
  const startHandler = (key: string, mode: "mid-effect" | "after-commit", marker: string): Promise<ChildProcess> =>
    new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [childPath, key, mode, String(process.pid)], { env: process.env, stdio: ["ignore", "pipe", "pipe"] });
      started.push(child);
      let out = "";
      let err = "";
      // A handler that never reaches its marker fails the test instead of hanging it.
      const giveUp = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error(`handler did not print ${marker} within 10 s: ${err}`));
      }, 10_000);
      child.stdout!.on("data", (d: Buffer) => {
        out += d.toString();
        if (out.includes(marker)) {
          clearTimeout(giveUp);
          resolve(child);
        }
      });
      child.stderr!.on("data", (d: Buffer) => { err += d.toString(); });
      child.on("exit", (code) => {
        clearTimeout(giveUp);
        reject(new Error(`handler exited (${code}) before printing ${marker}: ${err}`));
      });
    });

  const kill = (child: ChildProcess): Promise<void> =>
    new Promise((resolve) => {
      child.removeAllListeners("exit");
      child.on("exit", () => resolve());
      child.kill("SIGKILL");
    });

  const redeliver = (key: string) =>
    store.run(key, async (tx) => {
      await tx.query("INSERT INTO eow_crash_credits (key) VALUES ($1)", [key]);
      return "credited";
    });

  test("[postgres crash] killed inside the effect: its credit rolls back and the redelivery credits once", async () => {
    const key = `evt_crash_${runId}_mid`;
    const handler = await startHandler(key, "mid-effect", "IN_EFFECT");
    await kill(handler);

    // The dead handler's transaction never committed, so its credit is gone and
    // its claim with it: the redelivery is the first run, not a duplicate.
    assert.deepEqual(await redeliver(key), { status: "processed", result: "credited" });
    assert.equal(await credits(key), 1, "credited once: the killed attempt left nothing behind");
    assert.deepEqual(await redeliver(key), { status: "duplicate", result: "credited" });
    assert.equal(await credits(key), 1);
  });

  test("[postgres crash] a redelivery already waiting when the holder is killed takes over and credits once", async () => {
    const key = `evt_crash_${runId}_waiter`;
    const handler = await startHandler(key, "mid-effect", "IN_EFFECT");
    // The second copy arrives while the first handler is still inside its effect.
    // It blocks on the first handler's uncommitted claim.
    let waiterSettled = false;
    const waiter = redeliver(key).finally(() => { waiterSettled = true; });
    waiter.catch(() => {}); // a failure is asserted below, not left as an unhandled rejection
    await new Promise((r) => setTimeout(r, 300));
    try {
      assert.equal(waiterSettled, false, "the second copy waits while the first handler holds the key");
    } finally {
      await kill(handler);
    }

    assert.deepEqual(await waiter, { status: "processed", result: "credited" });
    assert.equal(await credits(key), 1, "credited once: by the waiter, after the holder died");
  });

  test("[postgres crash] killed after commit but before answering: the redelivery is a duplicate", async () => {
    // The provider never got a 2xx, so it delivers again. The credit and the
    // "done" record committed together, so the second delivery must not credit.
    const key = `evt_crash_${runId}_after`;
    const handler = await startHandler(key, "after-commit", "COMMITTED");
    await kill(handler);

    assert.deepEqual(await redeliver(key), { status: "duplicate", result: "credited" });
    assert.equal(await credits(key), 1, "credited once: by the handler that died after committing");
  });

  test("close the crash-test pool", async () => {
    await pool.end();
  });
} else {
  test("postgres crash tests (skipped: set DATABASE_URL to run)", { skip: true }, () => {});
}
