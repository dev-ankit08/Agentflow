import { z } from "zod";

export const SCHEMA_VERSION = 1 as const;

/** Formula fields (conditions, tool args, assignments) are written without `{{ }}`. */
const formula = z.string().min(1, "Formula is required");
/** Text templates (prompts, messages) may contain `{{expr}}` and `{{#if}}` blocks. */
const template = z.string();

export const variableTypes = ["text", "number", "boolean", "date", "object", "list", "file"] as const;
export const VariableType = z.enum(variableTypes);

export const VariableDef = z.object({
  name: z.string().regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/, "Use letters, digits and underscores; start with a letter"),
  type: VariableType,
  default: z.unknown().optional(),
  description: z.string().optional(),
  isInput: z.boolean().optional(),
  isOutput: z.boolean().optional(),
});

export const providers = ["anthropic", "openai", "azure_openai", "openai_compatible", "bedrock", "vertex"] as const;
export const ModelRef = z.object({
  provider: z.enum(providers),
  name: z.string().min(1),
});

/**
 * How runs start besides chat: `schedule` (config.cron, 5 fields in UTC; config.input is the trigger input) and
 * `webhook` (POST to the flow's webhook URL; the JSON body is the trigger input).
 */
export const TriggerDef = z.object({
  type: z.enum(["chat", "webhook", "schedule", "email", "crm_event", "file_drop"]),
  config: z.record(z.string(), z.unknown()).default({}),
});

const Position = z.object({ x: z.number(), y: z.number() });

const nodeBase = {
  id: z.string().regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/, "Node ids must be valid variable names (used as {{id.output}})"),
  label: z.string().min(1),
  description: z.string().optional(),
  position: Position,
  onError: z.enum(["stop", "continue", "route"]).optional(),
  timeoutMs: z.number().int().positive().optional(),
  retries: z.number().int().min(0).max(5).optional(),
};

export const StartConfig = z.looseObject({});

export const AgentConfig = z.object({
  model: ModelRef,
  fallbackModel: ModelRef.optional(),
  systemPrompt: template,
  userPrompt: template,
  temperature: z.number().min(0).max(2).optional(),
  maxTokens: z.number().int().positive().optional(),
  outputSchema: z.record(z.string(), z.unknown()).optional(),
  tools: z.array(z.string()).optional(),
  maxToolCalls: z.number().int().min(0).max(32).optional(),
  /** false: never answer this agent from the workspace response cache. */
  cache: z.boolean().optional(),
});

export const DecisionOutcome = z.object({
  id: z.string().regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/),
  label: z.string().optional(),
  condition: formula,
});
export const DecisionConfig = z.object({
  outcomes: z.array(DecisionOutcome).min(1, "Add at least one outcome"),
  defaultOutcome: z.string().regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/),
});

export const AssignmentConfig = z.object({
  assignments: z.array(z.object({ variable: z.string().min(1), value: formula })).min(1),
});

export const McpToolConfig = z.object({
  connectorId: z.string().min(1),
  tool: z.string().min(1),
  args: z.record(z.string(), formula).default({}),
  requiresApproval: z.boolean().optional(),
});

export const HttpConfig = z.object({
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
  url: template,
  headers: z.record(z.string(), template).optional(),
  body: template.optional(),
});

export const outcomeTags = ["resolved", "escalated", "converted", "failed"] as const;
export const EndConfig = z.object({
  message: template.optional(),
  output: z.record(z.string(), formula).optional(),
  outcome: z.enum(outcomeTags).optional(),
});

/** Retrieves passages from the workspace's knowledge sources (all sources when none are listed). */
export const KnowledgeConfig = z.object({
  sources: z.array(z.string()).default([]),
  query: formula.default("trigger.message"),
  topK: z.number().int().min(1).max(10).default(4),
});

/** Pauses the run until a person approves or rejects (or the timeout passes). */
export const approverRoles = ["reviewer", "admin", "builder"] as const;
export const ApprovalConfig = z.object({
  message: template,
  pendingMessage: template.default("Thanks — a team member is reviewing this and I'll reply here shortly."),
  approverRole: z.enum(approverRoles).default("reviewer"),
  timeoutMinutes: z.number().int().min(1).max(10_080).default(1440),
});

/** Hands the conversation to a human team, optionally opening a ticket through an MCP tool. */
export const HandoffConfig = z.object({
  queue: z.string().min(1).default("support"),
  message: template.default("I've passed this to our team — someone will get back to you shortly."),
  summaryModel: ModelRef.optional(),
  connectorId: z.string().optional(),
  tool: z.string().optional(),
});

/** Checks text for personal data, prompt injection, blocked topics or length. */
export const GuardrailConfig = z.object({
  input: template.default("{{trigger.message}}"),
  checks: z
    .object({
      pii: z.boolean().default(true),
      injection: z.boolean().default(true),
      blockedTopics: z.array(z.string()).default([]),
      maxLength: z.number().int().positive().optional(),
    })
    .default({ pii: true, injection: true, blockedTopics: [] }),
  action: z.enum(["block", "redact"]).default("block"),
});

/** Runs another flow as a function and returns its End output. */
export const SubflowConfig = z.object({
  flowId: z.string().min(1),
  inputs: z.record(z.string(), formula).default({}),
  useDraft: z.boolean().default(false),
});

export const formFieldTypes = ["text", "email", "number", "select"] as const;
/** Shows a form to the end user and continues with the submitted values. */
export const FormConfig = z.object({
  title: template,
  fields: z
    .array(
      z.object({
        name: z.string().regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/),
        label: z.string().min(1),
        type: z.enum(formFieldTypes).default("text"),
        options: z.array(z.string()).optional(),
        required: z.boolean().default(false),
      }),
    )
    .min(1, "Add at least one field"),
  submitLabel: z.string().min(1).default("Submit"),
});

export const StartNode = z.object({ ...nodeBase, type: z.literal("start"), config: StartConfig });
export const AgentNode = z.object({ ...nodeBase, type: z.literal("agent"), config: AgentConfig });
export const DecisionNode = z.object({ ...nodeBase, type: z.literal("decision"), config: DecisionConfig });
export const AssignmentNode = z.object({ ...nodeBase, type: z.literal("assignment"), config: AssignmentConfig });
export const McpToolNode = z.object({ ...nodeBase, type: z.literal("mcp_tool"), config: McpToolConfig });
export const HttpNode = z.object({ ...nodeBase, type: z.literal("http"), config: HttpConfig });
export const EndNode = z.object({ ...nodeBase, type: z.literal("end"), config: EndConfig });
export const KnowledgeNode = z.object({ ...nodeBase, type: z.literal("knowledge"), config: KnowledgeConfig });
export const ApprovalNode = z.object({ ...nodeBase, type: z.literal("approval"), config: ApprovalConfig });
export const HandoffNode = z.object({ ...nodeBase, type: z.literal("handoff"), config: HandoffConfig });
export const GuardrailNode = z.object({ ...nodeBase, type: z.literal("guardrail"), config: GuardrailConfig });
export const SubflowNode = z.object({ ...nodeBase, type: z.literal("subflow"), config: SubflowConfig });
export const FormNode = z.object({ ...nodeBase, type: z.literal("form"), config: FormConfig });

/** A supervisor agent that delegates to specialist worker agents (as tools) until it can answer. */
export const SupervisorConfig = z.object({
  model: ModelRef,
  instructions: template,
  task: template.default("{{trigger.message}}"),
  workers: z
    .array(
      z.object({
        id: z.string().regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/),
        name: z.string().min(1),
        description: z.string().min(1),
        systemPrompt: template,
        model: ModelRef.optional(),
        tools: z.array(z.string()).optional(),
      }),
    )
    .min(1, "Add at least one worker agent"),
  maxSteps: z.number().int().min(1).max(20).default(6),
});

/**
 * Repeats the connected body once per item: the "each" outcome leads into the body, whose last node connects
 * back to the Loop; "done" continues when every item has been processed.
 */
export const LoopConfig = z.object({
  items: formula,
  itemVariable: z
    .string()
    .regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/)
    .default("item"),
  /** Formula evaluated each time the body comes back, collected into {{loop.results}}. */
  collect: z.string().optional(),
  maxIterations: z.number().int().min(1).max(500).default(20),
});

/** Runs several agents at the same time on the same input and merges their replies. */
export const ParallelConfig = z.object({
  tasks: z
    .array(
      z.object({
        id: z.string().regex(/^[a-zA-Z_][a-zA-Z0-9_]*$/),
        label: z.string().min(1),
        model: ModelRef,
        systemPrompt: template,
        userPrompt: template.default("{{trigger.message}}"),
      }),
    )
    .min(2, "Add at least two parallel tasks"),
});

/** Pauses the run for a duration or until a time, then continues (for background flows). */
export const WaitConfig = z.object({
  minutes: z.number().min(0).max(43_200).optional(),
  /** Formula giving an ISO date/time to wait until (instead of minutes). */
  until: z.string().optional(),
});

/** Long-term memory about the end user: read facts, store facts, or extract facts from the conversation. */
export const MemoryConfig = z.object({
  mode: z.enum(["read", "write", "extract"]),
  query: z.string().optional(),
  facts: z.string().optional(),
  model: ModelRef.optional(),
  topK: z.number().int().min(1).max(20).default(5),
});

export const SupervisorNode = z.object({ ...nodeBase, type: z.literal("supervisor"), config: SupervisorConfig });
export const LoopNode = z.object({ ...nodeBase, type: z.literal("loop"), config: LoopConfig });
export const ParallelNode = z.object({ ...nodeBase, type: z.literal("parallel"), config: ParallelConfig });
export const WaitNode = z.object({ ...nodeBase, type: z.literal("wait"), config: WaitConfig });
export const MemoryNode = z.object({ ...nodeBase, type: z.literal("memory"), config: MemoryConfig });

export const NodeDef = z.discriminatedUnion("type", [
  SupervisorNode,
  LoopNode,
  ParallelNode,
  WaitNode,
  MemoryNode,
  StartNode,
  AgentNode,
  DecisionNode,
  AssignmentNode,
  McpToolNode,
  HttpNode,
  EndNode,
  KnowledgeNode,
  ApprovalNode,
  HandoffNode,
  GuardrailNode,
  SubflowNode,
  FormNode,
]);
export const nodeTypes = [
  "start",
  "agent",
  "decision",
  "assignment",
  "mcp_tool",
  "http",
  "end",
  "knowledge",
  "approval",
  "handoff",
  "guardrail",
  "subflow",
  "form",
  "supervisor",
  "loop",
  "parallel",
  "wait",
  "memory",
] as const;

/** Fixed outgoing handles of branching nodes (Decision handles come from its outcomes). */
export const fixedHandles: Partial<Record<(typeof nodeTypes)[number], string[]>> = {
  approval: ["approved", "rejected", "timeout"],
  guardrail: ["pass", "fail"],
  loop: ["each", "done"],
};
/** Nodes that end the run (no outgoing connection). */
export const terminalTypes = ["end", "handoff"] as const;

export const EdgeDef = z.object({
  id: z.string().min(1),
  source: z.string().min(1),
  sourceHandle: z.string().optional(),
  target: z.string().min(1),
});

export const FlowSettings = z.object({
  maxSteps: z.number().int().positive().max(500).default(25),
  maxCostUsd: z.number().positive().default(0.5),
  defaultModel: ModelRef.optional(),
});

export const Flow = z.object({
  schemaVersion: z.literal(SCHEMA_VERSION),
  id: z.string().min(1),
  name: z.string().min(1),
  variables: z.array(VariableDef).default([]),
  triggers: z.array(TriggerDef).default([]),
  nodes: z.array(NodeDef),
  edges: z.array(EdgeDef),
  settings: FlowSettings.default({ maxSteps: 25, maxCostUsd: 0.5 }),
});

export type VariableDef = z.infer<typeof VariableDef>;
export type ModelRef = z.infer<typeof ModelRef>;
export type TriggerDef = z.infer<typeof TriggerDef>;
export type NodeDef = z.infer<typeof NodeDef>;
export type NodeType = NodeDef["type"];
export type EdgeDef = z.infer<typeof EdgeDef>;
export type Flow = z.infer<typeof Flow>;
export type FlowInput = z.input<typeof Flow>;

const configSchemas = {
  start: StartConfig,
  agent: AgentConfig,
  decision: DecisionConfig,
  assignment: AssignmentConfig,
  mcp_tool: McpToolConfig,
  http: HttpConfig,
  end: EndConfig,
  knowledge: KnowledgeConfig,
  approval: ApprovalConfig,
  handoff: HandoffConfig,
  guardrail: GuardrailConfig,
  subflow: SubflowConfig,
  form: FormConfig,
  supervisor: SupervisorConfig,
  loop: LoopConfig,
  parallel: ParallelConfig,
  wait: WaitConfig,
  memory: MemoryConfig,
} satisfies Record<NodeType, z.ZodType>;

/** JSON Schema for a node type's config — the builder generates property forms from this. */
export function getNodeConfigJsonSchema(type: NodeType) {
  return z.toJSONSchema(configSchemas[type], { io: "input" });
}
