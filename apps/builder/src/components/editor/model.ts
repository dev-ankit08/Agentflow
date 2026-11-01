import type { Edge, Node } from "@xyflow/react";
import {
  NodeDef as NodeSchema,
  fixedHandles,
  type EdgeDef,
  type FlowInput,
  type ModelRef,
  type NodeDef,
  type NodeType,
} from "@agentflow/flow-schema";

export type ConnectorTool = { name: string; description: string; inputSchema: Record<string, unknown>; mode: string };
export type ConnectorSummary = { id: string; name: string; toolCatalog: ConnectorTool[] };

export type NodeData = { node: NodeDef; status?: "running" | "ok" | "error"; issues?: number; comments?: number };
export type FlowNode = Node<NodeData, "af">;

type Meta = {
  label: string;
  category: "Triggers" | "AI" | "Logic" | "Data" | "People" | "Output";
  color: string;
  icon: string;
  hint: string;
};

export const nodeMeta: Record<NodeType, Meta> = {
  start: {
    label: "Start",
    category: "Triggers",
    color: "#64748b",
    icon: "▶",
    hint: "Where a conversation or request enters the flow",
  },
  agent: {
    label: "AI Agent",
    category: "AI",
    color: "#7c3aed",
    icon: "✦",
    hint: "A model with its own prompt, tools and output schema",
  },
  decision: { label: "Decision", category: "Logic", color: "#d97706", icon: "◆", hint: "Branch on conditions" },
  assignment: {
    label: "Assignment",
    category: "Logic",
    color: "#ca8a04",
    icon: "=",
    hint: "Set or calculate variables",
  },
  mcp_tool: {
    label: "MCP Tool",
    category: "Data",
    color: "#0d9488",
    icon: "⚡",
    hint: "Call a tool on a connected MCP server",
  },
  http: { label: "HTTP Request", category: "Data", color: "#0891b2", icon: "⇄", hint: "Call any REST API" },
  end: { label: "End", category: "Output", color: "#475569", icon: "■", hint: "Reply to the user and tag the outcome" },
  knowledge: {
    label: "Knowledge",
    category: "Data",
    color: "#059669",
    icon: "📚",
    hint: "Find passages in your documents for an agent to answer from",
  },
  approval: {
    label: "Approval",
    category: "People",
    color: "#e11d48",
    icon: "✋",
    hint: "Pause until a team member approves or rejects",
  },
  handoff: {
    label: "Handoff",
    category: "People",
    color: "#be123c",
    icon: "🙋",
    hint: "Hand the conversation to a person, with a summary",
  },
  guardrail: {
    label: "Guardrail",
    category: "Logic",
    color: "#b45309",
    icon: "🛡",
    hint: "Check for personal data, prompt injection or blocked topics",
  },
  subflow: {
    label: "Subflow",
    category: "Logic",
    color: "#6d28d9",
    icon: "↳",
    hint: "Run another flow like a function",
  },
  form: {
    label: "Form",
    category: "People",
    color: "#db2777",
    icon: "☰",
    hint: "Ask the user for structured details",
  },
  supervisor: {
    label: "Supervisor",
    category: "AI",
    color: "#9333ea",
    icon: "♛",
    hint: "An agent that delegates to specialist agents and combines their answers",
  },
  parallel: {
    label: "Parallel",
    category: "AI",
    color: "#a855f7",
    icon: "⫴",
    hint: "Ask several agents at once and collect every answer",
  },
  loop: {
    label: "Loop",
    category: "Logic",
    color: "#ea580c",
    icon: "↻",
    hint: "Repeat steps for each item in a list",
  },
  wait: {
    label: "Wait",
    category: "Logic",
    color: "#78716c",
    icon: "⏱",
    hint: "Pause for a while or until a date, then continue",
  },
  memory: {
    label: "Memory",
    category: "Data",
    color: "#0f766e",
    icon: "🧠",
    hint: "Remember facts about a signed-in customer across conversations",
  },
};

export const paletteGroups: { title: Meta["category"]; types: NodeType[] }[] = [
  { title: "AI", types: ["agent", "supervisor", "parallel"] },
  { title: "Logic", types: ["decision", "assignment", "loop", "wait", "guardrail", "subflow"] },
  { title: "Data", types: ["knowledge", "memory", "mcp_tool", "http"] },
  { title: "People", types: ["approval", "form", "handoff"] },
  { title: "Output", types: ["end"] },
];

export const providerLabels: Record<ModelRef["provider"], string> = {
  anthropic: "Anthropic (Claude)",
  openai: "OpenAI",
  azure_openai: "Azure OpenAI",
  openai_compatible: "OpenAI-compatible",
  bedrock: "AWS Bedrock",
  vertex: "Google Vertex (Gemini)",
};

export const modelSuggestions: Record<ModelRef["provider"], string[]> = {
  anthropic: ["claude-sonnet-5-5", "claude-haiku-5-5", "claude-opus-5-5"],
  openai: ["gpt-5", "gpt-5-mini"],
  azure_openai: ["your-deployment-name"],
  openai_compatible: ["mock-1", "llama3.1"],
  bedrock: ["anthropic.claude-3-5-sonnet-20240620-v1:0", "amazon.nova-pro-v1:0"],
  vertex: ["gemini-2.5-flash", "gemini-2.5-pro"],
};

export function defaultModel(providers: string[]): ModelRef {
  const provider = (providers[0] ?? "anthropic") as ModelRef["provider"];
  return { provider, name: modelSuggestions[provider][0] ?? "" };
}

export function newNode(type: NodeType, id: string, position: { x: number; y: number }, providers: string[]): NodeDef {
  const label = nodeMeta[type].label;
  switch (type) {
    case "start":
      return { id, type, label, position, config: {} };
    case "agent":
      return {
        id,
        type,
        label: "Agent",
        position,
        config: {
          model: defaultModel(providers),
          systemPrompt: "You are a helpful assistant.",
          userPrompt: "{{trigger.message}}",
        },
      };
    case "decision":
      return {
        id,
        type,
        label,
        position,
        config: { outcomes: [{ id: "yes", condition: "true" }], defaultOutcome: "otherwise" },
      };
    case "assignment":
      return { id, type, label, position, config: { assignments: [{ variable: "result", value: '""' }] } };
    case "mcp_tool":
      return { id, type, label, position, config: { connectorId: "", tool: "", args: {} } };
    case "http":
      return { id, type, label, position, config: { method: "GET", url: "https://" } };
    case "end":
      return { id, type, label, position, config: { message: "", outcome: "resolved" } };
    case "knowledge":
      return {
        id,
        type,
        label: "Search knowledge",
        position,
        config: { sources: [], query: "trigger.message", topK: 4 },
      };
    case "approval":
      return {
        id,
        type,
        label,
        position,
        config: {
          message: "Please approve: {{trigger.message}}",
          pendingMessage: "Thanks — a team member is reviewing this and I'll reply here shortly.",
          approverRole: "reviewer",
          timeoutMinutes: 1440,
        },
      };
    case "handoff":
      return {
        id,
        type,
        label: "Hand to a human",
        position,
        config: { queue: "support", message: "I've passed this to our team — someone will get back to you shortly." },
      };
    case "guardrail":
      return {
        id,
        type,
        label: "Safety check",
        position,
        config: {
          input: "{{trigger.message}}",
          checks: { pii: true, injection: true, blockedTopics: [] },
          action: "block",
        },
      };
    case "subflow":
      return { id, type, label, position, config: { flowId: "", inputs: {}, useDraft: false } };
    case "form":
      return {
        id,
        type,
        label: "Ask for details",
        position,
        config: {
          title: "Could you share a few details?",
          fields: [{ name: "email", label: "Email", type: "email", required: true }],
          submitLabel: "Submit",
        },
      };
    case "supervisor":
      return {
        id,
        type,
        label: "Coordinator",
        position,
        config: {
          model: defaultModel(providers),
          instructions: "You coordinate a team of specialists to resolve the customer's request.",
          task: "{{trigger.message}}",
          workers: [
            {
              id: "researcher",
              name: "Researcher",
              description: "Finds facts and data needed to answer",
              systemPrompt: "You research the question and report the facts you find.",
            },
            {
              id: "writer",
              name: "Writer",
              description: "Writes a clear, friendly reply for the customer",
              systemPrompt: "You write concise, friendly replies.",
            },
          ],
          maxSteps: 6,
        },
      };
    case "parallel": {
      const model = defaultModel(providers);
      return {
        id,
        type,
        label: "Ask in parallel",
        position,
        config: {
          tasks: [
            {
              id: "a",
              label: "Perspective A",
              model,
              systemPrompt: "You are a careful analyst.",
              userPrompt: "{{trigger.message}}",
            },
            {
              id: "b",
              label: "Perspective B",
              model,
              systemPrompt: "You are a creative strategist.",
              userPrompt: "{{trigger.message}}",
            },
          ],
        },
      };
    }
    case "loop":
      return {
        id,
        type,
        label: "For each",
        position,
        config: { items: "trigger.items", itemVariable: "item", maxIterations: 20 },
      };
    case "wait":
      return { id, type, label: "Wait", position, config: { minutes: 60 } };
    case "memory":
      return {
        id,
        type,
        label: "Recall customer",
        position,
        config: { mode: "read", query: "trigger.message", topK: 5 },
      };
  }
}

/** A unique, formula-friendly id like `agent_2`. */
export function uniqueId(base: string, taken: Set<string>) {
  const clean =
    base
      .toLowerCase()
      .replace(/[^a-z0-9_]+/g, "_")
      .replace(/^([^a-z_])/, "n_$1") || "node";
  if (!taken.has(clean)) return clean;
  for (let i = 2; ; i++) if (!taken.has(`${clean}_${i}`)) return `${clean}_${i}`;
}

export function outputHandles(node: NodeDef): { id: string; label: string }[] | null {
  if (node.type !== "decision") return fixedHandles[node.type]?.map((id) => ({ id, label: id })) ?? null;
  return [
    ...node.config.outcomes.map((o) => ({ id: o.id, label: o.label || o.id })),
    { id: node.config.defaultOutcome, label: `${node.config.defaultOutcome} (default)` },
  ];
}

export function toCanvas(flow: FlowInput): { nodes: FlowNode[]; edges: Edge[] } {
  // Stored drafts use the schema's input shape; parsing fills defaults (tool args, guardrail checks, …).
  const nodes = flow.nodes.map((n) => {
    const parsed = NodeSchema.safeParse(n);
    return parsed.success ? parsed.data : (n as NodeDef);
  });
  return {
    nodes: nodes.map((n) => ({
      id: n.id,
      type: "af" as const,
      position: n.position,
      data: { node: n },
      deletable: n.type !== "start",
    })),
    edges: flow.edges.map(edgeToCanvas(nodes)),
  };
}

export const edgeToCanvas =
  (nodes: NodeDef[]) =>
  (e: EdgeDef): Edge => {
    const source = nodes.find((n) => n.id === e.source);
    const label = source && outputHandles(source) ? e.sourceHandle : undefined;
    return {
      id: e.id,
      source: e.source,
      target: e.target,
      sourceHandle: e.sourceHandle ?? null,
      label,
      type: "smoothstep",
    };
  };

export function fromCanvas(base: FlowInput, nodes: FlowNode[], edges: Edge[]): FlowInput {
  return {
    ...base,
    nodes: nodes.map((n) => ({
      ...n.data.node,
      position: { x: Math.round(n.position.x), y: Math.round(n.position.y) },
    })),
    edges: edges.map((e) => ({
      id: e.id,
      source: e.source,
      target: e.target,
      ...(e.sourceHandle ? { sourceHandle: e.sourceHandle } : {}),
    })),
  };
}

/** Variables available to `{{ }}` templates and formulas at a given point of the flow. */
export function variableSuggestions(flow: FlowInput, forNodeId?: string): { path: string; hint: string }[] {
  const out: { path: string; hint: string }[] = [
    { path: "trigger.message", hint: "the user's message" },
    { path: "user.id", hint: "signed-in end user" },
    { path: "user.email", hint: "signed-in end user" },
    { path: "conversation.turn", hint: "number of user messages" },
  ];
  for (const v of flow.variables ?? []) out.push({ path: v.name, hint: `flow variable (${v.type})` });
  for (const n of flow.nodes) {
    if (n.id === forNodeId) continue;
    switch (n.type) {
      case "agent": {
        out.push({ path: `${n.id}.text`, hint: `${n.label}: reply text` });
        const props = (n.config.outputSchema?.properties ?? {}) as Record<string, unknown>;
        for (const key of Object.keys(props))
          out.push({ path: `${n.id}.output.${key}`, hint: `${n.label}: structured output` });
        break;
      }
      case "mcp_tool":
        out.push({ path: `${n.id}.result`, hint: `${n.label}: tool result` });
        break;
      case "http":
        out.push(
          { path: `${n.id}.response`, hint: `${n.label}: response body` },
          { path: `${n.id}.status`, hint: `${n.label}: HTTP status` },
        );
        break;
      case "decision":
        out.push({ path: `${n.id}.outcome`, hint: `${n.label}: chosen outcome` });
        break;
      case "assignment":
        for (const a of n.config.assignments)
          if (a.variable && !out.some((o) => o.path === a.variable))
            out.push({ path: a.variable, hint: `set by ${n.label}` });
        break;
      case "knowledge":
        out.push(
          { path: `${n.id}.context`, hint: `${n.label}: passages to put in a prompt` },
          { path: `${n.id}.found`, hint: `${n.label}: number of passages found` },
        );
        break;
      case "approval":
        out.push(
          { path: `${n.id}.decision`, hint: `${n.label}: approved, rejected or timeout` },
          { path: `${n.id}.note`, hint: `${n.label}: approver's note` },
        );
        break;
      case "guardrail":
        out.push(
          { path: `${n.id}.text`, hint: `${n.label}: checked (redacted) text` },
          { path: `${n.id}.violations`, hint: `${n.label}: rules that failed` },
        );
        break;
      case "form":
        for (const f of n.config.fields ?? []) out.push({ path: `${n.id}.${f.name}`, hint: `${n.label}: ${f.label}` });
        break;
      case "subflow":
        out.push({ path: `${n.id}`, hint: `${n.label}: the subflow's End output` });
        break;
      case "supervisor":
        out.push(
          { path: `${n.id}.text`, hint: `${n.label}: final answer` },
          { path: `${n.id}.path`, hint: `${n.label}: specialists used, in order` },
        );
        break;
      case "parallel":
        for (const t of n.config.tasks) out.push({ path: `${n.id}.${t.id}`, hint: `${n.label}: ${t.label}` });
        out.push({ path: `${n.id}.combined`, hint: `${n.label}: all answers with headings` });
        break;
      case "loop":
        out.push(
          { path: n.config.itemVariable ?? "item", hint: `${n.label}: current item` },
          { path: `${n.config.itemVariable ?? "item"}_index`, hint: `${n.label}: position (from 0)` },
          { path: `${n.id}.results`, hint: `${n.label}: collected results` },
        );
        break;
      case "memory":
        out.push(
          n.config.mode === "read"
            ? { path: `${n.id}.text`, hint: `${n.label}: remembered facts, one per line` }
            : { path: `${n.id}.stored`, hint: `${n.label}: number of facts saved` },
        );
        break;
    }
  }
  return out;
}

/** Simple left-to-right layered layout (breadth-first from Start). */
export function autoLayout(nodes: FlowNode[], edges: Edge[]): FlowNode[] {
  const start = nodes.find((n) => n.data.node.type === "start") ?? nodes[0];
  if (!start) return nodes;
  const depth = new Map<string, number>([[start.id, 0]]);
  const queue = [start.id];
  while (queue.length) {
    const id = queue.shift()!;
    for (const e of edges.filter((e) => e.source === id)) {
      if (!depth.has(e.target)) {
        depth.set(e.target, depth.get(id)! + 1);
        queue.push(e.target);
      }
    }
  }
  const maxDepth = Math.max(0, ...depth.values());
  const rows = new Map<number, number>();
  return nodes.map((n) => {
    const d = depth.get(n.id) ?? maxDepth + 1;
    const row = rows.get(d) ?? 0;
    rows.set(d, row + 1);
    return { ...n, position: { x: d * 280, y: row * 150 } };
  });
}
