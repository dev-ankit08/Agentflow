import type { Flow, NodeDef } from "@agentflow/flow-schema";
import type { LLMGateway, ToolDef } from "@agentflow/llm-gateway";

export type RunStatus =
  "running" | "waiting_approval" | "waiting_input" | "waiting_timer" | "completed" | "failed" | "handed_off";

export type PauseReason = "approval" | "form" | "wait";

export type ChatTurn = { role: "user" | "assistant"; content: string };

/** Everything needed to continue a run; persisted after every step. */
export type RunState = {
  currentNodeId: string | null;
  stepIndex: number;
  turnSteps: number;
  variables: Record<string, unknown>;
  nodeOutputs: Record<string, unknown>;
  trigger: Record<string, unknown>;
  user: Record<string, unknown>;
  conversation: ChatTurn[];
  costUsd: number;
  outcome?: string;
  /** Set while the run waits on an Approval or Form node. */
  paused?: { nodeId: string; reason: PauseReason; since: string; resumeAt?: string };
  /** Progress of Loop nodes that are currently iterating. */
  loops?: Record<string, { items: unknown[]; index: number; results: unknown[] }>;
  /** Nesting level for subflows (0 = top-level run). */
  depth?: number;
};

/** Streamed to the test console, widget and API clients (docs/03-architecture.md §7). */
export type RunEvent =
  | { type: "run_started"; runId: string }
  | { type: "step_started"; stepIndex: number; nodeId: string; nodeType: string; label: string }
  | { type: "token"; nodeId: string; text: string }
  | {
      type: "step_completed";
      stepIndex: number;
      nodeId: string;
      status: "ok" | "error";
      output?: unknown;
      error?: string;
      durationMs: number;
      handle?: string;
      tokensIn?: number;
      tokensOut?: number;
      costUsd?: number | null;
    }
  | { type: "message"; role: "assistant"; content: string; citations?: Citation[] }
  | { type: "paused"; reason: PauseReason; ui?: FormUi; resumeAt?: string }
  | { type: "waiting_input" }
  | { type: "done"; outcome?: string; output?: unknown }
  | { type: "error"; message: string };

export type StepRecord = {
  runId: string;
  stepIndex: number;
  nodeId: string;
  nodeType: string;
  status: "ok" | "error";
  input?: unknown;
  output?: unknown;
  promptRedacted?: string;
  model?: string;
  tokensIn?: number;
  tokensOut?: number;
  costUsd?: number | null;
  error?: string;
  startedAt: Date;
  endedAt: Date;
};

export type NewRun = {
  workspaceId: string;
  flowId: string;
  flowVersionId: string | null;
  triggerType: string;
  endUserId?: string | null;
  sandbox?: boolean;
  state: RunState;
};

export type StoredRun = NewRun & { id: string; status: RunStatus; flow: Flow };

/** Persistence seam: Postgres in the prototype (DbRunStore), swappable later. */
export interface RunStore {
  create(run: NewRun & { flow: Flow }): Promise<string>;
  load(runId: string): Promise<StoredRun | null>;
  save(runId: string, state: RunState, status: RunStatus): Promise<void>;
  appendStep(step: StepRecord): Promise<void>;
}

/** Tools an agent can call; implemented by the API over the workspace's MCP connectors. */
export interface ToolProvider {
  /** `refs` are "connectorId/toolName". Returns tool definitions with LLM-safe names. */
  describe(refs: string[]): Promise<(ToolDef & { ref: string })[]>;
  call(ref: string, args: Record<string, unknown>): Promise<{ data: unknown; text: string; isError: boolean }>;
}

export type Citation = { n: number; title: string; uri: string | null };
export type FormUi = {
  title: string;
  submitLabel: string;
  fields: { name: string; label: string; type: string; options?: string[]; required: boolean }[];
};

export type NodeResult =
  | { kind: "next"; output?: unknown; handle?: string }
  | { kind: "end"; output?: unknown; outcome?: string; message?: string; status?: "handed_off" }
  | { kind: "pause"; reason: PauseReason; output?: unknown; message?: string; ui?: FormUi; resumeAt?: string };

export type KnowledgeChunk = { text: string; title: string; uri: string | null; score: number };

/** Workspace services the newer nodes rely on; implemented by the API (Postgres), stubbed in tests. */
export interface RuntimeServices {
  knowledge?: { search(query: string, opts: { sources: string[]; topK: number }): Promise<KnowledgeChunk[]> };
  approvals?: {
    request(input: {
      runId: string;
      nodeId: string;
      message: string;
      approverRole: string;
      expiresAt: Date;
    }): Promise<string>;
  };
  handoffs?: {
    create(input: { runId: string; queue: string; summary: string; transcript: string }): Promise<string>;
  };
  /** Loads a flow of the same workspace for Subflow nodes (live version unless `useDraft`). */
  loadFlow?: (flowId: string, useDraft: boolean) => Promise<{ flow: Flow; versionId: string | null }>;
  /** Throws when the workspace's monthly AI budget is used up. */
  checkBudget?: () => Promise<void>;
  /** Long-term facts about an end user (Memory nodes). */
  memory?: {
    read(endUserId: string, query: string, topK: number): Promise<string[]>;
    write(endUserId: string, facts: string[]): Promise<void>;
  };
}

/** Runs a child flow to completion and returns its End output (used by Subflow nodes). */
export type RunChild = (flowId: string, useDraft: boolean, input: Record<string, unknown>) => Promise<unknown>;

export type StepMeta = {
  input?: unknown;
  promptRedacted?: string;
  model?: string;
  tokensIn?: number;
  tokensOut?: number;
  costUsd?: number | null;
};

export type NodeContext = {
  runId: string;
  workspaceId: string;
  services: RuntimeServices;
  runChild: RunChild;
  flow: Flow;
  state: RunState;
  scope: () => Record<string, unknown>;
  gateway: LLMGateway;
  tools: ToolProvider;
  fetch: typeof fetch;
  emit: (event: RunEvent) => void;
  signal: AbortSignal;
  /** Adds trace details (prompt, model, tokens, cost) to the current step. */
  meta: (meta: StepMeta) => void;
};

export interface NodeHandler<N extends NodeDef = NodeDef> {
  type: N["type"];
  run(ctx: NodeContext, node: N): Promise<NodeResult>;
}
