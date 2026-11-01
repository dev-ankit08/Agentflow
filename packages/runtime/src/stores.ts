import { and, eq } from "drizzle-orm";
import { runSteps, runs, workspaces, type Db } from "@agentflow/db";
import type { Flow } from "@agentflow/flow-schema";
import type { NewRun, RunState, RunStatus, RunStore, StepRecord, StoredRun } from "./types";

/** In-memory store for tests and previews. */
export class MemoryRunStore implements RunStore {
  runs = new Map<string, StoredRun>();
  steps: StepRecord[] = [];
  private seq = 0;

  async create(run: NewRun & { flow: Flow }) {
    const id = `run_${++this.seq}`;
    this.runs.set(id, { ...run, id, status: "running", state: structuredClone(run.state) });
    return id;
  }
  async load(runId: string) {
    const run = this.runs.get(runId);
    return run ? { ...run, state: structuredClone(run.state) } : null;
  }
  async save(runId: string, state: RunState, status: RunStatus) {
    const run = this.runs.get(runId);
    if (run) Object.assign(run, { state: structuredClone(state), status });
  }
  async appendStep(step: StepRecord) {
    this.steps.push(step);
  }
}

/**
 * Postgres store. The flow definition a run executes is kept in its state, so editing the
 * draft never changes a conversation that is already in progress.
 */
export class DbRunStore implements RunStore {
  constructor(private db: Db) {}

  /** Workspaces in zero-retention mode keep no prompts, step inputs/outputs or transcripts. */
  private async zeroRetention(runId: string) {
    const [row] = await this.db
      .select({ settings: workspaces.settings })
      .from(runs)
      .innerJoin(workspaces, eq(workspaces.id, runs.workspaceId))
      .where(eq(runs.id, runId));
    return Boolean(row?.settings.retention?.zeroRetention);
  }

  async create(run: NewRun & { flow: Flow }) {
    const [row] = await this.db
      .insert(runs)
      .values({
        workspaceId: run.workspaceId,
        flowId: run.flowId,
        flowVersionId: run.flowVersionId,
        triggerType: run.triggerType,
        endUserId: run.endUserId ?? null,
        sandbox: run.sandbox ?? false,
        state: { ...run.state, flow: run.flow } as unknown as Record<string, unknown>,
      })
      .returning({ id: runs.id });
    return row!.id;
  }

  async load(runId: string): Promise<StoredRun | null> {
    const [row] = await this.db.select().from(runs).where(eq(runs.id, runId));
    if (!row) return null;
    const { flow, ...state } = row.state as unknown as RunState & { flow: Flow };
    return {
      id: row.id,
      workspaceId: row.workspaceId,
      flowId: row.flowId,
      flowVersionId: row.flowVersionId,
      triggerType: row.triggerType,
      endUserId: row.endUserId,
      sandbox: row.sandbox,
      status: row.status,
      state,
      flow,
    };
  }

  async save(runId: string, state: RunState, status: RunStatus) {
    const [row] = await this.db.select({ state: runs.state }).from(runs).where(eq(runs.id, runId));
    const flow = (row?.state as { flow?: Flow } | undefined)?.flow;
    const finished = status === "completed" || status === "failed" || status === "handed_off";
    if (finished && (await this.zeroRetention(runId))) state = scrubState(state);
    await this.db
      .update(runs)
      .set({
        state: { ...state, flow } as unknown as Record<string, unknown>,
        status,
        costUsd: state.costUsd.toFixed(6),
        endedAt: finished ? new Date() : null,
      })
      .where(and(eq(runs.id, runId)));
  }

  async appendStep(step: StepRecord) {
    if (await this.zeroRetention(step.runId))
      step = { ...step, input: undefined, output: undefined, promptRedacted: undefined };
    await this.db.insert(runSteps).values({
      runId: step.runId,
      stepIndex: step.stepIndex,
      nodeId: step.nodeId,
      nodeType: step.nodeType,
      status: step.status,
      inputJson: step.input ?? null,
      outputJson: step.output ?? null,
      promptRedacted: step.promptRedacted ?? null,
      model: step.model ?? null,
      tokensIn: step.tokensIn ?? null,
      tokensOut: step.tokensOut ?? null,
      costUsd: step.costUsd != null ? step.costUsd.toFixed(6) : null,
      error: step.error ?? null,
      startedAt: step.startedAt,
      endedAt: step.endedAt,
    });
  }
}

/** Drops everything a customer said or was told, keeping only what is needed for metrics. */
export function scrubState(state: RunState): RunState {
  return { ...state, conversation: [], nodeOutputs: {}, variables: {}, trigger: {}, user: {} };
}
