// Compile-time check: no assertions, and nothing calls readmeExample(). It exists
// so `npm run typecheck` compiles the README's node-redis example against the
// node-redis client that is installed.
import { createClient } from "redis";
import { createRedisStore, fromNodeRedis } from "../src/redis-store.ts";

export function readmeExample() {
  const client = createClient({ url: "redis://localhost:6379" });
  return createRedisStore(fromNodeRedis(client));
}
