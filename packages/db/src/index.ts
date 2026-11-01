import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

export * from "./schema";
export { newId } from "./ids";
export { schema };

export type Db = ReturnType<typeof createDb>["db"];

export function createDb(url: string, options: { max?: number } = {}) {
  const client = postgres(url, { max: options.max ?? 10 });
  const db = drizzle(client, { schema });
  return { db, close: () => client.end({ timeout: 5 }) };
}
