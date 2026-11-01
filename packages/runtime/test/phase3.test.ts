import { describe, expect, it } from "vitest";
import { Flow, type FlowInput } from "@agentflow/flow-schema";
import { LLMGateway, mockProvider } from "@agentflow/llm-gateway";
import { InProcessExecutor, MemoryRunStore, extractFacts, type RunEvent, type RuntimeServices } from "../src";

const mockModel = { provider: "openai_compatible" as const, name: "mock-1" };
const at = { x: 0, y: 0 };
const base = { workspaceId: "ws_1", flowId: "flw_1", flowVersionId: null };
const flow = (nodes: FlowInput["nodes"], edges: FlowInput["edges"]) =>
  Flow.parse({ schemaVersion: 1, id: "f", name: "Test", nodes, edges });

function setup(services: RuntimeServices = {}) {
  const store = new MemoryRunStore();
  const gateway = new LLMGateway({
    resolveCredentials: async () => ({ apiKey: "k" }),
    providers: { openai_compatible: mockProvider },
  });
  const executor = new InProcessExecutor({
    store,
    gatewayFor: () => gateway,
    toolsFor: () => ({ describe: async () => [], call: async () => ({ data: null, text: "", isError: false }) }),
    servicesFor: () => services,
  });
  const events: RunEvent[] = [];
  return { store, executor, events, emit: (e: RunEvent) => events.push(e) };
}

const ofType = <T extends RunEvent["type"]>(events: RunEvent[], type: T) =>
  events.filter((e): e is Extract<RunEvent, { type: T }> => e.type === type);
const finalMessage = (events: RunEvent[]) => ofType(events, "message").at(-1)?.content;

describe("Supervisor node", () => {
  it("delegates to a specialist and then answers", async () => {
    const t = setup();
    const f = flow(
      [
        { id: "start", type: "start", label: "Start", position: at, config: {} },
        {
          id: "boss",
          type: "supervisor",
          label: "Coordinator",
          position: at,
          config: {
            model: mockModel,
            instructions: "Help the customer.",
            workers: [
              {
                id: "billing",
                name: "Billing",
                description: "Invoices and refunds",
                systemPrompt: "You handle billing.",
              },
              { id: "tech", name: "Tech", description: "Technical issues", systemPrompt: "You fix bugs." },
            ],
          },
        },
        { id: "end", type: "end", label: "End", position: at, config: { message: "{{boss.text}}" } },
      ],
      [
        { id: "1", source: "start", target: "boss" },
        { id: "2", source: "boss", target: "end" },
      ],
    );
    const runId = await t.executor.start(
      { ...base, flow: f, triggerType: "api", input: { message: "invoice 1234 is wrong" } },
      t.emit,
    );
    const state = await t.store.load(runId);
    expect(state?.status).toBe("completed");
    const out = state!.state.nodeOutputs.boss as { path: string[]; text: string };
    expect(out.path).toEqual(["billing"]);
    expect(finalMessage(t.events)).toContain("invoice 1234 is wrong");
  });
});

describe("Loop node", () => {
  it("runs its body once per item and collects results", async () => {
    const t = setup();
    const f = flow(
      [
        { id: "start", type: "start", label: "Start", position: at, config: {} },
        {
          id: "each",
          type: "loop",
          label: "Each order",
          position: at,
          config: { items: "trigger.orders", itemVariable: "order", collect: "doubled" },
        },
        {
          id: "double",
          type: "assignment",
          label: "Double",
          position: at,
          config: { assignments: [{ variable: "doubled", value: "order * 2" }] },
        },
        { id: "end", type: "end", label: "End", position: at, config: { output: { all: "each.results" } } },
      ],
      [
        { id: "1", source: "start", target: "each" },
        { id: "2", source: "each", sourceHandle: "each", target: "double" },
        { id: "3", source: "double", target: "each" },
        { id: "4", source: "each", sourceHandle: "done", target: "end" },
      ],
    );
    const runId = await t.executor.start(
      { ...base, flow: f, triggerType: "api", input: { orders: [1, 2, 3] } },
      t.emit,
    );
    const state = await t.store.load(runId);
    expect(state?.status).toBe("completed");
    expect(state!.state.nodeOutputs.each).toMatchObject({ results: [2, 4, 6], count: 3, truncated: false });
    expect(state!.state.loops).toEqual({});
  });

  it("caps iterations and does not count the body against maxSteps", async () => {
    const t = setup();
    const f = flow(
      [
        { id: "start", type: "start", label: "Start", position: at, config: {} },
        {
          id: "each",
          type: "loop",
          label: "Each",
          position: at,
          config: { items: "trigger.items", maxIterations: 15 },
        },
        {
          id: "a",
          type: "assignment",
          label: "A",
          position: at,
          config: { assignments: [{ variable: "x", value: "item" }] },
        },
        {
          id: "b",
          type: "assignment",
          label: "B",
          position: at,
          config: { assignments: [{ variable: "y", value: "x" }] },
        },
        { id: "end", type: "end", label: "End", position: at, config: {} },
      ],
      [
        { id: "1", source: "start", target: "each" },
        { id: "2", source: "each", sourceHandle: "each", target: "a" },
        { id: "3", source: "a", target: "b" },
        { id: "4", source: "b", target: "each" },
        { id: "5", source: "each", sourceHandle: "done", target: "end" },
      ],
    );
    const items = Array.from({ length: 40 }, (_, i) => i);
    const runId = await t.executor.start({ ...base, flow: f, triggerType: "api", input: { items } }, t.emit);
    const state = await t.store.load(runId);
    expect(state?.status).toBe("completed");
    expect(state!.state.nodeOutputs.each).toMatchObject({ count: 15, truncated: true });
    expect(state!.state.variables.y).toBe(14);
  });

  it("fails clearly when the items are not a list", async () => {
    const t = setup();
    const f = flow(
      [
        { id: "start", type: "start", label: "Start", position: at, config: {} },
        { id: "each", type: "loop", label: "Each", position: at, config: { items: "trigger.message" } },
        { id: "end", type: "end", label: "End", position: at, config: {} },
      ],
      [
        { id: "1", source: "start", target: "each" },
        { id: "2", source: "each", sourceHandle: "each", target: "end" },
        { id: "3", source: "each", sourceHandle: "done", target: "end" },
      ],
    );
    const runId = await t.executor.start({ ...base, flow: f, triggerType: "chat", input: { message: "hi" } }, t.emit);
    expect((await t.store.load(runId))?.status).toBe("failed");
    expect(ofType(t.events, "error")[0]?.message).toMatch(/needs a list/);
  });
});

describe("Parallel node", () => {
  it("runs every task and returns their answers by id", async () => {
    const t = setup();
    const task = (id: string) => ({
      id,
      label: id,
      model: mockModel,
      systemPrompt: `You are ${id}.`,
      userPrompt: `${id}: {{trigger.message}}`,
    });
    const f = flow(
      [
        { id: "start", type: "start", label: "Start", position: at, config: {} },
        {
          id: "fan",
          type: "parallel",
          label: "Fan out",
          position: at,
          config: { tasks: [task("legal"), task("finance")] },
        },
        { id: "end", type: "end", label: "End", position: at, config: {} },
      ],
      [
        { id: "1", source: "start", target: "fan" },
        { id: "2", source: "fan", target: "end" },
      ],
    );
    const runId = await t.executor.start(
      { ...base, flow: f, triggerType: "chat", input: { message: "new contract" } },
      t.emit,
    );
    const out = (await t.store.load(runId))!.state.nodeOutputs.fan as Record<string, string>;
    expect(out.legal).toContain("legal: new contract");
    expect(out.finance).toContain("finance: new contract");
    expect(out.combined).toContain("## legal");
  });
});

describe("Wait node", () => {
  const waitFlow = (config: Record<string, unknown>) =>
    flow(
      [
        { id: "start", type: "start", label: "Start", position: at, config: {} },
        { id: "pause", type: "wait", label: "Wait", position: at, config } as FlowInput["nodes"][number],
        { id: "end", type: "end", label: "End", position: at, config: { message: "Done waiting" } },
      ],
      [
        { id: "1", source: "start", target: "pause" },
        { id: "2", source: "pause", target: "end" },
      ],
    );

  it("pauses until its time and resumes on demand", async () => {
    const t = setup();
    const runId = await t.executor.start(
      { ...base, flow: waitFlow({ minutes: 30 }), triggerType: "api", input: {} },
      t.emit,
    );
    const paused = await t.store.load(runId);
    expect(paused?.status).toBe("waiting_timer");
    const resumeAt = new Date(paused!.state.paused!.resumeAt!).getTime();
    expect(resumeAt - Date.now()).toBeGreaterThan(29 * 60_000);
    expect(ofType(t.events, "paused")[0]).toMatchObject({ reason: "wait" });

    await t.executor.resume(runId, {}, t.emit);
    expect((await t.store.load(runId))?.status).toBe("completed");
    expect(finalMessage(t.events)).toBe("Done waiting");
  });

  it("continues straight away when the time has passed", async () => {
    const t = setup();
    const runId = await t.executor.start(
      { ...base, flow: waitFlow({ until: '"2020-01-01T00:00:00Z"' }), triggerType: "api", input: {} },
      t.emit,
    );
    expect((await t.store.load(runId))?.status).toBe("completed");
  });
});

describe("Memory node", () => {
  function memoryStore() {
    const facts = new Map<string, string[]>();
    return {
      facts,
      read: async (user: string, query: string, topK: number) =>
        (facts.get(user) ?? [])
          .filter((f) => query.split(/\s+/).some((w) => f.toLowerCase().includes(w.toLowerCase())))
          .slice(0, topK),
      write: async (user: string, list: string[]) => void facts.set(user, [...(facts.get(user) ?? []), ...list]),
    };
  }
  const memFlow = (config: Record<string, unknown>) =>
    flow(
      [
        { id: "start", type: "start", label: "Start", position: at, config: {} },
        { id: "mem", type: "memory", label: "Memory", position: at, config } as FlowInput["nodes"][number],
        { id: "end", type: "end", label: "End", position: at, config: {} },
      ],
      [
        { id: "1", source: "start", target: "mem" },
        { id: "2", source: "mem", target: "end" },
      ],
    );

  it("writes and reads facts for the signed-in end user", async () => {
    const memory = memoryStore();
    const t = setup({ memory });
    const user = { id: "cust_9" };
    await t.executor.start(
      {
        ...base,
        flow: memFlow({ mode: "write", facts: '["Prefers email", "Lives in Pune"]' }),
        triggerType: "api",
        input: {},
        user,
      },
      t.emit,
    );
    expect(memory.facts.get("cust_9")).toEqual(["Prefers email", "Lives in Pune"]);

    const runId = await t.executor.start(
      { ...base, flow: memFlow({ mode: "read" }), triggerType: "chat", input: { message: "email me" }, user },
      t.emit,
    );
    expect((await t.store.load(runId))!.state.nodeOutputs.mem).toMatchObject({
      facts: ["Prefers email"],
      text: "- Prefers email",
    });
  });

  it("extracts facts with a model, and skips anonymous visitors", async () => {
    const memory = memoryStore();
    const t = setup({ memory });
    const runId = await t.executor.start(
      {
        ...base,
        flow: memFlow({ mode: "extract", model: mockModel }),
        triggerType: "api",
        input: { message: "hi" },
        user: { id: "cust_1" },
      },
      t.emit,
    );
    expect((await t.store.load(runId))?.status).toBe("completed");

    const anon = await t.executor.start(
      { ...base, flow: memFlow({ mode: "read" }), triggerType: "chat", input: { message: "hi" } },
      t.emit,
    );
    expect((await t.store.load(anon))!.state.nodeOutputs.mem).toMatchObject({ skipped: "No signed-in end user" });
  });
});

describe("extractFacts", () => {
  it("returns the model's facts and usage", async () => {
    const gateway = new LLMGateway({
      resolveCredentials: async () => ({ apiKey: "k" }),
      providers: {
        openai_compatible: {
          id: "openai_compatible",
          chat: async () => ({
            text: '{"facts":["Prefers email","  ","Has two dogs"]}',
            toolCalls: [],
            usage: { inputTokens: 30, outputTokens: 8 },
            stopReason: "stop",
          }),
        },
      },
    });
    const res = await extractFacts(gateway, mockModel, [
      { role: "user", content: "Email me please, I'm out walking my two dogs" },
    ]);
    expect(res).toMatchObject({ facts: ["Prefers email", "Has two dogs"], tokensIn: 30, tokensOut: 8 });
  });
});

describe("response cache", () => {
  const agentFlow = (extra: Record<string, unknown> = {}) =>
    flow(
      [
        { id: "start", type: "start", label: "Start", position: at, config: {} },
        {
          id: "bot",
          type: "agent",
          label: "Bot",
          position: at,
          config: { model: mockModel, systemPrompt: "Be brief.", userPrompt: "{{trigger.message}}", ...extra },
        } as FlowInput["nodes"][number],
        { id: "end", type: "end", label: "End", position: at, config: { message: "{{bot.text}}" } },
      ],
      [
        { id: "1", source: "start", target: "bot" },
        { id: "2", source: "bot", target: "end" },
      ],
    );
  function memoryCache() {
    const entries = new Map<string, { text: string }>();
    const key = (q: { nodeId: string; model: string; context: string; input: string }) =>
      JSON.stringify([q.nodeId, q.model, q.context, q.input.toLowerCase().trim()]);
    return {
      entries,
      lookup: async (q: Parameters<typeof key>[0]) => entries.get(key(q)) ?? null,
      store: async (q: Parameters<typeof key>[0], a: { text: string }) => void entries.set(key(q), a),
    };
  }

  it("answers a repeated question from the cache at no cost", async () => {
    const cache = memoryCache();
    const t = setup({ cache });
    const first = await t.executor.start(
      { ...base, flow: agentFlow(), triggerType: "api", input: { message: "Opening hours?" } },
      t.emit,
    );
    expect(cache.entries.size).toBe(1);
    const second = await t.executor.start(
      { ...base, flow: agentFlow(), triggerType: "api", input: { message: "opening hours? " } },
      t.emit,
    );
    const [a, b] = [await t.store.load(first), await t.store.load(second)];
    expect((b!.state.nodeOutputs.bot as { cached?: boolean }).cached).toBe(true);
    expect((b!.state.nodeOutputs.bot as { text: string }).text).toBe(
      (a!.state.nodeOutputs.bot as { text: string }).text,
    );
    const steps = t.store.steps.filter((s) => s.runId === second && s.nodeId === "bot");
    expect(steps[0]).toMatchObject({ model: "cache (openai_compatible/mock-1)", tokensIn: 0, costUsd: 0 });
  });

  it("skips agents that opt out or have tools", async () => {
    const cache = memoryCache();
    const t = setup({ cache });
    await t.executor.start(
      { ...base, flow: agentFlow({ cache: false }), triggerType: "api", input: { message: "Hi" } },
      t.emit,
    );
    await t.executor.start(
      { ...base, flow: agentFlow({ tools: ["conn/lookup"] }), triggerType: "api", input: { message: "Hi" } },
      t.emit,
    );
    expect(cache.entries.size).toBe(0);
  });
});

describe("loop state across turns", () => {
  it("starts every loop afresh on the next message, even if the last turn left it mid-way", async () => {
    const t = setup();
    const f = flow(
      [
        { id: "start", type: "start", label: "Start", position: at, config: {} },
        { id: "each", type: "loop", label: "Each", position: at, config: { items: "trigger.items" } },
        {
          id: "check",
          type: "decision",
          label: "Is it 2?",
          position: at,
          config: { outcomes: [{ id: "found", condition: "item == 2" }], defaultOutcome: "next" },
        },
        { id: "found", type: "end", label: "Found", position: at, config: { message: "found at {{item_index}}" } },
        { id: "none", type: "end", label: "None", position: at, config: { message: "not found" } },
      ],
      [
        { id: "1", source: "start", target: "each" },
        { id: "2", source: "each", sourceHandle: "each", target: "check" },
        { id: "3", source: "check", sourceHandle: "found", target: "found" },
        { id: "4", source: "check", sourceHandle: "next", target: "each" },
        { id: "5", source: "each", sourceHandle: "done", target: "none" },
      ],
    );
    const runId = await t.executor.start(
      { ...base, flow: f, triggerType: "chat", input: { message: "look", items: [1, 2, 3] } },
      t.emit,
    );
    expect(finalMessage(t.events)).toBe("found at 1");
    await t.executor.sendMessage(runId, "again", t.emit);
    // Before the fix the loop resumed at item 3 and answered "not found".
    expect(finalMessage(t.events)).toBe("found at 1");
    expect((await t.store.load(runId))!.state.loops).toEqual({ each: { items: [1, 2, 3], index: 1, results: [] } });
  });
});
