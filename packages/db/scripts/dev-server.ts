import { existsSync } from "node:fs";
import { resolve } from "node:path";
import EmbeddedPostgres from "embedded-postgres";
import { loadRootEnv, repoRoot } from "./env";

/**
 * Runs a real Postgres server for local development without Docker.
 * Data lives in .data/pg; connection details come from DATABASE_URL.
 */
loadRootEnv();
const url = new URL(process.env.DATABASE_URL ?? "postgres://agentflow:agentflow@localhost:5433/agentflow");
const databaseDir = resolve(repoRoot, ".data/pg");
const database = url.pathname.slice(1) || "agentflow";

const pg = new EmbeddedPostgres({
  databaseDir,
  user: decodeURIComponent(url.username) || "agentflow",
  password: decodeURIComponent(url.password) || "agentflow",
  port: Number(url.port || 5433),
  persistent: true,
  onLog: () => {},
});

const fresh = !existsSync(resolve(databaseDir, "PG_VERSION"));
if (fresh) await pg.initialise();
await pg.start();
if (fresh) await pg.createDatabase(database);

console.log(
  `✓ Postgres running on port ${url.port || 5433} (database "${database}", data in .data/pg). Ctrl+C to stop.`,
);

const stop = async () => {
  await pg.stop();
  process.exit(0);
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
setInterval(() => {}, 1 << 30);
