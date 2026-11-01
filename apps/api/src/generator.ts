import type { FlowInput, ModelRef } from "@agentflow/flow-schema";
import { orderSupportFlow, validateFlow, type Issue } from "@agentflow/flow-schema";
import type { ChatMessage, LLMGateway } from "@agentflow/llm-gateway";

/** What each node type is for and its config fields, kept short so the whole catalogue fits in one prompt. */
const CATALOG = `Node types (type: config fields):
- start: {} — exactly one; where a chat message or request enters. The message is {{trigger.message}}.
- agent: { model, systemPrompt, userPrompt, outputSchema?, tools?, contextRules? } — an LLM step. Reply text is {{<id>.text}}; with outputSchema (JSON Schema object) fields are {{<id>.output.<field>}}. contextRules is a YAML string of rules that pick context from variables without AI, e.g. a rule with when: order.total > 500 and include: High-value order., or a rule with switch: order.status and cases per status.
  include: VIP customer." or "- switch: order.status
  cases: { shipped: ..., processing: ... }".
- decision: { outcomes: [{ id, label?, condition }], defaultOutcome } — branches; each outcome id and defaultOutcome is a sourceHandle.
- assignment: { assignments: [{ variable, value }] } — set variables; value is a formula.
- knowledge: { sources: [], query, topK } — search documents; passages are {{<id>.context}}.
- mcp_tool: { connectorId, tool, args } — call a connector tool (leave connectorId "" if unknown).
- http: { method, url, headers?, body? } — call a REST API.
- guardrail: { input, checks: { pii, injection, blockedTopics: [] }, action: "block" } — handles "pass" and "fail".
- approval: { message, pendingMessage, approverRole: "reviewer", timeoutMinutes } — handles "approved", "rejected", "timeout".
- form: { title, fields: [{ name, label, type: "text"|"email"|"number"|"select"|"textarea", required }], submitLabel } — values are {{<id>.<field>}}.
- handoff: { queue, message } — hand to a person; ends the run (no outgoing edge).
- supervisor: { model, instructions, task, workers: [{ id, name, description, systemPrompt }], maxSteps } — delegates to specialists.
- parallel: { tasks: [{ id, label, model, systemPrompt, userPrompt }] } — at least 2 agents at once.
- loop: { items, itemVariable, maxIterations } — handles "each" (body; connect the body's last node back to the loop) and "done".
- wait: { minutes } — pause, then continue.
- memory: { mode: "read"|"write"|"extract", query?, facts?, model?, topK } — customer memory.
- end: { message?, outcome?: "resolved"|"escalated"|"converted"|"failed", output? } — reply and finish (no outgoing edge).

Rules:
- Node ids are short snake_case names used in variables (e.g. "triage"); a node id must not equal a variable name.
- Every node except end/handoff has exactly one outgoing edge, or one per handle for decision, approval, guardrail and loop (use sourceHandle).
- Templates (prompts, messages) use {{var}}; formulas (conditions, assignment values, query, items) are written WITHOUT braces, e.g. triage.output.intent == "refund".
- Use the given model for every agent, supervisor, parallel task and memory extraction.`;

const SYSTEM = (model: ModelRef) => `You design AgentFlow flows: multi-agent workflows drawn as nodes and edges.
Return only a JSON object { "name": string, "nodes": [...], "edges": [...], "variables"?: [...] } — no prose.
Each node: { "id", "type", "label", "config" }. Each edge: { "id", "source", "target", "sourceHandle"? }.
Use model ${JSON.stringify(model)}.

${CATALOG}

Example of a valid flow:
${JSON.stringify({ name: orderSupportFlow.name, nodes: orderSupportFlow.nodes.map(({ position: _p, ...n }) => n), edges: orderSupportFlow.edges })}`;

type Raw = { name?: unknown; nodes?: unknown; edges?: unknown; variables?: unknown };
const MODEL_TYPES = new Set(["agent", "supervisor"]);

/** Fills what the model tends to leave out: positions (layered layout), ids, the chosen model, a Start node. */
export function normalise(raw: Raw, flowId: string, fallbackName: string, model: ModelRef): FlowInput {
  const nodes = (Array.isArray(raw.nodes) ? raw.nodes : []).filter(
    (n): n is Record<string, unknown> => Boolean(n) && typeof n === "object",
  );
  const edges = (Array.isArray(raw.edges) ? raw.edges : [])
    .filter((e): e is Record<string, unknown> => Boolean(e) && typeof e === "object")
    .map((e, i): Record<string, unknown> & { id: string } => ({
      ...e,
      id: typeof e.id === "string" && e.id ? e.id : `e${i + 1}`,
    }));
  if (!nodes.some((n) => n.type === "start")) nodes.unshift({ id: "start", type: "start", label: "Start", config: {} });
  for (const n of nodes) {
    n.config = n.config && typeof n.config === "object" ? n.config : {};
    n.label = typeof n.label === "string" && n.label ? n.label : String(n.id ?? n.type);
    const c = n.config as Record<string, unknown>;
    if (MODEL_TYPES.has(String(n.type))) c.model = model;
    if (n.type === "parallel" && Array.isArray(c.tasks))
      for (const t of c.tasks as Record<string, unknown>[]) t.model = model;
    if (n.type === "memory" && c.mode === "extract") c.model = model;
  }
  // Layered layout: breadth-first from Start, left to right.
  const depth = new Map<string, number>([[String(nodes.find((n) => n.type === "start")!.id), 0]]);
  const queue = [...depth.keys()];
  while (queue.length) {
    const id = queue.shift()!;
    for (const e of edges.filter((e) => e.source === id)) {
      const target = String(e.target);
      if (!depth.has(target)) {
        depth.set(target, depth.get(id)! + 1);
        queue.push(target);
      }
    }
  }
  const rows = new Map<number, number>();
  const maxDepth = Math.max(0, ...depth.values());
  for (const n of nodes) {
    const d = depth.get(String(n.id)) ?? maxDepth + 1;
    const row = rows.get(d) ?? 0;
    rows.set(d, row + 1);
    n.position = { x: d * 280, y: row * 160 };
  }
  return {
    schemaVersion: 1,
    id: flowId,
    name: typeof raw.name === "string" && raw.name.trim() ? raw.name.trim().slice(0, 120) : fallbackName,
    nodes: nodes as FlowInput["nodes"],
    edges: edges as FlowInput["edges"],
    ...(Array.isArray(raw.variables) && { variables: raw.variables as FlowInput["variables"] }),
  };
}

const OUTPUT_SCHEMA = {
  type: "object",
  properties: { name: { type: "string" }, nodes: { type: "array" }, edges: { type: "array" } },
  required: ["nodes", "edges"],
};

/**
 * Turns a plain-language description into a draft flow (AI-1). Invalid results are sent back to the model with
 * the validator's errors, up to `repairs` times; the last attempt is returned either way with its issues.
 */
export async function generateFlow(
  gateway: LLMGateway,
  input: { description: string; model: ModelRef; flowId: string; name?: string },
  repairs = 2,
) {
  const messages: ChatMessage[] = [
    { role: "system", content: SYSTEM(input.model) },
    { role: "user", content: input.description },
  ];
  let draft: FlowInput | null = null;
  let issues: Issue[] = [];
  let attempts = 0;
  let costUsd = 0;
  for (; attempts <= repairs;) {
    attempts++;
    const res = await gateway.chat(
      input.model,
      { messages, maxTokens: 4000, temperature: 0.2, signal: AbortSignal.timeout(90_000) },
      { outputSchema: OUTPUT_SCHEMA },
    );
    costUsd += res.costUsd ?? 0;
    draft = normalise((res.json ?? {}) as Raw, input.flowId, input.name ?? "Generated flow", input.model);
    if (input.name) draft.name = input.name;
    const result = validateFlow(draft);
    issues = result.errors;
    if (result.ok) break;
    messages.push(
      { role: "assistant", content: JSON.stringify({ name: draft.name, nodes: draft.nodes, edges: draft.edges }) },
      {
        role: "user",
        content: `That flow has these problems:\n${issues
          .slice(0, 20)
          .map((i) => `- ${i.message}${i.nodeId ? ` (node ${i.nodeId})` : ""}${i.path ? ` [${i.path}]` : ""}`)
          .join("\n")}\nReturn the corrected flow as the same JSON object.`,
      },
    );
  }
  return { draft: draft!, issues, attempts, costUsd };
}
