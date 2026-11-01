import { and, asc, desc, eq } from "drizzle-orm";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { evalCases, evalDatasets, evalResults, evalRuns, flows, runs, type EvalExpectation } from "@agentflow/db";
import { ModelRef, validateFlow, type Flow } from "@agentflow/flow-schema";
import type { LLMGateway } from "@agentflow/llm-gateway";
import type { RunEvent } from "@agentflow/runtime";
import { HttpError, currentUser, currentWorkspace } from "../auth";
import type { Deps } from "../app";
import { hashDraft } from "../workspace-services";

const Expected = z.object({
  contains: z.string().trim().max(500).optional(),
  outcome: z.string().trim().max(40).optional(),
  rubric: z.string().trim().max(2000).optional(),
});
const NewCase = z.object({ input: z.string().trim().min(1).max(4000), expected: Expected.default({}) });
const RunEvals = z.object({ judgeModel: ModelRef.optional() });

export type Score = { name: string; pass: boolean; score?: number; reason?: string };

/** Scores one reply against a case's expectations. Every expectation must pass. */
export async function scoreCase(
  expected: EvalExpectation,
  result: { reply: string; outcome: string | null; error: string | null; input: string },
  judge?: { gateway: LLMGateway; model: ModelRef },
): Promise<Score[]> {
  if (result.error) return [{ name: "completed", pass: false, reason: result.error }];
  const scores: Score[] = [{ name: "completed", pass: true }];
  if (expected.contains) {
    const pass = result.reply.toLowerCase().includes(expected.contains.toLowerCase());
    scores.push({ name: "contains", pass, reason: pass ? undefined : `Reply does not mention "${expected.contains}"` });
  }
  if (expected.outcome) {
    const pass = result.outcome === expected.outcome;
    scores.push({ name: "outcome", pass, reason: pass ? undefined : `Outcome was ${result.outcome ?? "none"}` });
  }
  if (expected.rubric) {
    if (!judge) {
      scores.push({ name: "judge", pass: false, reason: "No judge model available" });
    } else {
      const res = await judge.gateway.chat(
        judge.model,
        {
          messages: [
            {
              role: "system",
              content:
                "You grade an AI assistant's reply against the criteria. Give an integer score from 1 (fails) to 5 (fully meets) and a one-sentence reason.",
            },
            {
              role: "user",
              content: `Criteria: ${expected.rubric}\n\nUser message: ${result.input}\n\nAssistant reply: ${result.reply}`,
            },
          ],
          maxTokens: 200,
        },
        {
          outputSchema: {
            type: "object",
            properties: { score: { type: "integer" }, reason: { type: "string" } },
            required: ["score"],
          },
        },
      );
      const verdict = res.json as { score: number; reason?: string };
      scores.push({ name: "judge", pass: verdict.score >= 4, score: verdict.score, reason: verdict.reason });
    }
  }
  return scores;
}

/** Eval Studio (H2): datasets of test messages, sandboxed runs against the draft, and the publish gate. */
export async function evalRoutes(app: FastifyInstance, { db, auth, evalExecutor, gatewayFor }: Deps) {
  const findFlow = async (workspaceId: string, id: string) => {
    const [flow] = await db
      .select()
      .from(flows)
      .where(and(eq(flows.id, id), eq(flows.workspaceId, workspaceId)));
    if (!flow) throw new HttpError(404, "Flow not found");
    return flow;
  };
  const findDataset = async (workspaceId: string, id: string) => {
    const [ds] = await db
      .select()
      .from(evalDatasets)
      .where(and(eq(evalDatasets.id, id), eq(evalDatasets.workspaceId, workspaceId)));
    if (!ds) throw new HttpError(404, "Dataset not found");
    return ds;
  };

  app.get<{ Params: { id: string } }>(
    "/flows/:id/evals",
    { preHandler: auth.requireWorkspace("viewer") },
    async (req) => {
      const ws = currentWorkspace(req);
      const flow = await findFlow(ws.id, req.params.id);
      const datasets = await db
        .select()
        .from(evalDatasets)
        .where(eq(evalDatasets.flowId, flow.id))
        .orderBy(asc(evalDatasets.createdAt));
      const out = [];
      for (const ds of datasets) {
        const cases = await db
          .select()
          .from(evalCases)
          .where(eq(evalCases.datasetId, ds.id))
          .orderBy(asc(evalCases.createdAt));
        const recent = await db
          .select()
          .from(evalRuns)
          .where(eq(evalRuns.datasetId, ds.id))
          .orderBy(desc(evalRuns.createdAt))
          .limit(5);
        out.push({ ...ds, cases, runs: recent });
      }
      return {
        datasets: out,
        draftHash: hashDraft(flow.draftJson),
        gate: (flow.settings as { publishGate?: unknown }).publishGate ?? { enabled: false, minPassRate: 0.9 },
      };
    },
  );

  app.post<{ Params: { id: string } }>(
    "/flows/:id/evals",
    { preHandler: auth.requireWorkspace("builder") },
    async (req, reply) => {
      const { name } = z.object({ name: z.string().trim().min(1).max(120) }).parse(req.body);
      const ws = currentWorkspace(req);
      const flow = await findFlow(ws.id, req.params.id);
      const [ds] = await db.insert(evalDatasets).values({ workspaceId: ws.id, flowId: flow.id, name }).returning();
      return reply.code(201).send(ds);
    },
  );

  app.post<{ Params: { id: string } }>(
    "/evals/:id/cases",
    { preHandler: auth.requireWorkspace("builder") },
    async (req, reply) => {
      const body = NewCase.parse(req.body);
      const ds = await findDataset(currentWorkspace(req).id, req.params.id);
      const [created] = await db
        .insert(evalCases)
        .values({ datasetId: ds.id, ...body })
        .returning();
      return reply.code(201).send(created);
    },
  );

  /** "Add from trace": the run's first message becomes a case expecting the same outcome. */
  app.post<{ Params: { id: string } }>(
    "/evals/:id/cases/from-run",
    { preHandler: auth.requireWorkspace("builder") },
    async (req, reply) => {
      const { runId } = z.object({ runId: z.string().min(1) }).parse(req.body);
      const ws = currentWorkspace(req);
      const ds = await findDataset(ws.id, req.params.id);
      const [run] = await db
        .select()
        .from(runs)
        .where(and(eq(runs.id, runId), eq(runs.workspaceId, ws.id)));
      if (!run) throw new HttpError(404, "Run not found");
      const state = run.state as { conversation?: { role: string; content: string }[]; outcome?: string };
      const input = state.conversation?.find((t) => t.role === "user")?.content;
      if (!input) throw new HttpError(400, "This run has no user message");
      const [created] = await db
        .insert(evalCases)
        .values({ datasetId: ds.id, input, expected: state.outcome ? { outcome: state.outcome } : {} })
        .returning();
      return reply.code(201).send(created);
    },
  );

  app.delete<{ Params: { id: string; caseId: string } }>(
    "/evals/:id/cases/:caseId",
    { preHandler: auth.requireWorkspace("builder") },
    async (req, reply) => {
      const ds = await findDataset(currentWorkspace(req).id, req.params.id);
      await db.delete(evalCases).where(and(eq(evalCases.id, req.params.caseId), eq(evalCases.datasetId, ds.id)));
      return reply.code(204).send();
    },
  );

  /** Runs every case against the current draft in sandbox mode (write tools simulated, no inbox items). */
  app.post<{ Params: { id: string } }>(
    "/evals/:id/run",
    { preHandler: auth.requireWorkspace("builder") },
    async (req) => {
      const body = RunEvals.parse(req.body ?? {});
      const ws = currentWorkspace(req);
      const ds = await findDataset(ws.id, req.params.id);
      const flowRow = await findFlow(ws.id, ds.flowId);
      const validation = validateFlow(flowRow.draftJson);
      if (!validation.ok) throw new HttpError(422, "Fix the flow's errors before running evals");
      const flow: Flow = validation.flow;
      const cases = await db
        .select()
        .from(evalCases)
        .where(eq(evalCases.datasetId, ds.id))
        .orderBy(asc(evalCases.createdAt));
      if (cases.length === 0) throw new HttpError(400, "Add at least one test case");
      if (cases.length > 100) throw new HttpError(400, "Datasets are limited to 100 cases per run");

      const firstAgent = flow.nodes.find((n) => n.type === "agent");
      const judgeModel = body.judgeModel ?? (firstAgent?.type === "agent" ? firstAgent.config.model : undefined);
      const judge = judgeModel ? { gateway: gatewayFor(ws.id), model: judgeModel } : undefined;

      const [evalRun] = await db
        .insert(evalRuns)
        .values({
          datasetId: ds.id,
          flowId: flowRow.id,
          draftHash: hashDraft(flowRow.draftJson),
          total: cases.length,
          createdBy: currentUser(req).id,
        })
        .returning();
      let passed = 0;
      const results = [];
      for (const c of cases) {
        const started = Date.now();
        let reply = "";
        let error: string | null = null;
        const runId = await evalExecutor.start(
          {
            workspaceId: ws.id,
            flowId: flowRow.id,
            flowVersionId: null,
            flow,
            triggerType: "chat",
            input: { message: c.input },
            sandbox: true,
          },
          (e: RunEvent) => {
            if (e.type === "message") reply = reply ? `${reply}\n${e.content}` : e.content;
            if (e.type === "error") error = e.message;
          },
        );
        const [run] = await db
          .select({ state: runs.state, costUsd: runs.costUsd })
          .from(runs)
          .where(eq(runs.id, runId));
        const outcome = (run?.state as { outcome?: string; paused?: unknown } | undefined)?.paused
          ? "awaiting_approval"
          : ((run?.state as { outcome?: string })?.outcome ?? null);
        const scores = await scoreCase(c.expected, { reply, outcome, error, input: c.input }, judge).catch(
          (e: Error) => [{ name: "judge", pass: false, reason: e.message }],
        );
        const pass = scores.every((s) => s.pass);
        if (pass) passed++;
        const [row] = await db
          .insert(evalResults)
          .values({
            evalRunId: evalRun!.id,
            caseId: c.id,
            runId,
            reply,
            outcome,
            scores,
            pass,
            latencyMs: Date.now() - started,
            costUsd: run?.costUsd ?? null,
          })
          .returning();
        results.push({ ...row, input: c.input });
      }
      const passRate = passed / cases.length;
      await db
        .update(evalRuns)
        .set({ status: "completed", passed, passRate, finishedAt: new Date() })
        .where(eq(evalRuns.id, evalRun!.id));
      return { id: evalRun!.id, passed, total: cases.length, passRate, results };
    },
  );

  app.get<{ Params: { runId: string } }>(
    "/eval-runs/:runId",
    { preHandler: auth.requireWorkspace("viewer") },
    async (req) => {
      const ws = currentWorkspace(req);
      const [row] = await db
        .select({ run: evalRuns })
        .from(evalRuns)
        .innerJoin(evalDatasets, eq(evalDatasets.id, evalRuns.datasetId))
        .where(and(eq(evalRuns.id, req.params.runId), eq(evalDatasets.workspaceId, ws.id)));
      if (!row) throw new HttpError(404, "Eval run not found");
      const results = await db
        .select({ result: evalResults, input: evalCases.input, expected: evalCases.expected })
        .from(evalResults)
        .innerJoin(evalCases, eq(evalCases.id, evalResults.caseId))
        .where(eq(evalResults.evalRunId, row.run.id));
      return { ...row.run, results: results.map((r) => ({ ...r.result, input: r.input, expected: r.expected })) };
    },
  );
}
