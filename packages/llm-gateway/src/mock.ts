import type { LLMProvider } from "./types";

/**
 * Deterministic stand-in for an LLM, used for local demos and tests without API keys.
 * Served over the OpenAI-compatible API by scripts/mock-llm.ts.
 *  - JSON requests: fills the schema, picking enum values that appear in the user's message.
 *  - Tools offered and none called yet: calls the first tool with arguments taken from the message.
 *  - Otherwise: a short reply that echoes the question and any tool result.
 */
type Msg = { role: string; content?: string | null; tool_calls?: unknown[] };
type Tool = { function: { name: string; parameters?: { properties?: Record<string, Prop>; required?: string[] } } };
type Prop = { type?: string; enum?: unknown[]; properties?: Record<string, Prop> };

export type MockReply = { content: string } | { toolCall: { name: string; arguments: Record<string, unknown> } };

const lastUser = (messages: Msg[]) => [...messages].reverse().find((m) => m.role === "user")?.content ?? "";

function fill(props: Record<string, Prop>, text: string): Record<string, unknown> {
  const lower = text.toLowerCase();
  const digits = /\d{3,}/.exec(text)?.[0];
  const out: Record<string, unknown> = {};
  for (const [key, prop] of Object.entries(props)) {
    if (prop.enum?.length) {
      const words = (v: unknown) =>
        String(v)
          .toLowerCase()
          .split(/[_\s-]+/);
      out[key] =
        prop.enum.find((v) => lower.includes(String(v).toLowerCase())) ??
        prop.enum.find((v) => words(v).some((w) => w.length > 3 && lower.includes(w))) ??
        prop.enum[prop.enum.length - 1];
    } else if (prop.type === "number" || prop.type === "integer") out[key] = prop.type === "integer" ? 1 : 0.9;
    else if (prop.type === "boolean") out[key] = true;
    else if (prop.type === "object") out[key] = fill(prop.properties ?? {}, text);
    else if (prop.type === "array") out[key] = [];
    else if (/id$|number$/i.test(key) && digits) out[key] = digits;
    else if (!/id$/i.test(key)) out[key] = text.slice(0, 80) || "mock";
  }
  return out;
}

export function mockReply(body: { messages: Msg[]; tools?: Tool[]; response_format?: unknown }): MockReply {
  const messages = body.messages ?? [];
  const user = lastUser(messages);
  const system = messages
    .filter((m) => m.role === "system")
    .map((m) => m.content ?? "")
    .join("\n");

  const schemaMatch = /matches this JSON Schema:\n(\{[\s\S]*\})/.exec(system);
  if (schemaMatch) {
    const schema = JSON.parse(schemaMatch[1]!) as { properties?: Record<string, Prop> };
    return { content: JSON.stringify(fill(schema.properties ?? {}, user)) };
  }

  const toolResults = messages.filter((m) => m.role === "tool");
  if (body.tools?.length && toolResults.length === 0) {
    const tool = body.tools[0]!.function;
    return { toolCall: { name: tool.name, arguments: fill(tool.parameters?.properties ?? {}, user) } };
  }

  const context = toolResults.map((m) => m.content).join("; ");
  return {
    content: context
      ? `Here is what I found for "${user}": ${context}`
      : `(mock model) You said: "${user}". Connect a real model in Settings for real answers.`,
  };
}

/**
 * Deterministic stand-in for an embedding model: hashed word stems in a fixed number of dimensions,
 * normalised to unit length. Texts sharing words land close together, which is enough for tests and demos.
 */
export function mockEmbedding(text: string, dims = 256): number[] {
  const v = new Array<number>(dims).fill(0);
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2)
    .map((w) => w.replace(/(ing|ed|es|s)$/, "").slice(0, 6));
  for (const w of words) {
    let h = 2166136261;
    for (let i = 0; i < w.length; i++) h = Math.imul(h ^ w.charCodeAt(i), 16777619);
    v[Math.abs(h) % dims]! += 1;
  }
  const norm = Math.hypot(...v) || 1;
  return v.map((x) => x / norm);
}

/** The mock model as an in-process provider (no HTTP), for tests. */
export const mockProvider: LLMProvider = {
  id: "openai_compatible",
  async embed(req) {
    return {
      vectors: req.input.map((t) => mockEmbedding(t)),
      usage: { inputTokens: req.input.length, outputTokens: 0 },
    };
  },
  async chat(req, _creds, onToken) {
    const reply = mockReply({
      messages: req.messages.map((m) => ({
        role: m.role,
        content: "content" in m ? m.content : null,
      })),
      tools: req.tools?.map((t) => ({
        function: { name: t.name, parameters: t.inputSchema as Tool["function"]["parameters"] },
      })),
    });
    const usage = { inputTokens: 10, outputTokens: 5 };
    if ("toolCall" in reply) {
      return { text: "", toolCalls: [{ id: "call_mock", ...reply.toolCall }], usage, stopReason: "tool_calls" };
    }
    onToken?.(reply.content);
    return { text: reply.content, toolCalls: [], usage, stopReason: "stop" };
  },
};
