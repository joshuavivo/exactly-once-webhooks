// Reproducible benchmark for the three stores. `npm run bench` runs the memory
// store; set DATABASE_URL and/or REDIS_URL to include the real servers. The
// `bench` workflow runs all three on a GitHub-hosted runner and writes the table
// to the run summary, so the README numbers link to the run that produced them.
//
// Two scenarios, because they answer different questions:
//   distinct keys  — normal traffic: every webhook is a different event.
//                    Throughput and per-call latency of the claim/record path.
//   hot key        — the failure the library exists for: N copies of ONE event
//                    at once. How long until all N callers have their answer,
//                    and how many times the effect ran (must be exactly 1).

import { performance } from "node:perf_hooks";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createMemoryStore, createPostgresStore, createRedisStore, fromNodeRedis, type IdempotencyStore, type Pool } from "../src/index.ts";

const DISTINCT = Number(process.env.BENCH_DISTINCT ?? 2000);
const CONCURRENCY = Number(process.env.BENCH_CONCURRENCY ?? 32);
const HOT_COPIES = Number(process.env.BENCH_HOT ?? 100);
const HOT_EFFECT_MS = 20; // a realistic "write to the DB / call the provider" effect
const run = `${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;

const pct = (sorted: number[], p: number) => sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!;
const ms = (n: number) => n.toFixed(2);

async function distinctKeys(store: IdempotencyStore<any>, label: string) {
  const lat: number[] = [];
  let next = 0;
  const t0 = performance.now();
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      for (let i = next++; i < DISTINCT; i = next++) {
        const s = performance.now();
        await store.run(`bench_${run}_${label}_d_${i}`, async () => i);
        lat.push(performance.now() - s);
      }
    }),
  );
  const secs = (performance.now() - t0) / 1000;
  lat.sort((a, b) => a - b);
  return { opsPerSec: Math.round(DISTINCT / secs), p50: pct(lat, 50), p99: pct(lat, 99) };
}

async function hotKey(store: IdempotencyStore<any>, label: string) {
  let runs = 0;
  const key = `bench_${run}_${label}_hot`;
  const t0 = performance.now();
  const out = await Promise.all(
    Array.from({ length: HOT_COPIES }, () =>
      store.run(key, async () => {
        runs += 1;
        await new Promise((r) => setTimeout(r, HOT_EFFECT_MS));
        return "credited";
      }),
    ),
  );
  const settle = performance.now() - t0;
  const processed = out.filter((o) => o.status === "processed").length;
  if (runs !== 1 || processed !== 1) throw new Error(`${label}: effect ran ${runs} times`);
  return { settleMs: settle, runs };
}

type Target = { label: string; store: IdempotencyStore<any>; close: () => Promise<void> };

async function targets(): Promise<Target[]> {
  const out: Target[] = [{ label: "memory", store: createMemoryStore(), close: async () => {} }];
  if (process.env.DATABASE_URL) {
    const spec = "pg";
    const pg = (await import(spec)) as { default: { Pool: new (c: object) => unknown } };
    const pool = new pg.default.Pool({ connectionString: process.env.DATABASE_URL, max: CONCURRENCY + 4 }) as Pool & { end(): Promise<void> };
    const c = await pool.connect();
    await c.query(readFileSync(fileURLToPath(new URL("../schema.sql", import.meta.url)), "utf8"));
    c.release();
    out.push({ label: "postgres", store: createPostgresStore(pool), close: () => pool.end() });
  }
  if (process.env.REDIS_URL) {
    const spec = "redis";
    const mod = (await import(spec)) as { createClient: (o: object) => any };
    const client = mod.createClient({ url: process.env.REDIS_URL });
    await client.connect();
    out.push({ label: "redis", store: createRedisStore(fromNodeRedis(client), { pollIntervalMs: 2 }), close: () => client.quit() });
  }
  return out;
}

const rows: string[] = [];
for (const t of await targets()) {
  await distinctKeys(t.store, t.label + "_warm"); // warm-up: JIT, pool connections
  const d = await distinctKeys(t.store, t.label);
  const h = await hotKey(t.store, t.label);
  rows.push(`| ${t.label} | ${d.opsPerSec.toLocaleString("en-US")} | ${ms(d.p50)} | ${ms(d.p99)} | ${HOT_COPIES} → ${h.runs} | ${ms(h.settleMs)} |`);
  await t.close();
}

const table = [
  `Node ${process.version}, ${process.platform}/${process.arch}. Distinct keys: ${DISTINCT} calls, ${CONCURRENCY} in flight. Hot key: ${HOT_COPIES} concurrent copies of one event, ${HOT_EFFECT_MS} ms effect.`,
  "",
  "| store | distinct keys, calls/s | p50 ms | p99 ms | hot key: copies → effect runs | hot key: all answered in ms |",
  "|---|---:|---:|---:|---:|---:|",
  ...rows,
].join("\n");
console.log(table);
if (process.env.GITHUB_STEP_SUMMARY) {
  const { appendFileSync } = await import("node:fs");
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `## Benchmark\n\n${table}\n`);
}
