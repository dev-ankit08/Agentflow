import { checkContextRules, checkFormula, checkTemplate } from "@agentflow/expression-engine";
import { parseCron } from "./cron";
import { Flow, fixedHandles, terminalTypes, type NodeDef } from "./schema";

const isTerminal = (node: NodeDef) => (terminalTypes as readonly string[]).includes(node.type);

export type Issue = { message: string; path?: string; nodeId?: string; edgeId?: string };
export type ValidationResult =
  | { ok: true; flow: Flow; errors: []; warnings: Issue[] }
  | { ok: false; flow?: Flow; errors: Issue[]; warnings: Issue[] };

const SECRET_IN_TEMPLATE = /\{\{[^}]*\bsecret\./;

/** Prompt/message templates on a node, where secrets must never appear. */
function templateFields(node: NodeDef): [string, string][] {
  switch (node.type) {
    case "agent":
      return [
        ["config.systemPrompt", node.config.systemPrompt],
        ["config.userPrompt", node.config.userPrompt],
      ];
    case "end":
      return node.config.message ? [["config.message", node.config.message]] : [];
    case "approval":
      return [
        ["config.message", node.config.message],
        ["config.pendingMessage", node.config.pendingMessage],
      ];
    case "handoff":
      return [["config.message", node.config.message]];
    case "guardrail":
      return [["config.input", node.config.input]];
    case "form":
      return [["config.title", node.config.title]];
    case "supervisor":
      return [
        ["config.instructions", node.config.instructions],
        ["config.task", node.config.task],
        ...node.config.workers.map((w, i): [string, string] => [`config.workers.${i}.systemPrompt`, w.systemPrompt]),
      ];
    case "parallel":
      return node.config.tasks.flatMap((t, i): [string, string][] => [
        [`config.tasks.${i}.systemPrompt`, t.systemPrompt],
        [`config.tasks.${i}.userPrompt`, t.userPrompt],
      ]);
    default:
      return [];
  }
}

/** HTTP request templates, which may reference secrets. */
function httpTemplateFields(node: NodeDef): [string, string][] {
  if (node.type !== "http") return [];
  return [
    ["config.url", node.config.url],
    ...Object.entries(node.config.headers ?? {}).map(([k, v]): [string, string] => [`config.headers.${k}`, v]),
    ...(node.config.body ? [["config.body", node.config.body] as [string, string]] : []),
  ];
}

/** Formula fields, which are written without `{{ }}`. */
function formulaFields(node: NodeDef): [string, string][] {
  switch (node.type) {
    case "decision":
      return node.config.outcomes.map((o, i) => [`config.outcomes.${i}.condition`, o.condition]);
    case "assignment":
      return node.config.assignments.map((a, i) => [`config.assignments.${i}.value`, a.value]);
    case "mcp_tool":
      return Object.entries(node.config.args).map(([k, v]) => [`config.args.${k}`, v]);
    case "end":
      return Object.entries(node.config.output ?? {}).map(([k, v]) => [`config.output.${k}`, v]);
    case "knowledge":
      return [["config.query", node.config.query]];
    case "subflow":
      return Object.entries(node.config.inputs).map(([k, v]) => [`config.inputs.${k}`, v]);
    case "loop":
      return [
        ["config.items", node.config.items],
        ...(node.config.collect ? [["config.collect", node.config.collect] as [string, string]] : []),
      ];
    case "wait":
      return node.config.until ? [["config.until", node.config.until]] : [];
    case "memory":
      return [
        ...(node.config.query ? [["config.query", node.config.query] as [string, string]] : []),
        ...(node.config.facts ? [["config.facts", node.config.facts] as [string, string]] : []),
      ];
    default:
      return [];
  }
}

/** Context rules (YAML) on AI steps. */
function contextRuleFields(node: NodeDef): [string, string][] {
  const out: [string, string][] = [];
  const add = (path: string, src: string | undefined) => {
    if (src?.trim()) out.push([path, src]);
  };
  if (node.type === "agent") add("config.contextRules", node.config.contextRules);
  if (node.type === "supervisor") {
    add("config.contextRules", node.config.contextRules);
    node.config.workers.forEach((w, i) => add(`config.workers.${i}.contextRules`, w.contextRules));
  }
  if (node.type === "parallel")
    node.config.tasks.forEach((t, i) => add(`config.tasks.${i}.contextRules`, t.contextRules));
  return out;
}

function outputHandles(node: NodeDef): string[] | null {
  if (node.type === "decision") return [...node.config.outcomes.map((o) => o.id), node.config.defaultOutcome];
  return fixedHandles[node.type] ?? null;
}

/**
 * Structural validation of a flow: schema, graph shape and authoring rules.
 * Errors block publishing; warnings are shown in the builder.
 */
export function validateFlow(input: unknown): ValidationResult {
  const parsed = Flow.safeParse(input);
  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map((i) => ({ message: i.message, path: i.path.join(".") })),
      warnings: [],
    };
  }
  const flow = parsed.data;
  const errors: Issue[] = [];
  const warnings: Issue[] = [];

  const nodes = new Map<string, NodeDef>();
  for (const node of flow.nodes) {
    if (nodes.has(node.id)) errors.push({ message: `Duplicate node id "${node.id}"`, nodeId: node.id });
    nodes.set(node.id, node);
  }
  const edgeIds = new Set<string>();
  for (const edge of flow.edges) {
    if (edgeIds.has(edge.id)) errors.push({ message: `Duplicate edge id "${edge.id}"`, edgeId: edge.id });
    edgeIds.add(edge.id);
  }

  const starts = flow.nodes.filter((n) => n.type === "start");
  if (starts.length !== 1) errors.push({ message: `A flow needs exactly one Start node (found ${starts.length})` });

  const outgoing = new Map<string, string[]>();
  for (const edge of flow.edges) {
    const source = nodes.get(edge.source);
    const target = nodes.get(edge.target);
    if (!source) errors.push({ message: `Edge "${edge.id}" starts at unknown node "${edge.source}"`, edgeId: edge.id });
    if (!target) errors.push({ message: `Edge "${edge.id}" ends at unknown node "${edge.target}"`, edgeId: edge.id });
    if (!source || !target) continue;

    if (isTerminal(source)) {
      errors.push({ message: `"${source.label}" ends the run and cannot have outgoing connections`, edgeId: edge.id });
    }
    if (target.type === "start")
      errors.push({ message: "Start nodes cannot have incoming connections", edgeId: edge.id });

    const handles = outputHandles(source);
    if (handles && (!edge.sourceHandle || !handles.includes(edge.sourceHandle))) {
      errors.push({ message: `Connection from "${source.label}" must use one of its outcomes`, edgeId: edge.id });
    }

    const list = outgoing.get(source.id) ?? [];
    list.push(edge.sourceHandle ?? "");
    outgoing.set(source.id, list);
  }

  for (const node of flow.nodes) {
    const outs = outgoing.get(node.id) ?? [];
    const handles = outputHandles(node);
    if (handles) {
      for (const h of new Set(handles)) {
        const count = outs.filter((o) => o === h).length;
        if (count === 0)
          errors.push({ message: `Outcome "${h}" of "${node.label}" is not connected`, nodeId: node.id });
        if (count > 1)
          errors.push({ message: `Outcome "${h}" of "${node.label}" has several connections`, nodeId: node.id });
      }
      if (new Set(handles).size !== handles.length) {
        errors.push({ message: "Outcome ids must be unique (including the default)", nodeId: node.id });
      }
    } else if (!isTerminal(node)) {
      if (outs.length === 0) errors.push({ message: `"${node.label}" has no outgoing connection`, nodeId: node.id });
      if (outs.length > 1)
        errors.push({ message: `"${node.label}" can only have one outgoing connection`, nodeId: node.id });
    }

    for (const [path, value] of templateFields(node)) {
      if (SECRET_IN_TEMPLATE.test(value)) {
        errors.push({ message: "Secrets cannot be used in prompts or messages", nodeId: node.id, path });
      }
    }
    for (const [path, value] of [...templateFields(node), ...httpTemplateFields(node)]) {
      for (const issue of checkTemplate(value)) errors.push({ message: issue.message, nodeId: node.id, path });
    }
    for (const [path, value] of contextRuleFields(node)) {
      if (SECRET_IN_TEMPLATE.test(value)) {
        errors.push({ message: "Secrets cannot be used in context rules", nodeId: node.id, path });
      }
      for (const issue of checkContextRules(value)) {
        errors.push({ message: `Context rules, line ${issue.line}: ${issue.message}`, nodeId: node.id, path });
      }
    }
    for (const [path, value] of formulaFields(node)) {
      if (value.includes("{{")) {
        errors.push({ message: "Formulas are written without {{ }}", nodeId: node.id, path });
        continue;
      }
      const issue = checkFormula(value);
      if (issue) errors.push({ message: `Formula error: ${issue.message}`, nodeId: node.id, path });
    }
  }

  // Node outputs and variables share one namespace in formulas ({{score}}), and node outputs win,
  // so a node named like a variable would silently hide the variable.
  const variableNames = new Set(flow.variables.map((v) => v.name));
  for (const node of flow.nodes) {
    if (node.type === "assignment") for (const a of node.config.assignments) variableNames.add(a.variable);
    if (node.type === "loop") variableNames.add(node.config.itemVariable).add(`${node.config.itemVariable}_index`);
  }
  for (const node of flow.nodes) {
    if (variableNames.has(node.id)) {
      errors.push({
        message: `Node id "${node.id}" is also a variable name; rename the node so {{${node.id}}} is unambiguous`,
        nodeId: node.id,
      });
    }
  }

  // Schedules must be valid cron expressions.
  flow.triggers.forEach((t, i) => {
    if (t.type !== "schedule") return;
    try {
      parseCron(String(t.config.cron ?? ""));
    } catch (e) {
      errors.push({ message: `Schedule: ${(e as Error).message}`, path: `triggers.${i}.config.cron` });
    }
  });

  // Reachability and cycles. The only allowed cycle is a Loop body connecting back to its Loop node.
  const start = starts[0];
  if (start) {
    const adjacency = new Map<string, string[]>();
    for (const e of flow.edges) adjacency.set(e.source, [...(adjacency.get(e.source) ?? []), e.target]);
    const state = new Map<string, "visiting" | "done">();
    let cycle = false;
    const visit = (id: string) => {
      state.set(id, "visiting");
      for (const next of adjacency.get(id) ?? []) {
        const s = state.get(next);
        if (s === "visiting") {
          if (nodes.get(next)?.type !== "loop") cycle = true;
        } else if (!s && nodes.has(next)) visit(next);
      }
      state.set(id, "done");
    };
    visit(start.id);
    if (cycle) errors.push({ message: "Connections can only loop back into a Loop node" });
    for (const node of flow.nodes) {
      if (!state.has(node.id))
        warnings.push({ message: `"${node.label}" is not reachable from Start`, nodeId: node.id });
    }
    for (const node of flow.nodes) {
      if (node.type !== "loop") continue;
      const incoming = flow.edges.filter((e) => e.target === node.id).length;
      if (incoming < 2) {
        warnings.push({ message: `Connect the end of "${node.label}"'s body back to the Loop`, nodeId: node.id });
      }
    }
  }

  if (errors.length) return { ok: false, flow, errors, warnings };
  return { ok: true, flow, errors: [], warnings };
}
