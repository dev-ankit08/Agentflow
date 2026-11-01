import { describe, expect, it } from "vitest";
import { validateFlow } from "@agentflow/flow-schema";
import { LLMGateway, type ChatRequest } from "@agentflow/llm-gateway";
import { generateFlow } from "../src/generator";

const model = { provider: "openai_compatible" as const, name: "planner" };

/** A stand-in model that returns the given JSON answers in turn and records what it was asked. */
function scripted(answers: unknown[]) {
  const seen: ChatRequest[] = [];
  const gateway = new LLMGateway({
    resolveCredentials: async () => ({ apiKey: "k" }),
    providers: {
      openai_compatible: {
        id: "openai_compatible",
        chat: async (req) => {
          seen.push(req);
          return {
            text: JSON.stringify(answers[Math.min(seen.length - 1, answers.length - 1)]),
            toolCalls: [],
            usage: { inputTokens: 10, outputTokens: 10 },
            stopReason: "stop",
          };
        },
      },
    },
  });
  return { gateway, seen };
}

const triage = {
  name: "Refund triage",
  nodes: [
    { id: "start", type: "start", label: "Chat", config: {} },
    {
      id: "classify",
      type: "agent",
      label: "Classify",
      config: {
        systemPrompt: "Classify the request.",
        userPrompt: "{{trigger.message}}",
        outputSchema: { type: "object", properties: { intent: { type: "string", enum: ["refund", "other"] } } },
      },
    },
    {
      id: "route",
      type: "decision",
      label: "Route",
      config: {
        outcomes: [{ id: "refund", condition: 'classify.output.intent == "refund"' }],
        defaultOutcome: "other",
      },
    },
    { id: "refund_reply", type: "end", label: "Refund", config: { message: "We'll process your refund." } },
    { id: "other_reply", type: "end", label: "Other", config: { message: "{{classify.text}}" } },
  ],
  edges: [
    { id: "e1", source: "start", target: "classify" },
    { id: "e2", source: "classify", target: "route" },
    { id: "e3", source: "route", sourceHandle: "refund", target: "refund_reply" },
    { id: "e4", source: "route", sourceHandle: "other", target: "other_reply" },
  ],
};

describe("AI flow generator", () => {
  it("turns a valid answer into a laid-out draft using the chosen model", async () => {
    const { gateway, seen } = scripted([triage]);
    const result = await generateFlow(gateway, { description: "Triage refund requests", model, flowId: "flw_x" });
    expect(result.attempts).toBe(1);
    expect(result.issues).toEqual([]);
    expect(validateFlow(result.draft).ok).toBe(true);
    expect(result.draft).toMatchObject({ id: "flw_x", name: "Refund triage" });
    const agent = result.draft.nodes.find((n) => n.id === "classify")!;
    expect(agent.config).toMatchObject({ model });
    expect(result.draft.nodes.map((n) => n.position.x)).toEqual([0, 280, 560, 840, 840]);
    // The prompt carries the node catalogue and the example flow.
    const system = seen[0]!.messages
      .filter((m) => m.role === "system")
      .map((m) => (m as { content: string }).content)
      .join("\n");
    expect(system).toContain("decision: { outcomes");
    expect(system).toContain("Example of a valid flow");
  });

  it("sends validation errors back and uses the repaired answer", async () => {
    const broken = { ...triage, edges: triage.edges.filter((e) => e.id !== "e4") };
    const { gateway, seen } = scripted([broken, triage]);
    const result = await generateFlow(gateway, { description: "Triage refund requests", model, flowId: "flw_y" });
    expect(result.attempts).toBe(2);
    expect(result.issues).toEqual([]);
    const repairPrompt = seen[1]!.messages.at(-1) as { content: string };
    expect(repairPrompt.content).toContain('Outcome "other" of "Route" is not connected');
  });

  it("returns the last attempt with its issues when repairs run out", async () => {
    const { gateway } = scripted([{ nodes: [], edges: [] }]);
    const result = await generateFlow(
      gateway,
      { description: "Something vague", model, flowId: "flw_z", name: "Vague" },
      1,
    );
    expect(result.attempts).toBe(2);
    expect(result.draft.name).toBe("Vague");
    expect(result.draft.nodes.map((n) => n.type)).toEqual(["start"]);
    expect(result.issues.map((i) => i.message)).toContain('"Start" has no outgoing connection');
  });
});
