import { randomBytes } from "node:crypto";
import { and, desc, eq, max } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { evalRuns, flowVersions, flows, reviews, users, type Db } from "@agentflow/db";
import { validateFlow } from "@agentflow/flow-schema";
import { HttpError, currentUser, currentWorkspace } from "../auth";
import type { Deps } from "../app";
import { hashDraft } from "../workspace-services";

export type WidgetSettings = {
  title: string;
  welcome: string;
  color: string;
  allowedOrigins: string[];
  quickReplies: string[];
  identitySecretEnc?: string;
};

export const defaultWidget: WidgetSettings = {
  title: "Assistant",
  welcome: "Hi! How can I help?",
  color: "#5b5bd6",
  allowedOrigins: [],
  quickReplies: [],
};

export const widgetSettingsOf = (settings: Record<string, unknown>): WidgetSettings => ({
  ...defaultWidget,
  ...((settings.widget as Partial<WidgetSettings>) ?? {}),
});

const UpdateWidget = z.object({
  title: z.string().trim().min(1).max(60),
  welcome: z.string().trim().max(300),
  color: z.string().regex(/^#[0-9a-fA-F]{6}$/),
  allowedOrigins: z
    .array(
      z
        .string()
        .trim()
        .regex(/^https?:\/\/[^/\s]+$/, "Use origins like https://example.com"),
    )
    .max(20),
  quickReplies: z.array(z.string().trim().min(1).max(60)).max(6),
});

type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];

/** Makes a version the live one (the previous live version is archived). */
export async function makeLive(tx: Tx, flowId: string, versionId: string) {
  await tx
    .update(flowVersions)
    .set({ status: "archived" })
    .where(and(eq(flowVersions.flowId, flowId), eq(flowVersions.status, "live")));
  await tx.update(flowVersions).set({ status: "live" }).where(eq(flowVersions.id, versionId));
  await tx.update(flows).set({ liveVersionId: versionId }).where(eq(flows.id, flowId));
}

/** Draft → (review) → Live publishing with immutable versions, rollback and widget (deploy) settings. */
export async function publishRoutes(app: FastifyInstance, { db, auth, secrets }: Deps) {
  const findFlow = async (workspaceId: string, id: string) => {
    const [flow] = await db
      .select()
      .from(flows)
      .where(and(eq(flows.id, id), eq(flows.workspaceId, workspaceId)));
    if (!flow) throw new HttpError(404, "Flow not found");
    return flow;
  };

  app.post<{ Params: { id: string } }>(
    "/flows/:id/publish",
    { preHandler: auth.requireWorkspace("builder") },
    async (req, reply) => {
      const ws = currentWorkspace(req);
      const flow = await findFlow(ws.id, req.params.id);
      const validation = validateFlow(flow.draftJson);
      if (!validation.ok) {
        return reply.code(422).send({ error: "Fix the flow's errors before publishing", issues: validation.errors });
      }
      const settings = flow.settings as {
        publishGate?: { enabled: boolean; minPassRate: number };
        requireReview?: boolean;
      };

      // Publish gate (H2): the current draft must have passed its latest eval run.
      if (settings.publishGate?.enabled) {
        const [latest] = await db
          .select()
          .from(evalRuns)
          .where(and(eq(evalRuns.flowId, flow.id), eq(evalRuns.status, "completed")))
          .orderBy(desc(evalRuns.createdAt))
          .limit(1);
        if (!latest || latest.draftHash !== hashDraft(flow.draftJson)) {
          throw new HttpError(422, "Run the evals on the current draft before publishing (publish gate is on)");
        }
        if ((latest.passRate ?? 0) < settings.publishGate.minPassRate) {
          throw new HttpError(
            422,
            `Evals passed ${Math.round((latest.passRate ?? 0) * 100)}%, below the required ${Math.round(settings.publishGate.minPassRate * 100)}%`,
          );
        }
      }

      const status = settings.requireReview ? "staging" : "live";
      const user = currentUser(req);
      const version = await db.transaction(async (tx) => {
        const [{ latest } = { latest: 0 }] = await tx
          .select({ latest: max(flowVersions.version) })
          .from(flowVersions)
          .where(eq(flowVersions.flowId, flow.id));
        const [created] = await tx
          .insert(flowVersions)
          .values({ flowId: flow.id, version: (latest ?? 0) + 1, json: validation.flow, status, createdBy: user.id })
          .returning({ id: flowVersions.id, version: flowVersions.version });
        if (status === "live") {
          await makeLive(tx, flow.id, created!.id);
          return { ...created!, status };
        }
        // Review before live (H10): the version waits in staging for a reviewer.
        const [review] = await tx
          .insert(reviews)
          .values({ flowVersionId: created!.id, requestedBy: user.id })
          .returning({ id: reviews.id });
        return { ...created!, status, reviewId: review!.id };
      });
      return reply.code(201).send(version);
    },
  );

  app.get<{ Params: { id: string; versionId: string } }>(
    "/flows/:id/versions/:versionId",
    { preHandler: auth.requireWorkspace("viewer") },
    async (req) => {
      const flow = await findFlow(currentWorkspace(req).id, req.params.id);
      const [version] = await db
        .select()
        .from(flowVersions)
        .where(and(eq(flowVersions.id, req.params.versionId), eq(flowVersions.flowId, flow.id)));
      if (!version) throw new HttpError(404, "Version not found");
      return version;
    },
  );

  app.get<{ Params: { id: string } }>(
    "/flows/:id/reviews",
    { preHandler: auth.requireWorkspace("viewer") },
    async (req) => {
      const flow = await findFlow(currentWorkspace(req).id, req.params.id);
      const rows = await db
        .select({
          id: reviews.id,
          status: reviews.status,
          note: reviews.note,
          createdAt: reviews.createdAt,
          versionId: flowVersions.id,
          version: flowVersions.version,
          requestedBy: users.email,
        })
        .from(reviews)
        .innerJoin(flowVersions, eq(flowVersions.id, reviews.flowVersionId))
        .leftJoin(users, eq(users.id, reviews.requestedBy))
        .where(eq(flowVersions.flowId, flow.id))
        .orderBy(desc(reviews.createdAt));
      return { reviews: rows };
    },
  );

  /** A reviewer (not the requester, unless an owner) approves a staging version to make it live, or rejects it. */
  app.post<{ Params: { id: string } }>(
    "/reviews/:id/decide",
    { preHandler: auth.requireWorkspace("reviewer") },
    async (req) => {
      const body = z
        .object({ decision: z.enum(["approve", "reject"]), note: z.string().trim().max(1000).optional() })
        .parse(req.body);
      const ws = currentWorkspace(req);
      const user = currentUser(req);
      const [row] = await db
        .select({ review: reviews, flowId: flows.id })
        .from(reviews)
        .innerJoin(flowVersions, eq(flowVersions.id, reviews.flowVersionId))
        .innerJoin(flows, eq(flows.id, flowVersions.flowId))
        .where(and(eq(reviews.id, req.params.id), eq(flows.workspaceId, ws.id)));
      if (!row) throw new HttpError(404, "Review not found");
      if (row.review.status !== "pending") throw new HttpError(409, "This review was already decided");
      if (row.review.requestedBy === user.id && ws.role !== "owner")
        throw new HttpError(403, "Someone else must review your changes");
      await db.transaction(async (tx) => {
        await tx
          .update(reviews)
          .set({
            status: body.decision === "approve" ? "approved" : "rejected",
            reviewerId: user.id,
            note: body.note,
            decidedAt: new Date(),
          })
          .where(eq(reviews.id, row.review.id));
        if (body.decision === "approve") await makeLive(tx, row.flowId, row.review.flowVersionId);
        else
          await tx
            .update(flowVersions)
            .set({ status: "archived" })
            .where(eq(flowVersions.id, row.review.flowVersionId));
      });
      return { id: row.review.id, decision: body.decision };
    },
  );

  app.get<{ Params: { id: string } }>(
    "/flows/:id/versions",
    { preHandler: auth.requireWorkspace("viewer") },
    async (req) => {
      const flow = await findFlow(currentWorkspace(req).id, req.params.id);
      const versions = await db
        .select({
          id: flowVersions.id,
          version: flowVersions.version,
          status: flowVersions.status,
          createdAt: flowVersions.createdAt,
        })
        .from(flowVersions)
        .where(eq(flowVersions.flowId, flow.id))
        .orderBy(desc(flowVersions.version));
      return { versions, liveVersionId: flow.liveVersionId };
    },
  );

  /** Makes an earlier version live again, and restores it as the draft. */
  app.post<{ Params: { id: string; versionId: string } }>(
    "/flows/:id/versions/:versionId/rollback",
    { preHandler: auth.requireWorkspace("builder") },
    async (req) => {
      const flow = await findFlow(currentWorkspace(req).id, req.params.id);
      const [target] = await db
        .select()
        .from(flowVersions)
        .where(and(eq(flowVersions.id, req.params.versionId), eq(flowVersions.flowId, flow.id)));
      if (!target) throw new HttpError(404, "Version not found");
      await db.transaction(async (tx) => {
        await tx
          .update(flowVersions)
          .set({ status: "archived" })
          .where(and(eq(flowVersions.flowId, flow.id), eq(flowVersions.status, "live")));
        await tx.update(flowVersions).set({ status: "live" }).where(eq(flowVersions.id, target.id));
        await tx
          .update(flows)
          .set({ liveVersionId: target.id, draftJson: target.json, updatedAt: new Date() })
          .where(eq(flows.id, flow.id));
      });
      return { liveVersionId: target.id, version: target.version };
    },
  );

  app.get<{ Params: { id: string } }>(
    "/flows/:id/widget",
    { preHandler: auth.requireWorkspace("viewer") },
    async (req) => {
      const flow = await findFlow(currentWorkspace(req).id, req.params.id);
      const { identitySecretEnc, ...widget } = widgetSettingsOf(flow.settings);
      return {
        widgetKey: flow.widgetKey,
        liveVersionId: flow.liveVersionId,
        widget,
        hasIdentitySecret: Boolean(identitySecretEnc),
      };
    },
  );

  app.put<{ Params: { id: string } }>(
    "/flows/:id/widget",
    { preHandler: auth.requireWorkspace("builder") },
    async (req) => {
      const body = UpdateWidget.parse(req.body);
      const ws = currentWorkspace(req);
      const flow = await findFlow(ws.id, req.params.id);
      const current = widgetSettingsOf(flow.settings);
      const widget = { ...current, ...body };
      await db
        .update(flows)
        .set({ settings: { ...flow.settings, widget } })
        .where(and(eq(flows.id, flow.id), eq(flows.workspaceId, ws.id)));
      const { identitySecretEnc, ...rest } = widget;
      return { widget: rest, hasIdentitySecret: Boolean(identitySecretEnc) };
    },
  );

  /** Creates (or rotates) the secret the host website uses to sign end-user identity tokens. Shown once. */
  app.post<{ Params: { id: string } }>(
    "/flows/:id/widget/identity-secret",
    { preHandler: auth.requireWorkspace("admin") },
    async (req) => {
      const ws = currentWorkspace(req);
      const flow = await findFlow(ws.id, req.params.id);
      const secret = randomBytes(32).toString("base64url");
      const widget = { ...widgetSettingsOf(flow.settings), identitySecretEnc: secrets.encrypt(secret) };
      await db
        .update(flows)
        .set({ settings: { ...flow.settings, widget } })
        .where(and(eq(flows.id, flow.id), eq(flows.workspaceId, ws.id)));
      return { secret };
    },
  );
}
