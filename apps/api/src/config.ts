import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { z } from "zod";

/** Finds the monorepo root (where pnpm-workspace.yaml lives) and loads its .env, if any. */
export function loadRootEnv(from = process.cwd()) {
  let dir = from;
  while (!existsSync(resolve(dir, "pnpm-workspace.yaml"))) {
    const parent = dirname(dir);
    if (parent === dir) return;
    dir = parent;
  }
  const file = resolve(dir, ".env");
  if (existsSync(file)) process.loadEnvFile(file);
}

const ConfigSchema = z.object({
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  API_JWT_SECRET: z.string().min(16, "API_JWT_SECRET must be at least 16 characters"),
  SECRETS_MASTER_KEY: z.string().min(1, "SECRETS_MASTER_KEY is required"),
  API_PORT: z.coerce.number().int().default(4000),
  AUTH_URL: z.string().default("http://localhost:3100"),
  LOG_LEVEL: z.string().default("info"),
  /** Development only: allow local (stdio) MCP servers and HTTP calls to private addresses. */
  ALLOW_STDIO_MCP: z.stringbool().default(false),
  /** Public address of this API (webhook URLs for Slack, Teams, WhatsApp and Stripe). */
  PUBLIC_API_URL: z.string().optional(),
  /** SMTP for approval emails, e.g. smtp://user:pass@smtp.example.com:587 (skipped when unset). */
  EMAIL_SERVER: z.string().optional(),
  EMAIL_FROM: z.string().default("AgentFlow <no-reply@agentflow.local>"),
  /** Stripe billing (optional; billing is off and unlimited without STRIPE_SECRET_KEY). */
  STRIPE_SECRET_KEY: z.string().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),
  STRIPE_PRICE_PRO: z.string().optional(),
  STRIPE_PRICE_BUSINESS: z.string().optional(),
  ALLOW_PRIVATE_HTTP: z.stringbool().default(false),
  /** Optional model prices, USD per million tokens: {"model-name": {"input": 3, "output": 15}}. */
  LLM_PRICES_JSON: z
    .string()
    .default("{}")
    .transform((s, ctx) => {
      try {
        return JSON.parse(s) as Record<string, { input: number; output: number }>;
      } catch {
        ctx.addIssue({ code: "custom", message: "LLM_PRICES_JSON must be valid JSON" });
        return z.NEVER;
      }
    }),
});

export type Config = z.infer<typeof ConfigSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = ConfigSchema.safeParse(env);
  if (!parsed.success) {
    const lines = parsed.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid API configuration:\n${lines}`);
  }
  return parsed.data;
}
