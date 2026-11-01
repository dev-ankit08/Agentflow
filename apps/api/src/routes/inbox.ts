import { and, desc, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { approvals, flows, handoffs, runs, type Role } from "@agentflow/db";
import { decideApproval } from "../approvals";
import { HttpError, currentUser, currentWorkspace, hasRole } from "../auth";
import type { Deps } from "../app";
import { sweepExpiredApprovals } from "../workspace-services";

const Decide = z.object({ decision: z.enum(["approve", "reject"]), note: z.string().trim().max(1000).optional() });

/** Human-in-the-loop inbox (H5): approvals that pause runs, and conversations handed to people. */
export async function inboxRoutes(app: FastifyInstance, { db, auth, executor, channels }: Deps) {
  app.get("/inbox", { preHandler: auth.requireWorkspace("viewer") }, async (req) => {
    const ws = currentWorkspace(req);
    await sweepExpiredApprovals(db, executor);
    const pending = await db
      .select({
        id: approvals.id,
        runId: approvals.runId,
        message: approvals.message,
        approverRole: approvals.approverRole,
        expiresAt: approvals.expiresAt,
        createdAt: approvals.createdAt,
        flowName: flows.name,
        state: runs.state,
      })
      .from(approvals)
      .innerJoin(runs, eq(runs.id, approvals.runId))
      .innerJoin(flows, eq(flows.id, runs.flowId))
      .where(and(eq(approvals.workspaceId, ws.id), eq(approvals.status, "pending")))
      .orderBy(desc(approvals.createdAt));
    const open = await db
      .select({
        id: handoffs.id,
        runId: handoffs.runId,
        queue: handoffs.queue,
        summary: handoffs.summary,
        createdAt: handoffs.createdAt,
        flowName: flows.name,
      })
      .from(handoffs)
      .innerJoin(runs, eq(runs.id, handoffs.runId))
      .innerJoin(flows, eq(flows.id, runs.flowId))
      .where(and(eq(handoffs.workspaceId, ws.id), eq(handoffs.status, "open")))
      .orderBy(desc(handoffs.createdAt));
    return {
      approvals: pending.map(({ state, ...a }) => ({
        ...a,
        canDecide: hasRole(ws.role, a.approverRole as Role),
        conversation: ((state as { conversation?: unknown[] }).conversation ?? []).slice(-6),
      })),
      handoffs: open,
    };
  });

  /** Records the decision and resumes the paused run on its approved/rejected path. */
  app.post<{ Params: { id: string } }>(
    "/approvals/:id/decide",
    { preHandler: auth.requireWorkspace("reviewer") },
    async (req) => {
      const body = Decide.parse(req.body);
      const ws = currentWorkspace(req);
      const user = currentUser(req);
      const [approval] = await db
        .select()
        .from(approvals)
        .where(and(eq(approvals.id, req.params.id), eq(approvals.workspaceId, ws.id)));
      if (!approval) throw new HttpError(404, "Approval not found");
      if (!hasRole(ws.role, approval.approverRole as Role))
        throw new HttpError(403, `Requires ${approval.approverRole} role or higher`);
      return decideApproval(
        { db, executor, channels },
        approval.id,
        body.decision,
        { userId: user.id, label: user.email ?? user.id },
        body.note,
      );
    },
  );

  app.post<{ Params: { id: string } }>(
    "/handoffs/:id/close",
    { preHandler: auth.requireWorkspace("builder") },
    async (req) => {
      const ws = currentWorkspace(req);
      const [row] = await db
        .update(handoffs)
        .set({ status: "closed", closedBy: currentUser(req).id, closedAt: new Date() })
        .where(and(eq(handoffs.id, req.params.id), eq(handoffs.workspaceId, ws.id)))
        .returning({ id: handoffs.id });
      if (!row) throw new HttpError(404, "Handoff not found");
      return { id: row.id, status: "closed" };
    },
  );
}
