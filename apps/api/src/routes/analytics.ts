import { and, eq, gte, isNotNull, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { ModelRef } from "@agentflow/flow-schema";
import { feedback, flows, runSteps, runs, workspaces, type Db, type WorkspaceSettings } from "@agentflow/db";
import { HttpError, currentUser, currentWorkspace } from "../auth";
import type { Deps } from "../app";
import { cacheStats } from "../cache";
import { toCsv } from "../csv";
import { sendReport } from "../reports";
import { monthUsage } from "../workspace-services";

const WorkspaceSettingsBody = z.object({
  budget: z
    .object({ monthlyUsd: z.number().positive().optional(), monthlyTokens: z.number().int().positive().optional() })
    .nullable()
    .optional(),
  roi: z.object({ costPerConversation: z.number().min(0), minutesPerConversation: z.number().min(0) }).optional(),
  retention: z
    .object({ days: z.number().int().min(1).max(3650).optional(), zeroRetention: z.boolean().optional() })
    .optional(),
  notifications: z
    .object({
      emailApprovers: z.boolean(),
      /** Slack incoming-webhook URL; null removes it, omitted keeps the saved one. */
      slackWebhookUrl: z
        .string()
        .trim()
        .regex(
          /^https:\/\/hooks\.slack\.com\/services\//,
          "Use a Slack incoming-webhook URL (https://hooks.slack.com/services/…)",
        )
        .nullable()
        .optional(),
    })
    .optional(),
  reports: z
    .object({
      enabled: z.boolean(),
      weekday: z.number().int().min(0).max(6).default(1),
      hourUtc: z.number().int().min(0).max(23).default(8),
      extraRecipients: z.array(z.string().trim().email()).max(20).default([]),
    })
    .optional(),
  cache: z
    .object({
      enabled: z.boolean(),
      ttlHours: z.number().int().min(1).max(720).default(24),
      similar: z.boolean().default(false),
    })
    .optional(),
  memoryExtraction: z
    .object({ enabled: z.boolean(), model: ModelRef, idleMinutes: z.number().int().min(1).max(1440).default(30) })
    .nullable()
    .optional(),
  embedding: z
    .object({
      provider: z.enum(["openai", "azure_openai", "openai_compatible"]),
      name: z.string().trim().min(1).max(200),
    })
    .nullable()
    .optional(),
});

const FlowSettingsBody = z.object({
  publishGate: z.object({ enabled: z.boolean(), minPassRate: z.number().min(0).max(1) }).optional(),
  requireReview: z.boolean().optional(),
});

const DEFAULT_ROI = { costPerConversation: 6, minutesPerConversation: 8 };

/** Live-conversation metrics and ROI for a workspace over the last `days` (dashboard, CSV export, email reports). */
export async function analyticsSummary(db: Db, workspaceId: string, days: number) {
  const since = new Date(Date.now() - days * 86_400_000);
  // Published (live) conversations only: test-console and eval runs are excluded.
  const live = and(
    eq(runs.workspaceId, workspaceId),
    gte(runs.startedAt, since),
    eq(runs.sandbox, false),
    isNotNull(runs.flowVersionId),
  );
  const outcome = sql<string | null>`${runs.state}->>'outcome'`;

  const [totals] = await db
    .select({
      runs: sql<number>`count(*)::int`,
      resolved: sql<number>`count(*) filter (where ${outcome} = 'resolved')::int`,
      escalated: sql<number>`count(*) filter (where ${outcome} = 'escalated')::int`,
      converted: sql<number>`count(*) filter (where ${outcome} = 'converted')::int`,
      failed: sql<number>`count(*) filter (where ${outcome} = 'failed')::int`,
      aiCostUsd: sql<string>`coalesce(sum(${runs.costUsd}), 0)`,
    })
    .from(runs)
    .where(live);
  const [tokens] = await db
    .select({
      n: sql<number>`coalesce(sum(coalesce(${runSteps.tokensIn},0) + coalesce(${runSteps.tokensOut},0)), 0)::bigint`,
    })
    .from(runSteps)
    .innerJoin(runs, eq(runs.id, runSteps.runId))
    .where(live);
  const [csat] = await db
    .select({ avg: sql<number | null>`avg(${feedback.rating})::float`, count: sql<number>`count(*)::int` })
    .from(feedback)
    .innerJoin(runs, eq(runs.id, feedback.runId))
    .where(live);
  const daily = await db
    .select({
      day: sql<string>`to_char(date_trunc('day', ${runs.startedAt}), 'YYYY-MM-DD')`,
      runs: sql<number>`count(*)::int`,
      resolved: sql<number>`count(*) filter (where ${outcome} in ('resolved','converted'))::int`,
    })
    .from(runs)
    .where(live)
    .groupBy(sql`1`)
    .orderBy(sql`1`);
  const byFlow = await db
    .select({
      flowId: flows.id,
      name: flows.name,
      runs: sql<number>`count(*)::int`,
      resolved: sql<number>`count(*) filter (where ${outcome} in ('resolved','converted'))::int`,
      escalated: sql<number>`count(*) filter (where ${outcome} = 'escalated')::int`,
    })
    .from(runs)
    .innerJoin(flows, eq(flows.id, runs.flowId))
    .where(live)
    .groupBy(flows.id, flows.name)
    .orderBy(sql`count(*) desc`);

  const [wsRow] = await db
    .select({ settings: workspaces.settings })
    .from(workspaces)
    .where(eq(workspaces.id, workspaceId));
  const baseline = wsRow?.settings.roi ?? DEFAULT_ROI;
  const t = totals!;
  const withOutcome = t.resolved + t.escalated + t.converted + t.failed;
  const automated = t.resolved + t.converted;
  const aiCostUsd = Number(t.aiCostUsd);
  return {
    days,
    totals: {
      runs: t.runs,
      resolved: t.resolved,
      escalated: t.escalated,
      converted: t.converted,
      failed: t.failed,
      resolutionRate: withOutcome ? automated / withOutcome : null,
      tokens: Number(tokens?.n ?? 0),
      aiCostUsd,
      csat: csat?.avg ?? null,
      feedbackCount: csat?.count ?? 0,
    },
    roi: {
      baseline,
      baselineIsDefault: !wsRow?.settings.roi,
      hoursSaved: (automated * baseline.minutesPerConversation) / 60,
      grossSavingsUsd: automated * baseline.costPerConversation,
      netSavingsUsd: automated * baseline.costPerConversation - aiCostUsd,
    },
    daily,
    byFlow,
  };
}

/** ROI dashboard (H4), workspace budget and baseline settings (H11), per-flow publish rules. */
export async function analyticsRoutes(app: FastifyInstance, { db, auth, secrets, notifier, config }: Deps) {
  app.get<{ Querystring: { days?: string; format?: string; table?: string } }>(
    "/analytics",
    { preHandler: auth.requireWorkspace("viewer") },
    async (req, reply) => {
      const ws = currentWorkspace(req);
      const days = Math.min(Math.max(Number(req.query.days ?? 30) || 30, 1), 365);
      const summary = await analyticsSummary(db, ws.id, days);
      if (req.query.format === "csv") {
        // CSV export: per-day ROI (default) or per-flow totals (?table=flows).
        const csv =
          req.query.table === "flows"
            ? toCsv(
                ["flow", "conversations", "automated", "escalated", "automation_rate"],
                summary.byFlow.map((f) => [
                  f.name,
                  f.runs,
                  f.resolved,
                  f.escalated,
                  f.runs ? (f.resolved / f.runs).toFixed(3) : "",
                ]),
              )
            : toCsv(
                ["day", "conversations", "automated", "hours_saved", "gross_savings_usd"],
                summary.daily.map((d) => [
                  d.day,
                  d.runs,
                  d.resolved,
                  ((d.resolved * summary.roi.baseline.minutesPerConversation) / 60).toFixed(2),
                  (d.resolved * summary.roi.baseline.costPerConversation).toFixed(2),
                ]),
              );
        return reply
          .header("content-type", "text/csv; charset=utf-8")
          .header(
            "content-disposition",
            `attachment; filename="analytics-${req.query.table === "flows" ? "flows" : "daily"}-${days}d.csv"`,
          )
          .send(csv);
      }
      return summary;
    },
  );

  /** Sends this week's report to the caller now, to preview it. */
  app.post("/reports/send-test", { preHandler: auth.requireWorkspace("admin") }, async (req) => {
    const user = currentUser(req);
    if (!user.email) throw new HttpError(400, "Your account has no email address");
    if (notifier.emailConfigured === false)
      throw new HttpError(409, "Email is not set up: set EMAIL_SERVER (SMTP) for the API, then try again");
    return sendReport(db, notifier, config.appUrl, currentWorkspace(req).id, [user.email]);
  });

  app.get("/workspace/settings", { preHandler: auth.requireWorkspace("viewer") }, async (req) => {
    const ws = currentWorkspace(req);
    const [row] = await db.select({ settings: workspaces.settings }).from(workspaces).where(eq(workspaces.id, ws.id));
    return {
      settings: row?.settings ?? {},
      usage: await monthUsage(db, ws.id),
      cache: await cacheStats(db, ws.id),
      defaults: { roi: DEFAULT_ROI },
    };
  });

  app.put("/workspace/settings", { preHandler: auth.requireWorkspace("admin") }, async (req) => {
    const body = WorkspaceSettingsBody.parse(req.body);
    const ws = currentWorkspace(req);
    const [row] = await db.select({ settings: workspaces.settings }).from(workspaces).where(eq(workspaces.id, ws.id));
    const settings: WorkspaceSettings = { ...row?.settings };
    if ("budget" in body) settings.budget = body.budget ?? undefined;
    if ("roi" in body) settings.roi = body.roi;
    if ("retention" in body) settings.retention = body.retention;
    if ("embedding" in body) settings.embedding = body.embedding ?? undefined;
    if ("memoryExtraction" in body) settings.memoryExtraction = body.memoryExtraction ?? undefined;
    if (body.cache) settings.cache = body.cache;
    if (body.reports) settings.reports = { ...body.reports, lastSentAt: settings.reports?.lastSentAt };
    if (body.notifications) {
      const { slackWebhookUrl, emailApprovers } = body.notifications;
      const current = settings.notifications ?? {};
      settings.notifications = {
        emailApprovers,
        slackWebhookEnc:
          slackWebhookUrl === null
            ? undefined
            : slackWebhookUrl
              ? secrets.encrypt(slackWebhookUrl)
              : current.slackWebhookEnc,
      };
    }
    await db.update(workspaces).set({ settings }).where(eq(workspaces.id, ws.id));
    return { settings };
  });

  app.put<{ Params: { id: string } }>(
    "/flows/:id/settings",
    { preHandler: auth.requireWorkspace("admin") },
    async (req) => {
      const body = FlowSettingsBody.parse(req.body);
      const ws = currentWorkspace(req);
      const [flow] = await db
        .select({ settings: flows.settings })
        .from(flows)
        .where(and(eq(flows.id, req.params.id), eq(flows.workspaceId, ws.id)));
      if (!flow) throw new HttpError(404, "Flow not found");
      const settings = { ...flow.settings, ...body };
      await db
        .update(flows)
        .set({ settings })
        .where(and(eq(flows.id, req.params.id), eq(flows.workspaceId, ws.id)));
      return { publishGate: settings.publishGate ?? null, requireReview: Boolean(settings.requireReview) };
    },
  );
}
