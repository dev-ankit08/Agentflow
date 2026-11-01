import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { createDb } from "../src";
import { loadRootEnv, requireDatabaseUrl } from "./env";

loadRootEnv();
const { db, close } = createDb(requireDatabaseUrl(), { max: 1 });
const migrationsFolder = resolve(dirname(fileURLToPath(import.meta.url)), "../drizzle");

try {
  await migrate(db, { migrationsFolder });
  console.log("✓ Migrations applied");
} finally {
  await close();
}
