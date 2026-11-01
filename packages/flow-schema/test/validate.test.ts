import { describe, expect, it } from "vitest";
import {
  blankFlow,
  cronMatches,
  getNodeConfigJsonSchema,
  nextCronRun,
  nodeTypes,
  orderSupportFlow,
  parseCron,
  validateFlow,
  type FlowInput,
} from "../src";

const clone = (f: FlowInput): FlowInput => structuredClone(f);
const messages = (f: unknown) => validateFlow(f).errors.map((e) => e.message);

describe("validateFlow", () => {
  it("accepts the documented order-support example", () => {
    const result = validateFlow(orderSupportFlow);
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.warnings).toEqual([]);
  });

  it("accepts a blank flow and fills defaults", () => {
    const result = validateFlow(blankFlow("flw_1", "New flow"));
    expect(result.ok).toBe(true);
    expect(result.flow?.settings.maxSteps).toBe(25);
  });

  it("reports schema errors with paths", () => {
    const f = clone(orderSupportFlow) as Record<string, unknown>;
    f.schemaVersion = 2;
    const result = validateFlow(f);
    expect(result.ok).toBe(false);
    expect(result.errors[0]?.path).toBe("schemaVersion");
  });

  it("rejects unknown node types", () => {
    const f = clone(blankFlow("f", "f"));
    (f.nodes[1] as { type: string }).type = "teleport";
    expect(validateFlow(f).ok).toBe(false);
  });

  it("requires exactly one start node", () => {
    const f = clone(blankFlow("f", "f"));
    f.nodes = f.nodes.filter((n) => n.type !== "start");
    f.edges = [];
    expect(messages(f)).toContain("A flow needs exactly one Start node (found 0)");
  });

  it("rejects dangling edges and duplicate ids", () => {
    const f = clone(blankFlow("f", "f"));
    f.edges.push({ id: "e1", source: "start", target: "ghost" });
    const errs = messages(f);
    expect(errs).toContain('Duplicate edge id "e1"');
    expect(errs).toContain('Edge "e1" ends at unknown node "ghost"');
  });

  it("requires every decision outcome to be connected exactly once", () => {
    const f = clone(orderSupportFlow);
    f.edges = f.edges.filter((e) => e.id !== "e4");
    expect(messages(f)).toContain('Outcome "refund" of "Route" is not connected');
  });

  it("requires decision edges to use an outcome handle", () => {
    const f = clone(orderSupportFlow);
    const e3 = f.edges.find((e) => e.id === "e3")!;
    e3.sourceHandle = "nope";
    expect(messages(f)).toContain('Connection from "Route" must use one of its outcomes');
  });

  it("flags dead ends and multiple outgoing connections", () => {
    const f = clone(orderSupportFlow);
    f.edges = f.edges.filter((e) => e.id !== "e7");
    expect(messages(f)).toContain('"Answer" has no outgoing connection');
    const g = clone(orderSupportFlow);
    g.edges.push({ id: "e8", source: "triage", target: "done" });
    expect(messages(g)).toContain('"Triage" can only have one outgoing connection');
  });

  it("rejects cycles", () => {
    const f = clone(orderSupportFlow);
    f.nodes.push({
      id: "again",
      type: "assignment",
      label: "Again",
      position: { x: 0, y: 0 },
      config: { assignments: [{ variable: "order_id", value: '""' }] },
    });
    const e7 = f.edges.find((e) => e.id === "e7")!;
    e7.target = "again";
    f.edges.push({ id: "e8", source: "again", target: "triage" });
    expect(messages(f)).toContain("Connections can only loop back into a Loop node");
  });

  it("blocks secrets in prompts", () => {
    const f = clone(orderSupportFlow);
    const answer = f.nodes.find((n) => n.id === "answer")!;
    if (answer.type === "agent") answer.config.userPrompt = "Key: {{secret.STRIPE_KEY}}";
    expect(messages(f)).toContain("Secrets cannot be used in prompts or messages");
  });

  it("requires formulas without braces", () => {
    const f = clone(orderSupportFlow);
    const route = f.nodes.find((n) => n.id === "route")!;
    if (route.type === "decision") route.config.outcomes[0]!.condition = "{{triage.output.intent}} == 'x'";
    expect(messages(f)).toContain("Formulas are written without {{ }}");
  });

  it("checks formula syntax and template blocks", () => {
    const f = clone(orderSupportFlow);
    const route = f.nodes.find((n) => n.id === "route")!;
    if (route.type === "decision") route.config.outcomes[1]!.condition = 'triage.output.intent == "refund';
    const answer = f.nodes.find((n) => n.id === "answer")!;
    if (answer.type === "agent") answer.config.systemPrompt = "{{#if user.plan}}VIP";
    const errs = messages(f);
    expect(errs).toContain("Formula error: Unterminated string");
    expect(errs).toContain("{{#if}} is missing its {{/if}}");
  });

  it("requires approval and guardrail outcomes, and treats handoff as an ending", () => {
    const flow: FlowInput = {
      schemaVersion: 1,
      id: "f",
      name: "Phase 2 nodes",
      nodes: [
        { id: "start", type: "start", label: "Start", position: { x: 0, y: 0 }, config: {} },
        { id: "check", type: "guardrail", label: "Check", position: { x: 0, y: 0 }, config: {} },
        { id: "approve", type: "approval", label: "Approve", position: { x: 0, y: 0 }, config: { message: "Refund?" } },
        { id: "ok", type: "end", label: "OK", position: { x: 0, y: 0 }, config: {} },
        { id: "human", type: "handoff", label: "Human", position: { x: 0, y: 0 }, config: {} },
      ],
      edges: [
        { id: "1", source: "start", target: "check" },
        { id: "2", source: "check", sourceHandle: "pass", target: "approve" },
        { id: "3", source: "check", sourceHandle: "fail", target: "human" },
        { id: "4", source: "approve", sourceHandle: "approved", target: "ok" },
        { id: "5", source: "approve", sourceHandle: "rejected", target: "human" },
      ],
    };
    expect(messages(flow)).toEqual(['Outcome "timeout" of "Approve" is not connected']);
    flow.edges.push({ id: "6", source: "approve", sourceHandle: "timeout", target: "human" });
    expect(validateFlow(flow).ok).toBe(true);
    flow.edges.push({ id: "7", source: "human", target: "ok" });
    expect(messages(flow)).toContain('"Human" ends the run and cannot have outgoing connections');
  });

  it("rejects a node id that is also a variable name", () => {
    const f = clone(blankFlow("f", "f"));
    f.nodes.push({
      id: "score",
      type: "assignment",
      label: "Score",
      position: { x: 0, y: 0 },
      config: { assignments: [{ variable: "score", value: "1" }] },
    });
    expect(messages(f)).toContain(
      'Node id "score" is also a variable name; rename the node so {{score}} is unambiguous',
    );
  });

  it("checks context rules on AI steps", () => {
    const f = clone(orderSupportFlow);
    const answer = f.nodes.find((n) => n.id === "answer")!;
    if (answer.type !== "agent") throw new Error("answer is an agent");
    answer.config.contextRules = `- when: user.plan == "vip"\n  include: VIP customer.`;
    expect(validateFlow(f).ok).toBe(true);

    answer.config.contextRules = `- when: user.plan == "vip"`;
    const result = validateFlow(f);
    expect(result.errors).toContainEqual({
      message: 'Context rules, line 1: Rule 1: "when" needs an "include"',
      nodeId: "answer",
      path: "config.contextRules",
    });

    answer.config.contextRules = `- include: "Key {{secret.STRIPE}}"`;
    expect(messages(f)).toContain("Secrets cannot be used in context rules");
  });

  it("warns about unreachable nodes", () => {
    const f = clone(blankFlow("f", "f"));
    f.nodes.push({ id: "orphan", type: "end", label: "Orphan", position: { x: 0, y: 0 }, config: {} });
    const result = validateFlow(f);
    expect(result.ok).toBe(true);
    expect(result.warnings.map((w) => w.message)).toContain('"Orphan" is not reachable from Start');
  });
});

describe("getNodeConfigJsonSchema", () => {
  it("produces a JSON schema for every node type", () => {
    for (const type of nodeTypes) {
      expect(getNodeConfigJsonSchema(type)).toHaveProperty("type", "object");
    }
  });
});

describe("Phase 3 rules", () => {
  it("allows a Loop body to connect back to its Loop, and nothing else", () => {
    const flow: FlowInput = {
      schemaVersion: 1,
      id: "f",
      name: "Loop",
      nodes: [
        { id: "start", type: "start", label: "Start", position: { x: 0, y: 0 }, config: {} },
        {
          id: "each",
          type: "loop",
          label: "Each order",
          position: { x: 0, y: 0 },
          config: { items: "trigger.orders" },
        },
        {
          id: "step",
          type: "assignment",
          label: "Step",
          position: { x: 0, y: 0 },
          config: { assignments: [{ variable: "n", value: "item" }] },
        },
        { id: "done", type: "end", label: "Done", position: { x: 0, y: 0 }, config: {} },
      ],
      edges: [
        { id: "1", source: "start", target: "each" },
        { id: "2", source: "each", sourceHandle: "each", target: "step" },
        { id: "3", source: "step", target: "each" },
        { id: "4", source: "each", sourceHandle: "done", target: "done" },
      ],
    };
    const ok = validateFlow(flow);
    expect(ok.errors).toEqual([]);
    expect(ok.warnings).toEqual([]);
    flow.edges[2] = { id: "3", source: "step", target: "start" };
    expect(messages(flow)).toContain("Start nodes cannot have incoming connections");
  });

  it("validates schedule triggers", () => {
    const f = clone(blankFlow("f", "f"));
    f.triggers = [{ type: "schedule", config: { cron: "0 9 * * 1-5" } }];
    expect(validateFlow(f).ok).toBe(true);
    f.triggers = [{ type: "schedule", config: { cron: "every morning" } }];
    expect(messages(f)[0]).toMatch(/^Schedule: A schedule needs 5 fields/);
  });
});

describe("cron", () => {
  it("parses and matches schedules in UTC", () => {
    const weekdays9 = parseCron("0 9 * * 1-5");
    expect(cronMatches(weekdays9, new Date("2026-11-02T09:00:30Z"))).toBe(true); // Monday
    expect(cronMatches(weekdays9, new Date("2026-11-01T09:00:00Z"))).toBe(false); // Sunday
    expect(nextCronRun(parseCron("*/15 * * * *"), new Date("2026-11-01T10:07:00Z"))?.toISOString()).toBe(
      "2026-11-01T10:15:00.000Z",
    );
    expect(() => parseCron("61 * * * *")).toThrow(/minute must be between/);
    expect(cronMatches(parseCron("0 0 * * 7"), new Date("2026-11-01T00:00:00Z"))).toBe(true); // 7 = Sunday
  });
});
