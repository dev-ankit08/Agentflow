import { describe, expect, it } from "vitest";
import { Flow, orderSupportFlow, type FlowInput } from "@agentflow/flow-schema";
import { LLMGateway, mockProvider } from "@agentflow/llm-gateway";
import { InProcessExecutor, MemoryRunStore, redactPII, type RunEvent, type ToolProvider } from "../src";

const mockModel = { provider: "openai_compatible" as const, name: "mock-1" };

/** The documented example, switched to the mock model so it runs without API keys. */
function demoFlow(): Flow {
  const f = structuredClone(orderSupportFlow);
  for (const n of f.nodes) if (n.type === "agent") n.config.model = mockModel;
  return Flow.parse(f);
}

const orders: Record<string, unknown> = { "1042": { status: "shipped", eta: "Thursday" } };

function setup(toolOverrides: Partial<ToolProvider> = {}) {
  const store = new MemoryRunStore();
  const calls: { ref: string; args: unknown }[] = [];
  const tools: ToolProvider = {
    async describe(refs) {
      return refs.map((ref) => ({
        ref,
        name: ref.split("/")[1]!,
        description: "Look up an order",
        inputSchema: { type: "object", properties: { order_id: { type: "string" } } },
      }));
    },
    async call(ref, args) {
      calls.push({ ref, args });
      const order = orders[String(args.order_id)];
      return order
        ? { data: order, text: JSON.stringify(order), isError: false }
        : { data: null, text: "not found", isError: true };
    },
    ...toolOverrides,
  };
  const gateway = new LLMGateway({
    resolveCredentials: async () => ({ apiKey: "test" }),
    providers: { openai_compatible: mockProvider },
  });
  const executor = new InProcessExecutor({ store, gatewayFor: () => gateway, toolsFor: () => tools });
  const events: RunEvent[] = [];
  const emit = (e: RunEvent) => events.push(e);
  return { store, executor, events, emit, calls };
}

const base = { workspaceId: "ws_1", flowId: "flw_1", flowVersionId: null };

describe("InProcessExecutor", () => {
  it("runs the order-support flow end to end and keeps chatting", async () => {
    const { store, executor, events, emit, calls } = setup();
    const flow = demoFlow();
    const runId = await executor.start(
      { ...base, flow, triggerType: "chat", input: { message: "Where is my order 1042?" }, user: { plan: "vip" } },
      emit,
    );

    const path = events.filter((e) => e.type === "step_started").map((e) => (e as { nodeId: string }).nodeId);
    expect(path).toEqual(["start", "triage", "route", "lookup", "answer", "done"]);
    expect(calls).toEqual([{ ref: "con_shopify/get_order", args: { order_id: "1042" } }]);
    const route = events.find((e) => e.type === "step_completed" && e.nodeId === "route");
    expect(route).toMatchObject({ handle: "status" });
    const message = events.find((e) => e.type === "message") as { content: string };
    expect(message.content).toContain("shipped");
    expect(events.at(-1)).toEqual({ type: "waiting_input" });
    expect(events.some((e) => e.type === "token" && e.nodeId === "answer")).toBe(true);
    expect(events.some((e) => e.type === "token" && e.nodeId === "triage")).toBe(false); // structured output is not streamed

    const run = await store.load(runId);
    expect(run?.status).toBe("waiting_input");
    expect(run?.state.outcome).toBe("resolved");
    expect(run?.state.nodeOutputs.triage).toMatchObject({ output: { intent: "order_status", order_id: "1042" } });
    expect(store.steps.map((s) => s.nodeId)).toEqual(path);
    expect(store.steps.find((s) => s.nodeId === "triage")).toMatchObject({
      model: "openai_compatible/mock-1",
      tokensIn: 10,
    });

    events.length = 0;
    await executor.sendMessage(runId, "I want a refund", emit);
    const path2 = events.filter((e) => e.type === "step_started").map((e) => (e as { nodeId: string }).nodeId);
    expect(path2).toEqual(["start", "triage", "route", "handoff"]);
    const after = await store.load(runId);
    expect(after?.state.outcome).toBe("escalated");
    expect(after?.state.conversation.map((t) => t.role)).toEqual(["user", "assistant", "user", "assistant"]);
  });

  it("evaluates assignments and decisions and returns End output for API runs", async () => {
    const { executor, events, emit } = setup();
    const flow: FlowInput = {
      schemaVersion: 1,
      id: "f",
      name: "Scoring",
      variables: [{ name: "score", type: "number", default: 0 }],
      nodes: [
        { id: "start", type: "start", label: "Start", position: { x: 0, y: 0 }, config: {} },
        {
          id: "calc",
          type: "assignment",
          label: "Score",
          position: { x: 0, y: 0 },
          config: {
            assignments: [
              { variable: "score", value: "trigger.amount / 10" },
              { variable: "big", value: "score > 50" },
            ],
          },
        },
        {
          id: "check",
          type: "decision",
          label: "Check",
          position: { x: 0, y: 0 },
          config: { outcomes: [{ id: "high", condition: "big" }], defaultOutcome: "low" },
        },
        {
          id: "hi",
          type: "end",
          label: "Hi",
          position: { x: 0, y: 0 },
          config: { output: { tier: '"gold"', score: "score" }, outcome: "converted" },
        },
        { id: "lo", type: "end", label: "Lo", position: { x: 0, y: 0 }, config: { output: { tier: '"basic"' } } },
      ],
      edges: [
        { id: "1", source: "start", target: "calc" },
        { id: "2", source: "calc", target: "check" },
        { id: "3", source: "check", sourceHandle: "high", target: "hi" },
        { id: "4", source: "check", sourceHandle: "low", target: "lo" },
      ],
    };
    await executor.start({ ...base, flow: Flow.parse(flow), triggerType: "api", input: { amount: 900 } }, emit);
    expect(events.at(-1)).toEqual({ type: "done", outcome: "converted", output: { tier: "gold", score: 90 } });
  });

  it("lets agents call allowed tools in a loop", async () => {
    const { executor, events, emit, calls } = setup();
    const flow = Flow.parse({
      schemaVersion: 1,
      id: "f",
      name: "Tool agent",
      nodes: [
        { id: "start", type: "start", label: "Start", position: { x: 0, y: 0 }, config: {} },
        {
          id: "helper",
          type: "agent",
          label: "Helper",
          position: { x: 0, y: 0 },
          config: {
            model: mockModel,
            systemPrompt: "Help",
            userPrompt: "{{trigger.message}}",
            tools: ["con_shop/get_order"],
          },
        },
        { id: "done", type: "end", label: "Done", position: { x: 0, y: 0 }, config: { message: "{{helper.text}}" } },
      ],
      edges: [
        { id: "1", source: "start", target: "helper" },
        { id: "2", source: "helper", target: "done" },
      ],
    });
    await executor.start({ ...base, flow, triggerType: "chat", input: { message: "status of 1042" } }, emit);
    expect(calls).toEqual([{ ref: "con_shop/get_order", args: { order_id: "1042" } }]);
    const helper = events.find((e) => e.type === "step_completed" && e.nodeId === "helper") as {
      output: { toolCalls: unknown[]; text: string };
    };
    expect(helper.output.toolCalls).toHaveLength(1);
    expect(helper.output.text).toContain("Thursday");
  });

  it("fails the run on node errors unless onError is continue", async () => {
    const flow = demoFlow();
    const failing = setup({ call: async () => ({ data: null, text: "boom", isError: true }) });
    const runId = await failing.executor.start(
      { ...base, flow, triggerType: "chat", input: { message: "order 1042" } },
      failing.emit,
    );
    expect(failing.events.at(-1)).toEqual({ type: "error", message: "Tool get_order failed: boom" });
    expect((await failing.store.load(runId))?.status).toBe("failed");
    expect(failing.store.steps.at(-1)).toMatchObject({ nodeId: "lookup", status: "error" });

    const lenient = structuredClone(flow);
    lenient.nodes.find((n) => n.id === "lookup")!.onError = "continue";
    const cont = setup({ call: async () => ({ data: null, text: "boom", isError: true }) });
    await cont.executor.start(
      { ...base, flow: lenient, triggerType: "chat", input: { message: "order 1042" } },
      cont.emit,
    );
    expect(cont.events.at(-1)).toEqual({ type: "waiting_input" });
  });

  it("times out slow nodes", async () => {
    const flow = demoFlow();
    flow.nodes.find((n) => n.id === "lookup")!.timeoutMs = 50;
    const slow = setup({
      call: () => new Promise((r) => setTimeout(() => r({ data: 1, text: "1", isError: false }), 500)),
    });
    await slow.executor.start({ ...base, flow, triggerType: "chat", input: { message: "order 1042" } }, slow.emit);
    expect(slow.events.at(-1)).toEqual({ type: "error", message: '"Get order" timed out after 0.05s' });
  });

  it("refuses messages for runs that are not waiting", async () => {
    const { executor } = setup();
    await expect(executor.sendMessage("nope", "hi", () => {})).rejects.toThrow("Run not found");
  });
});

describe("redactPII", () => {
  it("masks emails, cards, phones and IDs", () => {
    expect(redactPII("Mail jane@example.com, card 4111 1111 1111 1111, call +91 98765 43210, PAN ABCDE1234F")).toBe(
      "Mail <EMAIL>, card <CARD_OR_ACCOUNT>, call <PHONE>, PAN <PAN>",
    );
    expect(redactPII("Order 1042 is shipped")).toBe("Order 1042 is shipped");
  });
});
