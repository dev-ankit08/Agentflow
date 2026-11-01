import "server-only";
import { createDb, type Db } from "@agentflow/db";

const globalForDb = globalThis as unknown as { agentflowDb?: Db };

/** Used only by Auth.js; all product data goes through the API. */
export function getDb(): Db {
  if (!globalForDb.agentflowDb) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("DATABASE_URL is not set");
    globalForDb.agentflowDb = createDb(url, { max: 5 }).db;
  }
  return globalForDb.agentflowDb;
}
