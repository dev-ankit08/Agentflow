import { createHash } from "node:crypto";
import { and, eq, gte, lt, sql } from "drizzle-orm";
import { approvals, flowVersions, flows, handoffs, runSteps, runs, workspaces, type Db } from "@agentflow/db";
import { Flow, validateFlow } from "@agentflow/flow-schema";
import type { LLMGateway } from "@agentflow/llm-gateway";
import type { RunExecutor, RuntimeServices, ToolProvider } from "@agentflow/runtime";
import { searchKnowledge } from "./semantic";
import { memoryService } from "./automation";

const monthStart = () => {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
};

/** Month-to-date AI usage for a workspace (live runs only; evals are excluded). */
export async function monthUsage(db: Db, workspaceId: string) {
  const since = monthStart();
  const [cost] = await db
    .select({ usd: sql<string>`coalesce(sum(${runs.costUsd}), 0)` })
    .from(runs)
    .where(and(eq(runs.workspaceId, workspaceId), gte(runs.startedAt, since), eq(runs.sandbox, false)));
  const [tokens] = await db
    .select({
      n: sql<string>`coalesce(sum(coalesce(${runSteps.tokensIn}, 0) + coalesce(${runSteps.tokensOut}, 0)), 0)`,
    })
    .from(runSteps)
    .innerJoin(runs, eq(runs.id, runSteps.runId))
    .where(and(eq(runs.workspaceId, workspaceId), gte(runs.startedAt, since), eq(runs.sandbox, false)));
  return { usd: Number(cost?.usd ?? 0), tokens: Number(tokens?.n ?? 0) };
}

export async function loadWorkspaceFlow(db: Db, workspaceId: string, flowId: string, useDraft: boolean) {
  const [flow] = await db
    .select()
    .from(flows)
    .where(and(eq(flows.id, flowId), eq(flows.workspaceId, workspaceId)));
  if (!flow) throw new Error(`Flow ${flowId} not found in this workspace`);
  if (useDraft) {
    const v = validateFlow(flow.draftJson);
    if (!v.ok) throw new Error(`Flow "${flow.name}" has errors`);
    return { flow: v.flow, versionId: null };
  }
  if (!flow.liveVersionId) throw new Error(`Flow "${flow.name}" is not published`);
  const [version] = await db.select().from(flowVersions).where(eq(flowVersions.id, flow.liveVersionId));
  return { flow: Flow.parse(version!.json), versionId: version!.id };
}

/** Services for live runs: real inbox items, knowledge, budgets. */
export function makeServicesFor(
  db: Db,
  gatewayFor: (workspaceId: string) => LLMGateway,
  onApprovalRequested?: (approvalId: string) => void,
) {
  return (workspaceId: string): RuntimeServices => ({
    knowledge: { search: (q, o) => searchKnowledge(db, workspaceId, q, o, gatewayFor(workspaceId)) },
    approvals: {
      async request(input) {
        const [row] = await db
          .insert(approvals)
          .values({ workspaceId, ...input })
          .returning({ id: approvals.id });
        onApprovalRequested?.(row!.id);
        return row!.id;
      },
    },
    handoffs: {
      async create(input) {
        const [row] = await db
          .insert(handoffs)
          .values({ workspaceId, ...input })
          .returning({ id: handoffs.id });
        return row!.id;
      },
    },
    loadFlow: (flowId, useDraft) => loadWorkspaceFlow(db, workspaceId, flowId, useDraft),
    memory: memoryService(db, workspaceId),
    async checkBudget() {
      const [ws] = await db
        .select({ settings: workspaces.settings })
        .from(workspaces)
        .where(eq(workspaces.id, workspaceId));
      const budget = ws?.settings.budget;
      if (!budget?.monthlyUsd && !budget?.monthlyTokens) return;
      const used = await monthUsage(db, workspaceId);
      if (
        (budget.monthlyUsd && used.usd >= budget.monthlyUsd) ||
        (budget.monthlyTokens && used.tokens >= budget.monthlyTokens)
      ) {
        throw new Error("This workspace has reached its monthly AI budget. An admin can raise it in Settings.");
      }
    },
  });
}

/** Services for eval runs: nothing reaches the inbox, and write tools are not executed. */
export function makeSandboxServicesFor(db: Db, gatewayFor: (workspaceId: string) => LLMGateway) {
  const live = makeServicesFor(db, gatewayFor);
  return (workspaceId: string): RuntimeServices => ({
    ...live(workspaceId),
    memory: { read: memoryService(db, workspaceId).read, write: async () => {} },
    approvals: { request: async () => "sandbox" },
    handoffs: { create: async () => "sandbox" },
    checkBudget: async () => {},
  });
}

export function sandboxTools(tools: ToolProvider, modes: (ref: string) => Promise<string | undefined>): ToolProvider {
  return {
    describe: (refs) => tools.describe(refs),
    async call(ref, args) {
      if ((await modes(ref)) === "read") return tools.call(ref, args);
      const data = { sandbox: true, note: "Write tools are simulated during evals", args };
      return { data, text: JSON.stringify(data), isError: false };
    },
  };
}

/** Resumes runs whose approval passed its deadline, on their "timeout" path. */
export async function sweepExpiredApprovals(db: Db, executor: RunExecutor) {
  const expired = await db
    .update(approvals)
    .set({ status: "expired", decidedAt: new Date() })
    .where(and(eq(approvals.status, "pending"), lt(approvals.expiresAt, new Date())))
    .returning();
  for (const a of expired) {
    await executor.resume(a.runId, { handle: "timeout", output: { decision: "timeout" } }, () => {}).catch(() => {});
  }
  return expired.length;
}

export const hashDraft = (draft: unknown) =>
  createHash("sha256").update(JSON.stringify(draft)).digest("hex").slice(0, 32);
