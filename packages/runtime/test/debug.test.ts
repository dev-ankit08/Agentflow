import { describe, expect, it } from "vitest";
import { Flow, type FlowInput } from "@agentflow/flow-schema";
import { LLMGateway, mockProvider } from "@agentflow/llm-gateway";
import { InProcessExecutor, MemoryRunStore, compact, diffScope, type RunEvent } from "../src";

const mockModel = { provider: "openai_compatible" as const, name: "mock-1" };
const at = { x: 0, y: 0 };
const base = { workspaceId: "ws_1", flowId: "flw_1", flowVersionId: null };

function setup() {
  const store = new MemoryRunStore();
  const gateway = new LLMGateway({
    resolveCredentials: async () => ({ apiKey: "k" }),
    providers: { openai_compatible: mockProvider },
  });
  const executor = new InProcessExecutor({
    store,
    gatewayFor: () => gateway,
    toolsFor: () => ({ describe: async () => [], call: async () => ({ data: null, text: "", isError: false }) }),
    servicesFor: () => ({}),
  });
  const events: RunEvent[] = [];
  return { store, executor, events, emit: (e: RunEvent) => events.push(e) };
}

const completed = (events: RunEvent[], nodeId: string) =>
  events.find(
    (e): e is Extract<RunEvent, { type: "step_completed" }> => e.type === "step_completed" && e.nodeId === nodeId,
  )!;

const flowInput: FlowInput = {
  schemaVersion: 1,
  id: "f",
  name: "Debug",
  variables: [{ name: "score", type: "number", default: 1 }],
  nodes: [
    { id: "start", type: "start", label: "Start", position: at, config: {} },
    {
      id: "calc",
      type: "assignment",
      label: "Score",
      position: at,
      config: { assignments: [{ variable: "score", value: "score + 41" }] },
    },
    {
      id: "bot",
      type: "agent",
      label: "Bot",
      position: at,
      config: {
        model: mockModel,
        systemPrompt: "Help {{user.email}}.",
        userPrompt: "{{trigger.message}}",
        contextRules: `- when: score > 40\n  include: High score.\n  else: Low score.`,
      },
    },
    { id: "end", type: "end", label: "End", position: at, config: {} },
  ],
  edges: [
    { id: "1", source: "start", target: "calc" },
    { id: "2", source: "calc", target: "bot" },
    { id: "3", source: "bot", target: "end" },
  ],
};

describe("step debug data", () => {
  it("records variables before each step and what the step changed", async () => {
    const t = setup();
    await t.executor.start(
      { ...base, flow: Flow.parse(flowInput), triggerType: "api", input: { message: "hi" }, user: {} },
      t.emit,
    );
    const calc = completed(t.events, "calc").debug!;
    expect(calc.before.score).toBe(1);
    expect(calc.changes).toContainEqual({ path: "score", kind: "changed", before: 1, after: 42 });
    expect(calc.changes.find((c) => c.path === "calc")).toMatchObject({ kind: "added" });
  });

  it("records the prompt parts, with the context-rule block on its own, and redacts personal data", async () => {
    const t = setup();
    const runId = await t.executor.start(
      {
        ...base,
        flow: Flow.parse(flowInput),
        triggerType: "api",
        input: { message: "hi" },
        user: { email: "ana@example.com" },
      },
      t.emit,
    );
    const prompt = completed(t.events, "bot").debug!.prompts![0]!;
    expect(prompt.context).toBe("High score.");
    expect(prompt.system).toContain("## Context\nHigh score.");
    expect(prompt.user).toBe("hi");
    expect(prompt.historyTurns).toBe(0);
    expect(JSON.stringify(completed(t.events, "bot").debug)).not.toContain("ana@example.com");
    // The same debug data is saved with the step.
    const saved = t.store.steps.find((s) => s.runId === runId && s.nodeId === "bot")!;
    expect(saved.debug?.prompts?.[0]?.context).toBe("High score.");
  });

  it("keeps the prompt when the AI step fails", async () => {
    const t = setup();
    const failing = structuredClone(flowInput);
    (failing.nodes[2] as { config: { model: unknown } }).config.model = { provider: "openai", name: "gpt" };
    await t.executor
      .start({ ...base, flow: Flow.parse(failing), triggerType: "api", input: { message: "hi" }, user: {} }, t.emit)
      .catch(() => {});
    const bot = completed(t.events, "bot");
    expect(bot.status).toBe("error");
    expect(bot.debug?.prompts?.[0]?.user).toBe("hi");
  });
});

describe("debug helpers", () => {
  it("shortens long text, big lists and deep objects", () => {
    expect(String(compact("x".repeat(2_100)))).toMatch(/… \(100 more characters\)$/);
    expect(compact(Array.from({ length: 25 }, (_, i) => i))).toHaveLength(21);
    expect(compact({ a: { b: { c: { d: { e: { f: 1 } } } } } })).toEqual({ a: { b: { c: { d: { e: "{…}" } } } } });
  });

  it("reports added, changed and removed values by path", () => {
    expect(diffScope({ a: 1, o: { x: 1, y: 2 }, gone: true }, { a: 1, o: { x: 3, y: 2 }, fresh: { big: 1 } })).toEqual([
      { path: "o.x", kind: "changed", before: 1, after: 3 },
      { path: "gone", kind: "removed", before: true },
      { path: "fresh", kind: "added", after: { big: 1 } },
    ]);
  });
});
