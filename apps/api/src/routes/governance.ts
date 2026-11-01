import { and, desc, eq, gte, isNotNull, lt, sql } from "drizzle-orm";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { auditEvents, feedback, memories, runs, type Db } from "@agentflow/db";
import { currentWorkspace } from "../auth";
import type { Deps } from "../app";
import { audit } from "../automation";
import { csvCell } from "../csv";

/** Readable names for audited routes. Routes not listed here (drafts, test runs, searches, comments) are not audited. */
const AUDITED: Record<string, string> = {
  "POST /v1/flows": "Created flow",
  "DELETE /v1/flows/:id": "Deleted flow",
  "POST /v1/flows/:id/publish": "Published flow",
  "POST /v1/flows/:id/versions/:versionId/rollback": "Rolled back flow",
  "PUT /v1/flows/:id/settings": "Changed publish rules",
  "PUT /v1/flows/:id/widget": "Changed widget settings",
  "POST /v1/flows/:id/widget/identity-secret": "Rotated identity secret",
  "POST /v1/flows/:id/webhook": "Created webhook trigger",
  "DELETE /v1/flows/:id/webhook": "Removed webhook trigger",
  "PATCH /v1/flows/:id/webhook": "Changed webhook batch mode",
  "POST /v1/flows/:id/email-hook": "Created inbound email address",
  "DELETE /v1/flows/:id/email-hook": "Removed inbound email address",
  "PUT /v1/flows/:id/ab-test": "Started A/B test",
  "DELETE /v1/flows/:id/ab-test": "Stopped A/B test",
  "POST /v1/flows/:id/ab-test/promote": "Promoted A/B challenger",
  "POST /v1/reviews/:id/decide": "Decided review",
  "POST /v1/approvals/:id/decide": "Decided approval",
  "POST /v1/provider-keys": "Added model key",
  "DELETE /v1/provider-keys/:id": "Removed model key",
  "POST /v1/connectors": "Added connector",
  "DELETE /v1/connectors/:id": "Removed connector",
  "POST /v1/channels": "Connected channel",
  "DELETE /v1/channels/:id": "Disconnected channel",
  "POST /v1/knowledge": "Added knowledge source",
  "DELETE /v1/knowledge/:id": "Removed knowledge source",
  "POST /v1/invites": "Invited member",
  "DELETE /v1/invites/:id": "Revoked invite",
  "PATCH /v1/members/:userId": "Changed member role",
  "DELETE /v1/members/:userId": "Removed member",
  "PUT /v1/workspace/settings": "Changed workspace settings",
  "POST /v1/templates/:slug/install": "Installed template",
  "DELETE /v1/end-users/:id": "Deleted end-user data",
};

/** Records every successful configuration change once the response is sent. Bodies are never stored. */
export function auditHook(db: Db) {
  return async (req: FastifyRequest, reply: FastifyReply) => {
    if (!req.workspace || reply.statusCode >= 400) return;
    const action = AUDITED[`${req.method} ${req.routeOptions.url}`];
    if (!action) return;
    const params = (req.params ?? {}) as Record<string, string>;
    const targetType = (req.routeOptions.url ?? "").split("/")[2] ?? "workspace";
    await audit(
      db,
      req,
      action,
      { type: targetType, id: params.id ?? params.userId ?? params.slug ?? null },
      { params },
    ).catch((err) => req.log.error({ err }, "audit write failed"));
  };
}

/** Audit log (H6), end-user data deletion (H7) and conversation insights (H9). */
export async function governanceRoutes(app: FastifyInstance, { db, auth }: Deps) {
  app.get<{ Querystring: { format?: string; limit?: string; before?: string } }>(
    "/audit",
    { preHandler: auth.requireWorkspace("admin") },
    async (req, reply) => {
      const ws = currentWorkspace(req);
      const csv = req.query.format === "csv";
      const limit = Math.min(Number(req.query.limit) || (csv ? 10_000 : 100), 10_000);
      const rows = await db
        .select()
        .from(auditEvents)
        .where(
          and(
            eq(auditEvents.workspaceId, ws.id),
            req.query.before ? lt(auditEvents.createdAt, new Date(req.query.before)) : undefined,
          ),
        )
        .orderBy(desc(auditEvents.createdAt))
        .limit(limit);
      if (!csv) return { events: rows };
      const header = ["time", "actor", "action", "target_type", "target_id", "detail"];
      const lines = rows.map((r) =>
        [r.createdAt, r.actorEmail ?? r.actorId, r.action, r.targetType, r.targetId, r.detail].map(csvCell).join(","),
      );
      return reply
        .header("content-type", "text/csv; charset=utf-8")
        .header("content-disposition", `attachment; filename="audit-${ws.id}.csv"`)
        .send([header.join(","), ...lines].join("\n"));
    },
  );

  /** What is stored about one end user (the `sub` of their identity token). */
  app.get<{ Params: { id: string } }>("/end-users/:id", { preHandler: auth.requireWorkspace("admin") }, async (req) => {
    const ws = currentWorkspace(req);
    const facts = await db
      .select({ id: memories.id, fact: memories.fact, createdAt: memories.createdAt })
      .from(memories)
      .where(and(eq(memories.workspaceId, ws.id), eq(memories.endUserId, req.params.id)))
      .orderBy(desc(memories.createdAt));
    const [count] = await db
      .select({ n: sql<number>`count(*)::int` })
      .from(runs)
      .where(and(eq(runs.workspaceId, ws.id), eq(runs.endUserId, req.params.id)));
    return { endUserId: req.params.id, memories: facts, conversations: count?.n ?? 0 };
  });

  /** Right to erasure: removes the end user's memories and conversations. */
  app.delete<{ Params: { id: string } }>(
    "/end-users/:id",
    { preHandler: auth.requireWorkspace("admin") },
    async (req) => {
      const ws = currentWorkspace(req);
      const facts = await db
        .delete(memories)
        .where(and(eq(memories.workspaceId, ws.id), eq(memories.endUserId, req.params.id)))
        .returning({ id: memories.id });
      const conversations = await db
        .delete(runs)
        .where(and(eq(runs.workspaceId, ws.id), eq(runs.endUserId, req.params.id)))
        .returning({ id: runs.id });
      return { memories: facts.length, conversations: conversations.length };
    },
  );

  /**
   * Conversation insights (H9): groups customers' opening questions by their main topic word and
   * flags topics that often end escalated, failed or with a thumbs-down.
   */
  app.get<{ Querystring: { days?: string; flowId?: string } }>(
    "/insights",
    { preHandler: auth.requireWorkspace("viewer") },
    async (req) => {
      const ws = currentWorkspace(req);
      const days = Math.min(Math.max(Number(req.query.days) || 30, 1), 365);
      const since = new Date(Date.now() - days * 86_400_000);
      const rows = await db
        .select({
          id: runs.id,
          message: sql<string | null>`${runs.state}->'conversation'->0->>'content'`,
          outcome: sql<string | null>`${runs.state}->>'outcome'`,
          status: runs.status,
          rating: feedback.rating,
        })
        .from(runs)
        .leftJoin(feedback, eq(feedback.runId, runs.id))
        .where(
          and(
            eq(runs.workspaceId, ws.id),
            isNotNull(runs.flowVersionId),
            eq(runs.sandbox, false),
            gte(runs.startedAt, since),
            req.query.flowId ? eq(runs.flowId, req.query.flowId) : undefined,
          ),
        )
        .limit(5000);
      return { days, ...clusterQuestions(rows) };
    },
  );
}

const STOP = new Set(
  "a an and are as at be but by can could do does for from get got had has have hello hey hi how i i'm im in is it its just me my need no not of on or please so than thanks that the their them then there this to too up us want was we what when where which who why will with would you your yes ok okay help hii can't cant don't dont".split(
    " ",
  ),
);

const stem = (w: string) => w.replace(/(ing|ed|es|s)$/, "") || w;

type InsightRow = { id: string; message: string | null; outcome: string | null; status: string; rating: number | null };

export function clusterQuestions(rows: InsightRow[]) {
  const withText = rows.filter((r) => r.message?.trim());
  const words = (text: string) => [
    ...new Set(
      text
        .toLowerCase()
        .replace(/[^a-z0-9\s']/g, " ")
        .split(/\s+/)
        .filter((w) => w.length > 2 && !STOP.has(w) && !/^\d+$/.test(w))
        .map(stem),
    ),
  ];
  const freq = new Map<string, number>();
  const tokens = withText.map((r) => {
    const ws = words(r.message!);
    for (const w of ws) freq.set(w, (freq.get(w) ?? 0) + 1);
    return ws;
  });
  // Each question joins the cluster of its most common topic word.
  const clusters = new Map<string, InsightRow[]>();
  withText.forEach((r, i) => {
    const key =
      [...tokens[i]!].sort((a, b) => (freq.get(b) ?? 0) - (freq.get(a) ?? 0) || a.localeCompare(b))[0] ?? "other";
    clusters.set(key, [...(clusters.get(key) ?? []), r]);
  });
  const result = [...clusters.entries()]
    .map(([topic, list]) => {
      const escalated = list.filter((r) => r.outcome === "escalated" || r.status === "handed_off").length;
      const failed = list.filter((r) => r.outcome === "failed" || r.status === "failed").length;
      const negative = list.filter((r) => r.rating === 1).length;
      const problemRate = (escalated + failed + negative) / list.length;
      const suggestion =
        problemRate < 0.3
          ? null
          : failed + negative > escalated
            ? `Customers asking about "${topic}" often get unhelpful answers: add a knowledge document or tighten the agent's prompt.`
            : `Questions about "${topic}" are often handed to people: consider a dedicated branch or tool for them.`;
      return {
        topic,
        count: list.length,
        escalated,
        failed,
        negative,
        problemRate: Math.round(problemRate * 100) / 100,
        examples: list.slice(0, 3).map((r) => ({ runId: r.id, message: r.message!.slice(0, 200) })),
        suggestion,
      };
    })
    .sort((a, b) => b.count - a.count || b.problemRate - a.problemRate)
    .slice(0, 20);
  return { total: withText.length, clusters: result };
}
