import type { Flow, NodeDef } from "@agentflow/flow-schema";
import type { LLMGateway } from "@agentflow/llm-gateway";
import { handlers } from "./handlers";
import { redactDeep } from "./redact";
import type {
  Citation,
  NodeContext,
  NodeResult,
  RunEvent,
  RunState,
  RunStore,
  RuntimeServices,
  StepMeta,
  ToolProvider,
} from "./types";

export type ExecutorDeps = {
  store: RunStore;
  /** Gateway and tools are per workspace (their keys and connectors). */
  gatewayFor: (workspaceId: string) => LLMGateway;
  toolsFor: (workspaceId: string) => ToolProvider;
  servicesFor?: (workspaceId: string) => RuntimeServices;
  fetch?: typeof fetch;
};

const MAX_SUBFLOW_DEPTH = 3;

export type StartInput = {
  workspaceId: string;
  flowId: string;
  flowVersionId: string | null;
  flow: Flow;
  triggerType: "chat" | "webhook" | "api" | "schedule" | "email";
  input: Record<string, unknown>;
  user?: Record<string, unknown>;
  endUserId?: string | null;
  /** Subflow nesting level (set by the executor). */
  depth?: number;
  /** Eval runs: excluded from analytics. */
  sandbox?: boolean;
};

/** Continues a paused run: `handle` picks the outgoing connection, `output` is merged into the node's output. */
export type ResumeInput = { handle?: string; output?: Record<string, unknown>; message?: string };

export type Emit = (event: RunEvent) => void;

const DEFAULT_TIMEOUT: Partial<Record<NodeDef["type"], number>> = {
  agent: 120_000,
  mcp_tool: 30_000,
  http: 30_000,
  // Nodes that make several model calls or run a whole child flow.
  supervisor: 600_000,
  parallel: 300_000,
  subflow: 600_000,
  memory: 120_000,
};
/** Safety net for loops: steps inside Loop bodies per turn. */
const LOOP_STEP_CAP = 2_000;

/** Seam for a durable engine later (docs/03-architecture.md §10). */
export interface RunExecutor {
  start(input: StartInput, emit: Emit): Promise<string>;
  sendMessage(runId: string, message: string, emit: Emit): Promise<void>;
  resume(runId: string, input: ResumeInput, emit: Emit): Promise<void>;
}

/**
 * In-process graph executor. Walks the flow node by node, persisting state and a trace step after each one,
 * so a run can continue on the next chat message (or after a restart) from exactly where it stopped.
 */
export class InProcessExecutor implements RunExecutor {
  constructor(private deps: ExecutorDeps) {}

  async start(input: StartInput, emit: Emit): Promise<string> {
    const startNode = input.flow.nodes.find((n) => n.type === "start");
    if (!startNode) throw new Error("Flow has no Start node");
    const message = typeof input.input.message === "string" ? input.input.message : undefined;
    const state: RunState = {
      currentNodeId: startNode.id,
      stepIndex: 0,
      turnSteps: 0,
      variables: Object.fromEntries(input.flow.variables.map((v) => [v.name, v.default ?? null])),
      nodeOutputs: {},
      trigger: input.input,
      user: input.user ?? {},
      conversation: message ? [{ role: "user", content: message }] : [],
      costUsd: 0,
      depth: input.depth ?? 0,
    };
    for (const v of input.flow.variables)
      if (v.isInput && input.input[v.name] !== undefined) state.variables[v.name] = input.input[v.name];

    const runId = await this.deps.store.create({
      workspaceId: input.workspaceId,
      flowId: input.flowId,
      flowVersionId: input.flowVersionId,
      triggerType: input.triggerType,
      endUserId: input.endUserId ?? null,
      sandbox: input.sandbox ?? false,
      flow: input.flow,
      state,
    });
    emit({ type: "run_started", runId });
    await this.drive(runId, input.workspaceId, input.flow, state, input.triggerType === "chat", emit);
    return runId;
  }

  async sendMessage(runId: string, message: string, emit: Emit): Promise<void> {
    const run = await this.deps.store.load(runId);
    if (!run) throw new Error("Run not found");
    if (run.status !== "waiting_input") throw new Error(`Run is ${run.status}, not waiting for a message`);
    const state = run.state;
    if (state.paused?.reason === "form") {
      // A reply while a form is open is its submission: JSON values from the widget, or plain text.
      let values: Record<string, unknown>;
      try {
        const parsed = JSON.parse(message);
        values = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : { text: message };
      } catch {
        values = { text: message };
      }
      return this.resume(runId, { output: { values, ...values }, message }, emit);
    }
    const startNode = run.flow.nodes.find((n) => n.type === "start")!;
    state.conversation.push({ role: "user", content: message });
    state.trigger = { ...state.trigger, message };
    state.nodeOutputs = {};
    state.currentNodeId = startNode.id;
    state.turnSteps = 0;
    // A new turn starts every Loop afresh, even if the last turn left one mid-way (e.g. its body ended the turn).
    state.loops = {};
    state.loopSteps = 0;
    emit({ type: "run_started", runId });
    await this.drive(runId, run.workspaceId, run.flow, state, true, emit);
  }

  async resume(runId: string, input: ResumeInput, emit: Emit): Promise<void> {
    const run = await this.deps.store.load(runId);
    if (!run) throw new Error("Run not found");
    const state = run.state;
    const paused = state.paused;
    if (!paused) throw new Error("Run is not paused");
    const node = run.flow.nodes.find((n) => n.id === paused.nodeId);
    if (!node) throw new Error(`Unknown node "${paused.nodeId}"`);
    const previous = (state.nodeOutputs[node.id] ?? {}) as Record<string, unknown>;
    state.nodeOutputs[node.id] = { ...previous, ...input.output };
    if (input.message) state.conversation.push({ role: "user", content: input.message });
    state.paused = undefined;
    state.turnSteps = 0;
    state.currentNodeId = nextNode(run.flow, node, input.handle);
    emit({ type: "run_started", runId });
    await this.drive(runId, run.workspaceId, run.flow, state, run.triggerType === "chat", emit);
  }

  /** Runs another flow of the workspace to completion and returns its End output. */
  private async runChild(
    workspaceId: string,
    depth: number,
    flowId: string,
    useDraft: boolean,
    input: Record<string, unknown>,
  ): Promise<unknown> {
    if (depth >= MAX_SUBFLOW_DEPTH) throw new Error(`Subflows can nest at most ${MAX_SUBFLOW_DEPTH} levels`);
    const loadFlow = this.deps.servicesFor?.(workspaceId).loadFlow;
    if (!loadFlow) throw new Error("Subflows are not available");
    const child = await loadFlow(flowId, useDraft);
    let result: { output?: unknown; error?: string; paused?: boolean } = {};
    await this.start(
      {
        workspaceId,
        flowId,
        flowVersionId: child.versionId,
        flow: child.flow,
        triggerType: "api",
        input,
        depth: depth + 1,
      },
      (e) => {
        if (e.type === "done") result = { output: e.output ?? null };
        else if (e.type === "error") result = { error: e.message };
        else if (e.type === "paused") result = { paused: true };
      },
    );
    if (result.error) throw new Error(`Subflow failed: ${result.error}`);
    if (result.paused) throw new Error("Subflows cannot pause for approvals or forms");
    return result.output ?? null;
  }

  private async drive(runId: string, workspaceId: string, flow: Flow, state: RunState, chat: boolean, emit: Emit) {
    const { store } = this.deps;
    const gateway = this.deps.gatewayFor(workspaceId);
    const tools = this.deps.toolsFor(workspaceId);
    const services = this.deps.servicesFor?.(workspaceId) ?? {};
    const depth = state.depth ?? 0;
    const nodes = new Map(flow.nodes.map((n) => [n.id, n]));
    await store.save(runId, state, "running");

    try {
      while (state.currentNodeId) {
        const node = nodes.get(state.currentNodeId);
        if (!node) throw new Error(`Unknown node "${state.currentNodeId}"`);
        if ((state.loopSteps ?? 0) >= LOOP_STEP_CAP)
          throw new Error(`Stopped after ${LOOP_STEP_CAP} steps inside loops in one turn`);
        if (state.turnSteps >= flow.settings.maxSteps)
          throw new Error(`Stopped after ${flow.settings.maxSteps} steps (maxSteps)`);
        if (state.costUsd > flow.settings.maxCostUsd)
          throw new Error(`Stopped: run cost exceeded $${flow.settings.maxCostUsd}`);

        const stepIndex = state.stepIndex;
        const startedAt = new Date();
        emit({ type: "step_started", stepIndex, nodeId: node.id, nodeType: node.type, label: node.label });

        let meta: StepMeta = {};
        let result: NodeResult;
        try {
          result = await this.runNode(node, {
            runId,
            workspaceId,
            services,
            runChild: (flowId, useDraft, input) => this.runChild(workspaceId, depth, flowId, useDraft, input),
            flow,
            state,
            scope: () => scopeOf(state),
            gateway,
            tools,
            fetch: this.deps.fetch ?? fetch,
            emit,
            signal: new AbortController().signal, // replaced per attempt in runNode
            meta: (m) => (meta = { ...meta, ...m }),
          });
        } catch (error) {
          const message = (error as Error).message;
          const endedAt = new Date();
          await store.appendStep({
            runId,
            stepIndex,
            nodeId: node.id,
            nodeType: node.type,
            status: "error",
            error: message,
            input: redactDeep(meta.input),
            promptRedacted: meta.promptRedacted,
            model: meta.model,
            startedAt,
            endedAt,
          });
          emit({
            type: "step_completed",
            stepIndex,
            nodeId: node.id,
            status: "error",
            error: message,
            durationMs: endedAt.getTime() - startedAt.getTime(),
          });
          state.stepIndex++;
          state.turnSteps++;
          if (node.onError !== "continue") throw error;
          state.nodeOutputs[node.id] = { error: message };
          state.currentNodeId = nextNode(flow, node, undefined);
          await store.save(runId, state, "running");
          continue;
        }

        const endedAt = new Date();
        if (meta.costUsd) state.costUsd += meta.costUsd;
        const output =
          result.kind === "next"
            ? result.output
            : result.kind === "pause"
              ? { ...(result.output as object), message: result.message, ui: result.ui }
              : { message: result.message, output: result.output };
        if (result.kind !== "end") state.nodeOutputs[node.id] = result.output ?? null;
        state.stepIndex++;
        // Steps inside a Loop body are bounded by the Loop's own maxIterations instead.
        if (!Object.keys(state.loops ?? {}).length) state.turnSteps++;
        else state.loopSteps = (state.loopSteps ?? 0) + 1;

        await store.appendStep({
          runId,
          stepIndex,
          nodeId: node.id,
          nodeType: node.type,
          status: "ok",
          input: redactDeep(meta.input),
          output: redactDeep(output),
          promptRedacted: meta.promptRedacted,
          model: meta.model,
          tokensIn: meta.tokensIn,
          tokensOut: meta.tokensOut,
          costUsd: meta.costUsd,
          startedAt,
          endedAt,
        });
        emit({
          type: "step_completed",
          stepIndex,
          nodeId: node.id,
          status: "ok",
          output,
          handle: result.kind === "next" ? result.handle : undefined,
          durationMs: endedAt.getTime() - startedAt.getTime(),
          tokensIn: meta.tokensIn,
          tokensOut: meta.tokensOut,
          costUsd: meta.costUsd,
        });

        if (result.kind === "pause") {
          state.paused = {
            nodeId: node.id,
            reason: result.reason,
            since: new Date().toISOString(),
            ...(result.resumeAt && { resumeAt: result.resumeAt }),
          };
          if (result.message) {
            state.conversation.push({ role: "assistant", content: result.message });
            emit({ type: "message", role: "assistant", content: result.message });
          }
          const pausedStatus =
            result.reason === "approval"
              ? "waiting_approval"
              : result.reason === "wait"
                ? "waiting_timer"
                : "waiting_input";
          await store.save(runId, state, pausedStatus);
          emit({
            type: "paused",
            reason: result.reason,
            ui: result.ui,
            ...(result.resumeAt && { resumeAt: result.resumeAt }),
          });
          return;
        }

        if (result.kind === "end") {
          if (result.outcome) state.outcome = result.outcome;
          if (result.message) {
            state.conversation.push({ role: "assistant", content: result.message });
            const citations = citationsOf(state);
            emit({
              type: "message",
              role: "assistant",
              content: result.message,
              ...(citations.length && { citations }),
            });
          }
          state.currentNodeId = null;
          const status = result.status ?? (chat ? "waiting_input" : "completed");
          await store.save(runId, state, status);
          emit(
            status === "waiting_input"
              ? { type: "waiting_input" }
              : { type: "done", outcome: result.outcome, output: result.output },
          );
          return;
        }

        state.currentNodeId = nextNode(flow, node, result.handle);
        await store.save(runId, state, "running");
      }
      // Ran off the end of the graph without an End node.
      await store.save(runId, state, chat ? "waiting_input" : "completed");
      emit(chat ? { type: "waiting_input" } : { type: "done" });
    } catch (error) {
      state.outcome = "failed";
      await store.save(runId, state, "failed");
      emit({ type: "error", message: (error as Error).message });
    }
  }

  private async runNode(node: NodeDef, ctx: NodeContext): Promise<NodeResult> {
    const handler = handlers[node.type];
    if (!handler) throw new Error(`No handler for node type "${node.type}"`);
    const retries = node.retries ?? 0;
    const timeoutMs = node.timeoutMs ?? DEFAULT_TIMEOUT[node.type] ?? 30_000;
    for (let attempt = 0; ; attempt++) {
      const controller = new AbortController();
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error(`"${node.label}" timed out after ${timeoutMs / 1000}s`));
        }, timeoutMs);
      });
      try {
        return await Promise.race([handler.run({ ...ctx, signal: controller.signal }, node), timeout]);
      } catch (error) {
        if (attempt >= retries) throw error;
      } finally {
        clearTimeout(timer);
      }
    }
  }
}

/** Variables visible to formulas and templates: flow variables, node outputs by id, trigger, user, conversation. */
export function scopeOf(state: RunState): Record<string, unknown> {
  return {
    ...state.variables,
    ...state.nodeOutputs,
    trigger: state.trigger,
    user: state.user,
    conversation: { history: state.conversation, turn: state.conversation.filter((t) => t.role === "user").length },
  };
}

/** Sources cited by Knowledge nodes during this turn. */
function citationsOf(state: RunState): Citation[] {
  return Object.values(state.nodeOutputs).flatMap((o) =>
    o && typeof o === "object" && Array.isArray((o as { citations?: unknown }).citations)
      ? (o as { citations: Citation[] }).citations
      : [],
  );
}

function nextNode(flow: Flow, node: NodeDef, handle: string | undefined): string | null {
  const edge = flow.edges.find((e) => e.source === node.id && (handle === undefined || e.sourceHandle === handle));
  return edge?.target ?? null;
}
