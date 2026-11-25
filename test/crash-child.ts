// A webhook handler in its own process, started by postgres-crash.test.ts and
// killed with SIGKILL at a chosen point. It is not a test: `node --test` loads
// every file under test/, so with no arguments this file does nothing.
//
//   node test/crash-child.ts <key> <mode> <pid of the test process>
//     mid-effect    credit, print IN_EFFECT, then hang inside the effect (the
//                   transaction is open; nothing is committed)
//     after-commit  credit, let run() commit, print COMMITTED, then hang before
//                   "answering" (the provider never sees a 2xx)
import { createPostgresStore, type Pool } from "../src/postgres-store.ts";

const [key, mode, testPid] = process.argv.slice(2);
const url = process.env.DATABASE_URL;

if (key && mode && testPid && url) {
  const specifier = "pg";
  const pg = (await import(specifier)) as { default: { Pool: new (c: object) => unknown } };
  const pool = new pg.default.Pool({ connectionString: url, max: 1 }) as unknown as Pool;
  const store = createPostgresStore(pool);
  const forever = new Promise<never>(() => {});
  // The timer keeps Node running (an unresolved promise alone does not). It also
  // checks that the test process is still there: if that process is gone (it was
  // killed, so its cleanup never ran), this one exits within about 200 ms, which
  // drops its connection and with it any open transaction. The pid is passed in
  // rather than read from process.ppid, which is already 1 if the parent died
  // before this line ran.
  const keepAlive = setInterval(() => {
    try {
      process.kill(Number(testPid), 0); // signal 0: an existence check, sends nothing
    } catch {
      process.exit(1);
    }
  }, 200);

  await store.run(key, async (tx) => {
    await tx.query("INSERT INTO eow_crash_credits (key) VALUES ($1)", [key]);
    if (mode === "mid-effect") {
      console.log("IN_EFFECT");
      await forever;
    }
    return "credited";
  });
  console.log("COMMITTED");
  await forever;
  clearInterval(keepAlive);
}
