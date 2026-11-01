import { createDb } from "@agentflow/db";
import { createSecretStore } from "@agentflow/secret-store";
import { buildApp } from "./app";
import { loadConfig, loadRootEnv } from "./config";

loadRootEnv();
const config = loadConfig();
const { db, close } = createDb(config.DATABASE_URL);

const app = await buildApp({
  db,
  secrets: createSecretStore(config.SECRETS_MASTER_KEY),
  jwtSecret: config.API_JWT_SECRET,
  corsOrigin: config.AUTH_URL,
  prices: config.LLM_PRICES_JSON,
  allowStdioMcp: config.ALLOW_STDIO_MCP,
  allowPrivateHttp: config.ALLOW_PRIVATE_HTTP,
  publicApiUrl: config.PUBLIC_API_URL ?? `http://localhost:${config.API_PORT}`,
  appUrl: config.AUTH_URL,
  emailServer: config.EMAIL_SERVER || undefined,
  emailFrom: config.EMAIL_FROM,
  stripe: config.STRIPE_SECRET_KEY
    ? {
        secretKey: config.STRIPE_SECRET_KEY,
        webhookSecret: config.STRIPE_WEBHOOK_SECRET ?? "",
        prices: { pro: config.STRIPE_PRICE_PRO, business: config.STRIPE_PRICE_BUSINESS },
        appUrl: config.AUTH_URL,
      }
    : null,
  logger: { level: config.LOG_LEVEL },
});

const shutdown = async () => {
  await app.close();
  await close();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

await app.listen({ port: config.API_PORT, host: "0.0.0.0" });
