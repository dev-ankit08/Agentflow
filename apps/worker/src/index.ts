import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { sql } from "drizzle-orm";
import { createDb } from "@agentflow/db";

/**
 * Background worker. Phase 0 only checks the database and stays alive;
 * Phase 1 adds the graph executor (RunExecutor) and BullMQ job processors here.
 */
function loadRootEnv(from = process.cwd()) {
  let dir = from;
  while (!existsSync(resolve(dir, "pnpm-workspace.yaml"))) {
    const parent = dirname(dir);
    if (parent === dir) return;
    dir = parent;
  }
  if (existsSync(resolve(dir, ".env"))) process.loadEnvFile(resolve(dir, ".env"));
}

loadRootEnv();
const url = process.env.DATABASE_URL;
if (!url) throw new Error("DATABASE_URL is not set. Copy .env.example to .env first.");

const { db, close } = createDb(url, { max: 2 });
await db.execute(sql`select 1`);
console.log("[worker] ready (database reachable). Runtime and job queues arrive in Phase 1.");

const heartbeat = setInterval(async () => {
  try {
    await db.execute(sql`select 1`);
  } catch (error) {
    console.error("[worker] database check failed:", (error as Error).message);
  }
}, 60_000);

const shutdown = async () => {
  clearInterval(heartbeat);
  await close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
