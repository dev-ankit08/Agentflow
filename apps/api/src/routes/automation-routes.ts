import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { and, asc, eq, gte, inArray, sql } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { feedback, flowComments, flowVersions, flows, newId, runs } from "@agentflow/db";
import { Flow, nextCronRun, parseCron } from "@agentflow/flow-schema";
import { HttpError, currentUser, currentWorkspace } from "../auth";
import type { Deps } from "../app";
import { automationOf, type FlowAutomation } from "../automation";
import { makeLive } from "./publish";

const AbTestBody = z.object({ versionId: z.string().min(1), percent: z.number().int().min(1).max(90) });
const CommentBody = z.object({ nodeId: z.string().min(1).max(100), body: z.string().trim().min(1).max(2000) });

/** Who has each flow open in the builder, refreshed by a heartbeat (in memory for the prototype). */
const presence = new Map<string, Map<string, { name: string; at: number; nodeId?: string }>>();
const PRESENCE_TTL = 30_000;

/** Triggers (H8), A/B tests between versions, and collaboration (H10): presence and node comments. */
export async function automationRoutes(app: FastifyInstance, { db, auth, secrets, config }: Deps) {
  const findFlow = async (workspaceId: string, id: string) => {
    const [flow] = await db
      .select()
      .from(flows)
      .where(and(eq(flows.id, id), eq(flows.workspaceId, workspaceId)));
    if (!flow) throw new HttpError(404, "Flow not found");
    return flow;
  };
  const saveAutomation = (flow: typeof flows.$inferSelect, patch: Partial<FlowAutomation>) =>
    db
      .update(flows)
      .set({ settings: { ...flow.settings, ...patch } })
      .where(eq(flows.id, flow.id));

  // --- Triggers ------------------------------------------------------------------------------

  app.get<{ Params: { id: string } }>(
    "/flows/:id/triggers",
    { preHandler: auth.requireWorkspace("viewer") },
    async (req) => {
      const flow = await findFlow(currentWorkspace(req).id, req.params.id);
      const { webhook, scheduleState } = automationOf(flow.settings);
      let schedule: { cron: string; live: boolean; nextRun: string | null; lastRunAt: string | null } | null = null;
      const live = flow.liveVersionId
        ? (
            await db
              .select({ json: flowVersions.json })
              .from(flowVersions)
              .where(eq(flowVersions.id, flow.liveVersionId))
          )[0]
        : undefined;
      const liveCron = live?.json.triggers?.find((t) => t.type === "schedule")?.config?.cron;
      if (typeof liveCron === "string") {
        let nextRun: string | null = null;
        try {
          nextRun = nextCronRun(parseCron(liveCron), new Date())?.toISOString() ?? null;
        } catch {
          /* invalid schedules never publish */
        }
        schedule = { cron: liveCron, live: true, nextRun, lastRunAt: scheduleState?.lastRunAt ?? null };
      }
      return {
        webhook: webhook
          ? { url: `${config.publicApiUrl}/v1/hooks/${webhook.key}`, signed: Boolean(webhook.secretEnc) }
          : null,
        schedule,
      };
    },
  );

  /** Creates (or rotates) the flow's webhook address. With `signed`, a signing secret is returned once. */
  app.post<{ Params: { id: string } }>(
    "/flows/:id/webhook",
    { preHandler: auth.requireWorkspace("admin") },
    async (req) => {
      const { signed } = z.object({ signed: z.boolean().default(true) }).parse(req.body ?? {});
      const flow = await findFlow(currentWorkspace(req).id, req.params.id);
      const key = newId("hk");
      const secret = signed ? randomBytes(32).toString("base64url") : null;
      await saveAutomation(flow, { webhook: { key, ...(secret && { secretEnc: secrets.encrypt(secret) }) } });
      return { url: `${config.publicApiUrl}/v1/hooks/${key}`, secret };
    },
  );

  app.delete<{ Params: { id: string } }>(
    "/flows/:id/webhook",
    { preHandler: auth.requireWorkspace("admin") },
    async (req, reply) => {
      const flow = await findFlow(currentWorkspace(req).id, req.params.id);
      await saveAutomation(flow, { webhook: undefined });
      return reply.code(204).send();
    },
  );

  // --- A/B tests -----------------------------------------------------------------------------

  app.get<{ Params: { id: string } }>(
    "/flows/:id/ab-test",
    { preHandler: auth.requireWorkspace("viewer") },
    async (req) => {
      const flow = await findFlow(currentWorkspace(req).id, req.params.id);
      const ab = automationOf(flow.settings).abTest;
      if (!ab || !flow.liveVersionId) return { abTest: null, stats: [] };
      const ids = [flow.liveVersionId, ab.versionId];
      const outcome = sql<string | null>`${runs.state}->>'outcome'`;
      const stats = await db
        .select({
          versionId: runs.flowVersionId,
          version: flowVersions.version,
          conversations: sql<number>`count(*)::int`,
          resolved: sql<number>`count(*) filter (where ${outcome} in ('resolved','converted'))::int`,
          escalated: sql<number>`count(*) filter (where ${outcome} = 'escalated' or ${runs.status} = 'handed_off')::int`,
          failed: sql<number>`count(*) filter (where ${outcome} = 'failed' or ${runs.status} = 'failed')::int`,
          avgCostUsd: sql<number>`coalesce(avg(${runs.costUsd}), 0)::float`,
          thumbsUp: sql<number>`count(${feedback.rating}) filter (where ${feedback.rating} = 5)::int`,
          rated: sql<number>`count(${feedback.rating})::int`,
        })
        .from(runs)
        .innerJoin(flowVersions, eq(flowVersions.id, runs.flowVersionId))
        .leftJoin(feedback, eq(feedback.runId, runs.id))
        .where(
          and(eq(runs.flowId, flow.id), inArray(runs.flowVersionId, ids), gte(runs.startedAt, new Date(ab.startedAt))),
        )
        .groupBy(runs.flowVersionId, flowVersions.version);
      const versions = await db
        .select({ id: flowVersions.id, version: flowVersions.version })
        .from(flowVersions)
        .where(inArray(flowVersions.id, ids));
      return {
        abTest: ab,
        stats: ids.map((id) => {
          const row = stats.find((s) => s.versionId === id);
          return {
            versionId: id,
            version: versions.find((v) => v.id === id)?.version ?? null,
            role: id === ab.versionId ? "challenger" : "live",
            conversations: row?.conversations ?? 0,
            resolved: row?.resolved ?? 0,
            escalated: row?.escalated ?? 0,
            failed: row?.failed ?? 0,
            avgCostUsd: row?.avgCostUsd ?? 0,
            satisfaction: row?.rated ? row.thumbsUp / row.rated : null,
          };
        }),
      };
    },
  );

  app.put<{ Params: { id: string } }>(
    "/flows/:id/ab-test",
    { preHandler: auth.requireWorkspace("admin") },
    async (req) => {
      const body = AbTestBody.parse(req.body);
      const flow = await findFlow(currentWorkspace(req).id, req.params.id);
      if (!flow.liveVersionId) throw new HttpError(409, "Publish the flow before starting an A/B test");
      if (body.versionId === flow.liveVersionId) throw new HttpError(400, "Pick a version other than the live one");
      const [version] = await db
        .select({ id: flowVersions.id })
        .from(flowVersions)
        .where(and(eq(flowVersions.id, body.versionId), eq(flowVersions.flowId, flow.id)));
      if (!version) throw new HttpError(404, "Version not found");
      const abTest = { ...body, startedAt: new Date().toISOString() };
      await saveAutomation(flow, { abTest });
      return { abTest };
    },
  );

  app.delete<{ Params: { id: string } }>(
    "/flows/:id/ab-test",
    { preHandler: auth.requireWorkspace("admin") },
    async (req, reply) => {
      const flow = await findFlow(currentWorkspace(req).id, req.params.id);
      await saveAutomation(flow, { abTest: undefined });
      return reply.code(204).send();
    },
  );

  /** Makes the challenger the live version and ends the test. */
  app.post<{ Params: { id: string } }>(
    "/flows/:id/ab-test/promote",
    { preHandler: auth.requireWorkspace("admin") },
    async (req) => {
      const flow = await findFlow(currentWorkspace(req).id, req.params.id);
      const ab = automationOf(flow.settings).abTest;
      if (!ab) throw new HttpError(409, "No A/B test is running");
      await db.transaction(async (tx) => {
        await makeLive(tx, flow.id, ab.versionId);
        await tx
          .update(flows)
          .set({ settings: { ...flow.settings, abTest: undefined } })
          .where(eq(flows.id, flow.id));
      });
      return { liveVersionId: ab.versionId };
    },
  );

  // --- Collaboration -------------------------------------------------------------------------

  /** Heartbeat from an open editor; returns the other people editing this flow right now. */
  app.post<{ Params: { id: string } }>(
    "/flows/:id/presence",
    { preHandler: auth.requireWorkspace("viewer") },
    async (req) => {
      const { nodeId } = z.object({ nodeId: z.string().max(100).optional() }).parse(req.body ?? {});
      const flow = await findFlow(currentWorkspace(req).id, req.params.id);
      const user = currentUser(req);
      const now = Date.now();
      const here = presence.get(flow.id) ?? new Map();
      presence.set(flow.id, here);
      here.set(user.id, { name: user.name ?? user.email ?? "Someone", at: now, nodeId });
      for (const [id, p] of here) if (now - p.at > PRESENCE_TTL) here.delete(id);
      return {
        others: [...here.entries()]
          .filter(([id]) => id !== user.id)
          .map(([id, p]) => ({ userId: id, name: p.name, nodeId: p.nodeId ?? null })),
        updatedAt: flow.updatedAt,
      };
    },
  );

  app.get<{ Params: { id: string } }>(
    "/flows/:id/comments",
    { preHandler: auth.requireWorkspace("viewer") },
    async (req) => {
      const flow = await findFlow(currentWorkspace(req).id, req.params.id);
      const comments = await db
        .select()
        .from(flowComments)
        .where(eq(flowComments.flowId, flow.id))
        .orderBy(asc(flowComments.createdAt));
      return { comments };
    },
  );

  app.post<{ Params: { id: string } }>(
    "/flows/:id/comments",
    { preHandler: auth.requireWorkspace("reviewer") },
    async (req, reply) => {
      const body = CommentBody.parse(req.body);
      const flow = await findFlow(currentWorkspace(req).id, req.params.id);
      const user = currentUser(req);
      const [comment] = await db
        .insert(flowComments)
        .values({
          flowId: flow.id,
          nodeId: body.nodeId,
          body: body.body,
          authorId: user.id,
          authorName: user.name ?? user.email ?? "Someone",
        })
        .returning();
      return reply.code(201).send(comment);
    },
  );

  app.patch<{ Params: { id: string; commentId: string } }>(
    "/flows/:id/comments/:commentId",
    { preHandler: auth.requireWorkspace("reviewer") },
    async (req) => {
      const { resolved } = z.object({ resolved: z.boolean() }).parse(req.body);
      const flow = await findFlow(currentWorkspace(req).id, req.params.id);
      const [comment] = await db
        .update(flowComments)
        .set({ resolvedAt: resolved ? new Date() : null })
        .where(and(eq(flowComments.id, req.params.commentId), eq(flowComments.flowId, flow.id)))
        .returning();
      if (!comment) throw new HttpError(404, "Comment not found");
      return comment;
    },
  );

  app.delete<{ Params: { id: string; commentId: string } }>(
    "/flows/:id/comments/:commentId",
    { preHandler: auth.requireWorkspace("reviewer") },
    async (req, reply) => {
      const flow = await findFlow(currentWorkspace(req).id, req.params.id);
      const user = currentUser(req);
      const ws = currentWorkspace(req);
      const [comment] = await db
        .select()
        .from(flowComments)
        .where(and(eq(flowComments.id, req.params.commentId), eq(flowComments.flowId, flow.id)));
      if (!comment) throw new HttpError(404, "Comment not found");
      if (comment.authorId !== user.id && ws.role !== "admin" && ws.role !== "owner")
        throw new HttpError(403, "Only the author or an admin can delete this comment");
      await db.delete(flowComments).where(eq(flowComments.id, comment.id));
      return reply.code(204).send();
    },
  );
}

/**
 * Public webhook trigger: POST /v1/hooks/:key starts the flow's live version with the JSON body as `trigger`.
 * Signed hooks need `x-agentflow-signature: sha256=<hex HMAC of the raw body>`.
 * `?wait=true` waits for the run and returns its result; otherwise it answers 202 straight away.
 */
export async function hookRoutes(app: FastifyInstance, { db, executor, secrets }: Deps) {
  app.addContentTypeParser("application/json", { parseAs: "string", bodyLimit: 256 * 1024 }, (_req, body, done) =>
    done(null, body),
  );

  app.post<{ Params: { key: string }; Querystring: { wait?: string } }>("/hooks/:key", async (req, reply) => {
    const [flow] = await db
      .select()
      .from(flows)
      .where(sql`${flows.settings}->'webhook'->>'key' = ${req.params.key}`);
    const webhook = flow && automationOf(flow.settings).webhook;
    if (!flow || !webhook) throw new HttpError(404, "Unknown webhook");
    const raw = typeof req.body === "string" ? req.body : "";
    if (webhook.secretEnc) {
      const expected = Buffer.from(
        `sha256=${createHmac("sha256", secrets.decrypt(webhook.secretEnc)).update(raw).digest("hex")}`,
      );
      const given = Buffer.from(String(req.headers["x-agentflow-signature"] ?? ""));
      if (expected.length !== given.length || !timingSafeEqual(expected, given))
        throw new HttpError(401, "Invalid signature");
    }
    let input: Record<string, unknown> = {};
    if (raw.trim()) {
      try {
        const parsed = JSON.parse(raw);
        input = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : { data: parsed };
      } catch {
        throw new HttpError(400, "Body must be JSON");
      }
    }
    if (!flow.liveVersionId) throw new HttpError(409, "This flow is not published");
    const [version] = await db.select().from(flowVersions).where(eq(flowVersions.id, flow.liveVersionId));
    const start = {
      workspaceId: flow.workspaceId,
      flowId: flow.id,
      flowVersionId: version!.id,
      flow: Flow.parse(version!.json),
      triggerType: "webhook" as const,
      input,
    };
    if (req.query.wait === "true") {
      let result: { outcome?: string; output?: unknown; error?: string } = {};
      const runId = await executor.start(start, (e) => {
        if (e.type === "done") result = { outcome: e.outcome, output: e.output };
        if (e.type === "error") result = { error: e.message };
      });
      return { runId, ...result };
    }
    // Answer first; the run continues in the background.
    let resolveId!: (id: string) => void;
    const idPromise = new Promise<string>((r) => (resolveId = r));
    void executor
      .start(start, (e) => {
        if (e.type === "run_started") resolveId(e.runId);
      })
      .catch((err) => req.log.error({ err }, "webhook run failed"));
    const runId = await Promise.race([idPromise, new Promise<string>((r) => setTimeout(() => r(""), 5000))]);
    return reply.code(202).send({ runId: runId || null });
  });
}
