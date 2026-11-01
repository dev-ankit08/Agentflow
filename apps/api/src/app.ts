import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import { and, eq, sql } from "drizzle-orm";
import Fastify, { type FastifyServerOptions } from "fastify";
import { ZodError } from "zod";
import { connectors, workspaces, type Db } from "@agentflow/db";
import type { LLMGateway, Price } from "@agentflow/llm-gateway";
import { McpConnectionPool } from "@agentflow/mcp-client";
import { DbRunStore, InProcessExecutor, type RunExecutor, type RunStore } from "@agentflow/runtime";
import type { SecretStore } from "@agentflow/secret-store";
import { HttpError, makeAuth, type Auth } from "./auth";
import { accountRoutes } from "./routes/account";
import { connectorRoutes } from "./routes/connectors";
import { flowRoutes } from "./routes/flows";
import { memberRoutes } from "./routes/members";
import { providerKeyRoutes } from "./routes/provider-keys";
import { publishRoutes } from "./routes/publish";
import { runRoutes } from "./routes/runs";
import { templateRoutes } from "./routes/templates";
import { widgetRoutes } from "./routes/widget";
import { makeBilling, type Billing, type StripeConfig } from "./billing";
import { defaultEndpoints, makeChannels, type ChannelEndpoints, type Channels } from "./channels";
import { analyticsRoutes } from "./routes/analytics";
import { billingRoutes } from "./routes/billing";
import { channelRoutes } from "./routes/channel-routes";
import { evalRoutes } from "./routes/evals";
import { inboxRoutes } from "./routes/inbox";
import { knowledgeRoutes } from "./routes/knowledge";
import { makeGatewayFor, makeGuardedFetch, makeToolsFor } from "./services";
import { makeSandboxServicesFor, makeServicesFor, sandboxTools, sweepExpiredApprovals } from "./workspace-services";
import { approvalLinkRoutes, defaultNotifier, notifyApprovers, type Notifier } from "./approvals";
import { applyRetention, extractMemories, resumeDueTimers, runSchedules } from "./automation";
import { purgeExpiredCache } from "./cache";
import { collabRoutes } from "./collab";
import { sendDueReports } from "./reports";
import { indexKnowledge } from "./semantic";
import { automationRoutes, hookRoutes } from "./routes/automation-routes";
import { auditHook, governanceRoutes } from "./routes/governance";
import { promptRoutes } from "./routes/prompts";
import { roleRoutes } from "./routes/roles";
import { mcpServerRoutes } from "./routes/mcp-server";

function widgetScriptPath(): string | null {
  let dir = process.cwd();
  for (;;) {
    const candidate = resolve(dir, "packages/widget/dist/widget.js");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export type RuntimeConfig = {
  API_JWT_SECRET: string;
  allowStdioMcp: boolean;
  allowPrivateHttp: boolean;
  /** Public base URL of this API, shown as the webhook address for channels and Stripe. */
  publicApiUrl: string;
  /** Tests: process channel messages before answering the webhook. */
  syncChannels: boolean;
  /** Builder address, for links in emails. */
  appUrl: string;
};

export type Deps = {
  db: Db;
  auth: Auth;
  secrets: SecretStore;
  pool: McpConnectionPool;
  store: RunStore;
  executor: RunExecutor;
  evalExecutor: RunExecutor;
  gatewayFor: (workspaceId: string) => LLMGateway;
  channels: Channels;
  channelEndpoints: ChannelEndpoints;
  billing: Billing;
  notifier: Notifier;
  config: RuntimeConfig;
};

export type AppOptions = {
  db: Db;
  secrets: SecretStore;
  jwtSecret: string;
  corsOrigin: string;
  prices?: Record<string, Price>;
  allowStdioMcp?: boolean;
  allowPrivateHttp?: boolean;
  /** Overrides for tests (e.g. a mock model provider). */
  executor?: RunExecutor;
  /** How often background work runs: expired approvals, due timers, schedules, retention (0 disables; tests). */
  sweepIntervalMs?: number;
  publicApiUrl?: string;
  /** Overrides for Slack/WhatsApp/Teams API addresses and Bot Framework keys (tests). */
  channelEndpoints?: Partial<ChannelEndpoints>;
  syncChannels?: boolean;
  /** Stripe billing; omitted when STRIPE_SECRET_KEY is not set. */
  stripe?: StripeConfig | null;
  logger?: FastifyServerOptions["logger"];
  /** Builder address, for links in notifications. */
  appUrl?: string;
  /** SMTP URL for approval emails (EMAIL_SERVER); emails are skipped without it. */
  emailServer?: string;
  emailFrom?: string;
  /** Replaces email/Slack delivery (tests). */
  notifier?: Notifier;
};

declare module "fastify" {
  interface FastifyInstance {
    /** Shared services, exposed for background jobs and tests. */
    deps: Deps;
  }
}

export async function buildApp(opts: AppOptions) {
  const app = Fastify({ logger: opts.logger ?? false });
  const pool = new McpConnectionPool();
  const store = new DbRunStore(opts.db);
  const gatewayFor = makeGatewayFor(opts.db, opts.secrets, opts.prices ?? {});
  const toolsFor = makeToolsFor(opts.db, opts.secrets, pool);
  const publicApiUrl = (opts.publicApiUrl ?? "http://localhost:4000").replace(/\/+$/, "");
  const appUrl = (opts.appUrl ?? "http://localhost:3100").replace(/\/+$/, "");
  const notifier =
    opts.notifier ??
    defaultNotifier(opts.emailServer, opts.emailFrom ?? "AgentFlow <no-reply@agentflow.local>", (msg) =>
      app.log.info(msg),
    );
  // New approvals notify approvers by email and Slack, without holding up the conversation.
  const onApprovalRequested = (approvalId: string) =>
    void notifyApprovers(
      {
        db: opts.db,
        secrets: opts.secrets,
        notifier,
        jwtSecret: opts.jwtSecret,
        publicApiUrl,
        appUrl,
      },
      approvalId,
    ).catch((err) => app.log.warn({ err, approvalId }, "approval notification failed"));
  const fetchImpl = makeGuardedFetch(Boolean(opts.allowPrivateHttp));
  const executor =
    opts.executor ??
    new InProcessExecutor({
      store,
      gatewayFor,
      toolsFor,
      servicesFor: makeServicesFor(opts.db, gatewayFor, onApprovalRequested),
      fetch: fetchImpl,
    });
  // Eval runs: same flows, but write tools are simulated and nothing reaches the inbox.
  const toolMode = (workspaceId: string) => async (ref: string) => {
    const [connectorId, tool] = ref.split("/");
    const [row] = await opts.db
      .select({ catalog: connectors.toolCatalog })
      .from(connectors)
      .where(and(eq(connectors.id, connectorId ?? ""), eq(connectors.workspaceId, workspaceId)));
    return row?.catalog.find((t) => t.name === tool)?.mode;
  };
  const evalExecutor = new InProcessExecutor({
    store,
    gatewayFor,
    toolsFor: (ws) => sandboxTools(toolsFor(ws), toolMode(ws)),
    servicesFor: makeSandboxServicesFor(opts.db, gatewayFor),
    fetch: fetchImpl,
  });
  const billing = makeBilling(opts.db, opts.stripe ?? null);
  const channelEndpoints = { ...defaultEndpoints(), ...opts.channelEndpoints };
  const channels = makeChannels({
    db: opts.db,
    secrets: opts.secrets,
    executor,
    store,
    endpoints: channelEndpoints,
    log: (msg, err) => app.log.error({ err }, msg),
    beforeNewRun: (workspaceId) => billing.checkConversationLimit(workspaceId),
  });
  const deps: Deps = {
    db: opts.db,
    secrets: opts.secrets,
    auth: makeAuth(opts.db, opts.jwtSecret),
    pool,
    store,
    executor,
    evalExecutor,
    gatewayFor,
    channels,
    channelEndpoints,
    billing,
    notifier,
    config: {
      API_JWT_SECRET: opts.jwtSecret,
      allowStdioMcp: Boolean(opts.allowStdioMcp),
      allowPrivateHttp: Boolean(opts.allowPrivateHttp),
      publicApiUrl,
      syncChannels: Boolean(opts.syncChannels),
      appUrl,
    },
  };
  app.decorate("deps", deps);

  await app.register(websocket);
  // The builder origin gets credentialed CORS; widget endpoints accept any origin and check it per widget.
  await app.register(cors, {
    delegator: (req, cb) => {
      const widget = req.url?.startsWith("/v1/widget/");
      cb(null, widget ? { origin: true, credentials: false } : { origin: opts.corsOrigin, credentials: true });
    },
  });
  // Background work: approvals past their deadline take their "timeout" path, Wait nodes whose time has
  // come continue, schedules fire, and old data is removed per the workspace's retention settings.
  let lastRetention = 0;
  const sweep = async () => {
    await sweepExpiredApprovals(opts.db, executor).catch((err) => app.log.error({ err }, "approval sweep failed"));
    await resumeDueTimers(opts.db, executor).catch((err) => app.log.error({ err }, "timer sweep failed"));
    await runSchedules(opts.db, executor).catch((err) => app.log.error({ err }, "schedule sweep failed"));
    const services = makeServicesFor(opts.db, gatewayFor, onApprovalRequested);
    await extractMemories(opts.db, gatewayFor, async (ws) => services(ws).checkBudget?.()).catch((err) =>
      app.log.error({ err }, "memory extraction failed"),
    );
    // Knowledge added or re-synced since the last sweep, or a new embedding model, gets indexed in the background.
    const embedding = await opts.db
      .select({ id: workspaces.id })
      .from(workspaces)
      .where(sql`${workspaces.settings} ? 'embedding'`)
      .catch(() => []);
    for (const ws of embedding) {
      await indexKnowledge(opts.db, gatewayFor(ws.id), ws.id).catch((err) =>
        app.log.warn({ err, workspaceId: ws.id }, "knowledge indexing failed"),
      );
    }
    if (Date.now() - lastRetention > 3_600_000) {
      lastRetention = Date.now();
      await applyRetention(opts.db).catch((err) => app.log.error({ err }, "retention sweep failed"));
      await purgeExpiredCache(opts.db).catch((err) => app.log.error({ err }, "cache purge failed"));
    }
    await sendDueReports(opts.db, notifier, appUrl).catch((err) => app.log.error({ err }, "weekly reports failed"));
  };
  const sweeper = opts.sweepIntervalMs === 0 ? null : setInterval(() => void sweep(), opts.sweepIntervalMs ?? 20_000);
  sweeper?.unref();
  app.addHook("onClose", async () => {
    if (sweeper) clearInterval(sweeper);
    await pool.closeAll();
  });

  app.setErrorHandler((error, req, reply) => {
    if (error instanceof ZodError) {
      return reply.code(400).send({
        error: "Invalid request",
        issues: error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
      });
    }
    if (error instanceof HttpError) return reply.code(error.statusCode).send({ error: error.message });
    const status = (error as { statusCode?: number }).statusCode;
    if (status && status < 500) return reply.code(status).send({ error: (error as Error).message });
    req.log.error(error);
    return reply.code(500).send({ error: "Internal server error" });
  });

  // The embeddable widget script (built by packages/widget).
  app.get("/widget.js", async (_req, reply) => {
    const file = widgetScriptPath();
    if (!file)
      return reply.code(404).send("// AgentFlow widget is not built yet: run pnpm --filter @agentflow/widget build");
    return reply
      .header("content-type", "application/javascript; charset=utf-8")
      .header("cache-control", "public, max-age=300")
      .header("access-control-allow-origin", "*")
      .send(readFileSync(file));
  });

  app.get("/health", async () => {
    await opts.db.execute(sql`select 1`);
    return { ok: true };
  });

  await app.register(
    async (v1) => {
      v1.addHook("onResponse", auditHook(opts.db));
      await v1.register((s) => accountRoutes(s, deps));
      await v1.register((s) => memberRoutes(s, deps));
      await v1.register((s) => providerKeyRoutes(s, deps));
      await v1.register((s) => flowRoutes(s, deps));
      await v1.register((s) => publishRoutes(s, deps));
      await v1.register((s) => runRoutes(s, deps));
      await v1.register((s) => connectorRoutes(s, deps));
      await v1.register((s) => templateRoutes(s, deps));
      await v1.register((s) => widgetRoutes(s, deps));
      await v1.register((s) => knowledgeRoutes(s, deps));
      await v1.register((s) => inboxRoutes(s, deps));
      await v1.register((s) => evalRoutes(s, deps));
      await v1.register((s) => analyticsRoutes(s, deps));
      await v1.register((s) => channelRoutes(s, deps));
      await v1.register((s) => billingRoutes(s, deps));
      await v1.register((s) => governanceRoutes(s, deps));
      await v1.register((s) => promptRoutes(s, deps));
      await v1.register((s) => roleRoutes(s, deps));
      await v1.register((s) => mcpServerRoutes(s, deps));
      await v1.register((s) => collabRoutes(s, { db: opts.db, jwtSecret: opts.jwtSecret }));
      await v1.register((s) => automationRoutes(s, deps));
      await v1.register((s) => hookRoutes(s, deps));
      await v1.register((s) => approvalLinkRoutes(s, { ...deps, jwtSecret: opts.jwtSecret }));
    },
    { prefix: "/v1" },
  );

  return app;
}
