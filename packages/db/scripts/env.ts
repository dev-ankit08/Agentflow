import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

/** Loads the repo-root .env; variables already set in the environment win. */
export function loadRootEnv() {
  const file = resolve(repoRoot, ".env");
  if (existsSync(file)) process.loadEnvFile(file);
}

export function requireDatabaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set. Copy .env.example to .env first.");
  return url;
}
