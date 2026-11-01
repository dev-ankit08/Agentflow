import { defineConfig } from "drizzle-kit";
import { loadRootEnv } from "./scripts/env";

loadRootEnv();

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema/index.ts",
  out: "./drizzle",
  dbCredentials: { url: process.env.DATABASE_URL ?? "" },
});
