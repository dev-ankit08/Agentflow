import { and, asc, desc, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { flows, runSteps, runs } from "@agentflow/db";
import { validateFlow } from "@agentflow/flow-schema";
import { HttpError, currentWorkspace } from "../auth";
import type { Deps } from "../app";
import { streamRun } from "../sse";

const TestRun = z.object({
  message: z.string().trim().min(1).max(8000),
  /** Simulated signed-in end user for `{{user.*}}`. */
  user: z.record(z.string(), z.unknown()).default({}),
});
const Message = z.object({ message: z.string().trim().min(1).max(8000) });

export async function runRoutes(app: FastifyInstance, { db, auth, executor, store }: Deps) {
  /** Test console: runs the current draft and streams its events. */
  app.post<{ Params: { id: string } }>(
    "/flows/:id/test-runs",
    { preHandler: auth.requireWorkspace("builder") },
    async (req, reply) => {
      const body = TestRun.parse(req.body);
      const ws = currentWorkspace(req);
      const [flow] = await db
        .select()
        .from(flows)
        .where(and(eq(flows.id, req.params.id), eq(flows.workspaceId, ws.id)));
      if (!flow) throw new HttpError(404, "Flow not found");
      const validation = validateFlow(flow.draftJson);
      if (!validation.ok) {
        return reply.code(422).send({ error: "Fix the flow's errors before testing", issues: validation.errors });
      }
      await streamRun(reply, (emit) =>
        executor.start(
          {
            workspaceId: ws.id,
            flowId: flow.id,
            flowVersionId: null,
            flow: validation.flow,
            triggerType: "chat",
            input: { message: body.message },
            user: body.user,
          },
          emit,
        ),
      );
    },
  );

  app.post<{ Params: { id: string } }>(
    "/runs/:id/messages",
    { preHandler: auth.requireWorkspace("builder") },
    async (req, reply) => {
      const { message } = Message.parse(req.body);
      const run = await store.load(req.params.id);
      if (!run || run.workspaceId !== currentWorkspace(req).id) throw new HttpError(404, "Run not found");
      if (run.status !== "waiting_input") throw new HttpError(409, `Run is ${run.status}`);
      await streamRun(reply, (emit) => executor.sendMessage(run.id, message, emit));
    },
  );

  app.get<{ Querystring: { flowId?: string; limit?: string } }>(
    "/runs",
    { preHandler: auth.requireWorkspace("viewer") },
    async (req) => {
      const ws = currentWorkspace(req);
      const limit = Math.min(Number(req.query.limit ?? 50) || 50, 200);
      const rows = await db
        .select({
          id: runs.id,
          flowId: runs.flowId,
          flowName: flows.name,
          flowVersionId: runs.flowVersionId,
          triggerType: runs.triggerType,
          status: runs.status,
          costUsd: runs.costUsd,
          startedAt: runs.startedAt,
          endedAt: runs.endedAt,
          state: runs.state,
        })
        .from(runs)
        .innerJoin(flows, eq(flows.id, runs.flowId))
        .where(and(eq(runs.workspaceId, ws.id), req.query.flowId ? eq(runs.flowId, req.query.flowId) : undefined))
        .orderBy(desc(runs.startedAt))
        .limit(limit);
      return {
        runs: rows.map(({ state, ...r }) => {
          const s = state as { outcome?: string; conversation?: { role: string; content: string }[] };
          return {
            ...r,
            outcome: s.outcome ?? null,
            firstMessage: s.conversation?.find((t) => t.role === "user")?.content ?? null,
            turns: s.conversation?.filter((t) => t.role === "user").length ?? 0,
          };
        }),
      };
    },
  );

  /** Run detail with its full step trace. */
  app.get<{ Params: { id: string } }>("/runs/:id", { preHandler: auth.requireWorkspace("viewer") }, async (req) => {
    const ws = currentWorkspace(req);
    const [row] = await db
      .select({ run: runs, flowName: flows.name })
      .from(runs)
      .innerJoin(flows, eq(flows.id, runs.flowId))
      .where(and(eq(runs.id, req.params.id), eq(runs.workspaceId, ws.id)));
    if (!row) throw new HttpError(404, "Run not found");
    const steps = await db
      .select()
      .from(runSteps)
      .where(eq(runSteps.runId, row.run.id))
      .orderBy(asc(runSteps.stepIndex));
    const { flow, ...state } = row.run.state as Record<string, unknown> & { flow?: unknown };
    return { ...row.run, state, flow, flowName: row.flowName, steps };
  });
}
